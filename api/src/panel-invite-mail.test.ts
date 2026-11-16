// ============================================================
// Testes do e-mail do convite de acesso ao painel
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { PANEL_URL, buildInviteEmail, inviteMailConfigured, sendInviteEmail } from "./panel-invite-mail";

const params = { to: "ana@exemplo.com", owner: "Felipo", device: "FELIPOSYSTEM", days: 14 };
const env = { RESEND_API_KEY: "re_key", INVITE_FROM_EMAIL: "Cubicase <convites@cubicase.net>" };

describe("buildInviteEmail", () => {
  it("diz quem convidou, o computador, o endereço do painel e a validade, em português e inglês", () => {
    const m = buildInviteEmail(params);
    expect(m.subject).toContain("Felipo");
    expect(m.text).toContain('"FELIPOSYSTEM"');
    expect(m.text).toContain(PANEL_URL);
    expect(m.text).toContain("ana@exemplo.com");
    expect(m.text).toContain("14 dias");
    expect(m.text).toContain("14 days");
    expect(m.text).toContain("Cubicase Plus");
    expect(m.text).toContain("não precisa responder");
    expect(m.text).toContain("no need to reply");
  });

  it("nada que venha de fora quebra linha no assunto nem injeta linhas no texto", () => {
    const m = buildInviteEmail({ ...params, owner: "Mal\r\nBcc: x@y.z", device: "PC\nSubject: oi" });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text.split("\n").some((l) => l.startsWith("Bcc:") || l.startsWith("Subject:"))).toBe(false);
  });

  it("corta nomes enormes", () => {
    expect(buildInviteEmail({ ...params, owner: "x".repeat(500) }).subject.length).toBeLessThan(200);
  });
});

describe("sendInviteEmail", () => {
  it("sem remetente próprio configurado nem tenta (o remetente de teste do Resend só entrega ao dono da conta)", async () => {
    const f = vi.fn();
    expect(inviteMailConfigured({ RESEND_API_KEY: "k" })).toBe(false);
    expect(await sendInviteEmail({ RESEND_API_KEY: "k" }, params, f as never)).toBe(false);
    expect(await sendInviteEmail({ INVITE_FROM_EMAIL: "a@b.c" }, params, f as never)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("manda para o destinatário com o remetente configurado e devolve true quando o Resend aceita", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await sendInviteEmail(env, params, f as never)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: env.INVITE_FROM_EMAIL, to: ["ana@exemplo.com"] });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
  });

  it("erro do Resend ou de rede vira false, sem lançar", async () => {
    expect(await sendInviteEmail(env, params, (async () => new Response("no", { status: 403 })) as never)).toBe(false);
    expect(await sendInviteEmail(env, params, (async () => { throw new Error("rede"); }) as never)).toBe(false);
  });
});
