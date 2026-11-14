// ============================================================
// Testes da moderação de denúncias de perfil (painel do dono)
// ============================================================

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequest } from "./admin";
import { listProfileReports, resolveProfileReport } from "./profile-moderation";

const T1 = "aaaaaaaa-e89b-42d3-a456-426614174001";
const T2 = "bbbbbbbb-e89b-42d3-a456-426614174002";
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";
const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);

interface Profile { user_id: string; display_name: string; bio: string | null; avatar_hash: string | null; banner_hash: string | null; updated_at?: string }
interface Report { id: string; reporter_id: string; target_id: string; reason: string; note: string | null; server_short_code: string; status: string; action?: string | null; resolved_at?: string | null; created_at: string }
let profiles: Profile[] = [];
let reports: Report[] = [];

function fakeSupabase() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const q = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
    if (url.pathname.endsWith("/rest/v1/profile_reports")) {
      const match = (r: Report) => (!q("id") || r.id === q("id")) && (!q("target_id") || r.target_id === q("target_id")) && (!q("status") || r.status === q("status"));
      if (method === "PATCH") { reports.filter(match).forEach((r) => Object.assign(r, JSON.parse(String(init?.body)))); return new Response(null, { status: 204 }); }
      return Response.json(reports.filter(match).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    }
    if (url.pathname.endsWith("/rest/v1/profiles")) {
      const uid = q("user_id");
      const inList = url.searchParams.get("user_id")?.startsWith("in.(") ? url.searchParams.get("user_id")!.slice(4, -1).split(",") : null;
      const match = (p: Profile) => (inList ? inList.includes(p.user_id) : !uid || p.user_id === uid);
      if (method === "PATCH") { const hit = profiles.filter(match); hit.forEach((p) => Object.assign(p, JSON.parse(String(init?.body)))); return Response.json(hit); }
      if (url.searchParams.get("or")) {
        const hash = /eq\.([a-f0-9]{32})/.exec(url.searchParams.get("or")!)?.[1];
        return Response.json(profiles.filter((p) => p.avatar_hash === hash || p.banner_hash === hash));
      }
      return Response.json(profiles.filter(match));
    }
    return new Response("[]", { status: 404 });
  }));
}

const menv = () => ({ SUPABASE_SERVICE_ROLE_KEY: "service-key", PROFILE_IMAGES: env.PROFILE_IMAGES });
const rep = (id: string, target: string, over: Partial<Report> = {}): Report => ({ id, reporter_id: "rrrrrrrr-0000-4000-8000-000000000000", target_id: target, reason: "image", note: null, server_short_code: "ABC123", status: "open", created_at: new Date(Date.now() + reports.length * 1000).toISOString(), ...over });
const exists = async (h: string) => !!(await env.PROFILE_IMAGES.get(`img/${h}`));

beforeEach(async () => {
  profiles = [
    { user_id: T1, display_name: "Alvo Um", bio: "bio do alvo", avatar_hash: HASH_A, banner_hash: HASH_B },
    { user_id: T2, display_name: "Alvo Dois", bio: null, avatar_hash: null, banner_hash: null },
  ];
  reports = [];
  reports.push(rep(R1, T1));
  reports.push(rep(R2, T1, { reason: "name_or_bio", note: "ofensivo" }));
  reports.push(rep(R3, T2, { reason: "other" }));
  await env.PROFILE_IMAGES.put(`img/${HASH_A}`, new Uint8Array([1, 2, 3]));
  await env.PROFILE_IMAGES.put(`img/${HASH_B}`, new Uint8Array([4, 5, 6]));
  fakeSupabase();
});
afterEach(() => vi.unstubAllGlobals());

describe("listProfileReports", () => {
  it("lista as abertas com o perfil como está agora, conta repetidas e nunca devolve a conta", async () => {
    const items = await listProfileReports(menv());
    expect(items.map((i) => i.id)).toEqual([R1, R2, R3]);
    expect(items[0]).toMatchObject({ openForTarget: 2, target: { displayName: "Alvo Um", bio: "bio do alvo", avatarHash: HASH_A, bannerHash: HASH_B } });
    expect(items[2]).toMatchObject({ openForTarget: 1, reason: "other" });
    const raw = JSON.stringify(items);
    for (const uid of [T1, T2]) expect(raw).not.toContain(uid);
    expect(raw).not.toContain("reporter");
  });

  it("não lista as já resolvidas e marca o perfil apagado", async () => {
    reports[2].status = "resolved";
    profiles = profiles.filter((p) => p.user_id !== T1);
    const items = await listProfileReports(menv());
    expect(items.map((i) => i.id)).toEqual([R1, R2]);
    expect(items[0].target).toBeNull();
  });
});

describe("resolveProfileReport", () => {
  it("remover imagens limpa os dois hashes, apaga os arquivos e fecha todas as denúncias da pessoa", async () => {
    const r = await resolveProfileReport(menv(), R1, "clear_images");
    expect(r).toEqual({ ok: true });
    expect(profiles[0]).toMatchObject({ avatar_hash: null, banner_hash: null, bio: "bio do alvo" });
    expect(await exists(HASH_A)).toBe(false);
    expect(await exists(HASH_B)).toBe(false);
    expect(reports.filter((x) => x.target_id === T1).every((x) => x.status === "resolved" && x.action === "clear_images")).toBe(true);
    expect(reports.find((x) => x.id === R3)?.status).toBe("open"); // outra pessoa: intacta
  });

  it("remover a bio e trocar o nome mexem só no que foi pedido", async () => {
    await resolveProfileReport(menv(), R1, "clear_bio");
    expect(profiles[0]).toMatchObject({ bio: null, display_name: "Alvo Um", avatar_hash: HASH_A });
    reports[0].status = "open"; reports[1].status = "open"; // reabre para a próxima ação
    await resolveProfileReport(menv(), R1, "rename");
    expect(profiles[0].display_name).toMatch(/^Jogador-[a-f0-9]{4}$/);
  });

  it("arquivar não muda o perfil", async () => {
    const before = JSON.stringify(profiles[0]);
    expect(await resolveProfileReport(menv(), R3, "dismiss")).toEqual({ ok: true });
    expect(JSON.stringify(profiles[0])).toBe(before);
    expect(reports.find((x) => x.id === R3)).toMatchObject({ status: "dismissed", action: "dismiss" });
  });

  it("recusa id inválido, ação inválida, denúncia que não existe e a que já foi resolvida", async () => {
    expect(await resolveProfileReport(menv(), "nao-uuid", "dismiss")).toMatchObject({ ok: false, status: 400 });
    expect(await resolveProfileReport(menv(), R1, "apagar_tudo")).toMatchObject({ ok: false, status: 400 });
    expect(await resolveProfileReport(menv(), R1, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(await resolveProfileReport(menv(), "99999999-9999-4999-8999-999999999999", "dismiss")).toMatchObject({ ok: false, status: 404 });
    reports[2].status = "resolved";
    expect(await resolveProfileReport(menv(), R3, "dismiss")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("rotas do painel (/api/v1/admin/profile-reports)", () => {
  const adminEnv = () => ({ ADMIN_TOKEN: "segredo-do-painel", SUPABASE_SERVICE_ROLE_KEY: "service-key", CUBEFORGE_REGISTRY: env.CUBEFORGE_REGISTRY, PROFILE_IMAGES: env.PROFILE_IMAGES });
  const call = (path: string, init: RequestInit = {}, token = "segredo-do-painel") =>
    handleAdminRequest(new Request(`https://api.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } }), adminEnv(), "1.2.3.4", async () => true);

  it("exige o token do painel", async () => {
    expect((await call("/api/v1/admin/profile-reports", {}, "errado"))?.status).toBe(401);
  });

  it("lista e resolve pelo painel", async () => {
    const list = await call("/api/v1/admin/profile-reports");
    expect(list?.status).toBe(200);
    expect(((await list!.json()) as any).items).toHaveLength(3);
    const done = await call(`/api/v1/admin/profile-reports/${R3}/resolve`, { method: "POST", body: JSON.stringify({ action: "dismiss" }) });
    expect(done?.status).toBe(200);
    expect(reports.find((x) => x.id === R3)?.status).toBe("dismissed");
    const again = await call(`/api/v1/admin/profile-reports/${R3}/resolve`, { method: "POST", body: JSON.stringify({ action: "dismiss" }) });
    expect(again?.status).toBe(409);
  });

  it("a página do painel libera imagens do próprio site", async () => {
    const page = await handleAdminRequest(new Request("https://api.test/admin"), adminEnv(), "1.2.3.4", async () => true);
    expect(page?.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
  });
});
