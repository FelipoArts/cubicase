// ============================================================
// Testes do convite por e-mail ao painel: mensagem para o host e envio do e-mail (Supabase e Resend simulados)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePanelAccessRoute, type PanelDeps } from "./panel-members";

const ME = "aaaaaaaa-e89b-42d3-a456-426614174001";
const TARGET = "bbbbbbbb-e89b-42d3-a456-426614174002";
const DEVICE = "cccccccc-e89b-42d3-a456-426614174003";

let emails: any[] = [];
let resendStatus = 200;
let knownEmail = "ana@exemplo.com";

function fake() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "api.resend.com") { emails.push(JSON.parse(String(init!.body))); return new Response("{}", { status: resendStatus }); }
    if (url.pathname.endsWith("/auth/v1/user")) return Response.json({ id: ME, email: "eu@teste.dev", user_metadata: {} });
    if (url.pathname.endsWith("/rest/v1/subscriptions")) return Response.json([{ status: "active" }]);
    if (url.pathname.endsWith("/rest/v1/panel_devices")) return Response.json([{ id: DEVICE, user_id: ME, device_name: "FELIPOSYSTEM", last_seen_at: null }]);
    if (url.pathname.endsWith("/rest/v1/panel_device_members")) return Response.json([]);
    if (url.pathname.endsWith("/rest/v1/rpc/panel_find_user_by_email")) return Response.json(JSON.parse(String(init!.body)).p_email === knownEmail ? TARGET : null);
    if (url.pathname.endsWith("/rest/v1/rpc/panel_user_info")) return Response.json([{ id: ME, email: "eu@teste.dev", name: "Felipo" }]);
    if (url.pathname.endsWith("/rest/v1/panel_device_invites")) {
      if (method === "POST") return Response.json([{ id: "inv1", device_id: DEVICE, kind: "email" }]);
      return Response.json([]);
    }
    return new Response("[]", { status: 404 });
  }));
}

const deps = (extra: object = {}): PanelDeps => ({ env: { SUPABASE_SERVICE_ROLE_KEY: "k", HOST_CHANNEL: {} as never, ...extra }, rateLimit: async () => true });
const invite = (d: PanelDeps, email = "ana@exemplo.com") => {
  const path = `/api/v1/panel/devices/${DEVICE}/invites`;
  const body = { kind: "email", email, permissions: { viewConsole: true, start: false, stop: false, restart: false, commands: { mode: "none", allowlist: [] } } };
  const req = new Request("https://x.test" + path, { method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify(body) });
  return handlePanelAccessRoute(req, d, "POST", path, new URL(req.url));
};

afterEach(() => { vi.unstubAllGlobals(); emails = []; resendStatus = 200; });

describe("convite por e-mail", () => {
  it("sem remetente configurado: o convite é criado e o host é avisado para avisar a pessoa (nada é enviado)", async () => {
    fake();
    const r = await invite(deps({ RESEND_API_KEY: "k" }));
    expect(r).toMatchObject({ status: 200, data: { id: "inv1", emailed: false } });
    expect(r!.message).toContain("Avise a pessoa");
    expect(emails).toHaveLength(0);
  });

  it("com remetente configurado: manda o e-mail para a conta convidada e avisa o host", async () => {
    fake();
    const r = await invite(deps({ RESEND_API_KEY: "k", INVITE_FROM_EMAIL: "Cubicase <convites@cubicase.net>" }));
    expect(r).toMatchObject({ status: 200, data: { emailed: true } });
    expect(r!.message).toContain("e-mail enviado");
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["ana@exemplo.com"]);
    expect(emails[0].text).toContain("FELIPOSYSTEM");
    expect(emails[0].text).toContain("Felipo");
  });

  it("se o Resend recusa, o convite continua criado e a mensagem diz que o e-mail não saiu", async () => {
    fake();
    resendStatus = 403;
    const r = await invite(deps({ RESEND_API_KEY: "k", INVITE_FROM_EMAIL: "Cubicase <convites@cubicase.net>" }));
    expect(r).toMatchObject({ status: 200, data: { id: "inv1", emailed: false } });
    expect(r!.message).toContain("não saiu");
  });

  it("e-mail sem conta no Cubicase: 404 e nenhum e-mail enviado (não serve para mandar spam)", async () => {
    fake();
    const r = await invite(deps({ RESEND_API_KEY: "k", INVITE_FROM_EMAIL: "Cubicase <convites@cubicase.net>" }), "desconhecido@exemplo.com");
    expect(r?.status).toBe(404);
    expect(emails).toHaveLength(0);
  });
});
