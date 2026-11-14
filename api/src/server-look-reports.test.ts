// ============================================================
// Testes da denúncia de banner de servidor e da limpeza por 90 dias sem Plus (Supabase, KV e R2 simulados)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { BANNER_REPORT_REASONS, MAX_BANNER_REPORTS_PER_DAY, handleBannerReport, listBannerReports, resolveBannerReport } from "./server-look-reports";
import { sweepStaleServerBanners } from "./server-banner-sweep";
import { EMPTY_LOOK, clearServerBanner, type ServerLook } from "./server-look";

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 14, 3, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const uid = (n: number) => `${String(n).padStart(8, "0")}-e89b-42d3-a456-426614174000`;
const H = (c: string) => c.repeat(32);
const REPORTER = uid(9);

interface Sv { uuid: string; name: string; look?: ServerLook }
let servers: Record<string, Sv> = {};
let members: { server_short_code: string; user_id: string }[] = [];
let reports: any[] = [];
let subs: { user_id: string; status: string; current_period_end: string | null }[] = [];
let streaks: { user_id: string; last_active_end: string | null }[] = [];
let deleted: string[] = [];
let failStreaks = false;
let hooks: string[] = [];

function kv() {
  return {
    get: async (k: string) => (k.startsWith("server:") && servers[k.slice(7)] ? JSON.stringify(servers[k.slice(7)]) : null),
    put: async (k: string, v: string) => { servers[k.slice(7)] = JSON.parse(v); },
    list: async () => ({ keys: Object.keys(servers).map((c) => ({ name: `server:${c}` })), list_complete: true }),
  } as unknown as KVNamespace;
}
const env = () => ({
  SUPABASE_SERVICE_ROLE_KEY: "k",
  CUBEFORGE_REGISTRY: kv(),
  PROFILE_IMAGES: { delete: async (key: string) => { deleted.push(key); } } as unknown as R2Bucket,
  ADMIN_DISCORD_WEBHOOK: "https://hook.test/x",
});

const eq = (url: URL, k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");

function fake(user: string | null = REPORTER) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "hook.test") { hooks.push(String(init?.body)); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/auth/v1/user")) return user ? Response.json({ id: user, email: "x@y.z" }) : new Response("no", { status: 401 });
    if (url.pathname.endsWith("/rest/v1/server_members")) return Response.json(members.filter((m) => m.server_short_code === eq(url, "server_short_code") && m.user_id === eq(url, "user_id")));
    if (url.pathname.endsWith("/rest/v1/server_banner_reports")) {
      if (method === "POST") { reports.push({ id: uid(100 + reports.length), status: "open", created_at: iso(NOW), ...JSON.parse(String(init!.body)) }); return new Response(null, { status: 201 }); }
      const match = (r: any) => (!eq(url, "id") || r.id === eq(url, "id")) && (!eq(url, "reporter_id") || r.reporter_id === eq(url, "reporter_id")) && (!eq(url, "server_short_code") || r.server_short_code === eq(url, "server_short_code")) && (!eq(url, "status") || r.status === eq(url, "status"));
      if (method === "PATCH") { reports.filter(match).forEach((r) => Object.assign(r, JSON.parse(String(init!.body)))); return new Response(null, { status: 204 }); }
      const list = reports.filter(match);
      return new Response(JSON.stringify(list), { headers: { "content-range": `0-0/${list.length}` } });
    }
    const ids = (url.searchParams.get("user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
    if (url.pathname.endsWith("/rest/v1/subscriptions")) return Response.json(subs.filter((s) => ids.includes(s.user_id)));
    if (url.pathname.endsWith("/rest/v1/plus_streaks")) return failStreaks ? new Response("erro", { status: 500 }) : Response.json(streaks.filter((s) => ids.includes(s.user_id)));
    return new Response("[]", { status: 404 });
  }));
}

const withBanner = (owner: string | null, at: number | null, hash = H("b")): ServerLook => ({ ...EMPTY_LOOK, bannerHash: hash, bannerOwner: owner, bannerAt: at, color: "sky" });
/** O Plus do dono do banner: a verificação real passa pelo cache da borda, que atravessaria os testes. */
let ownerPlus = true;
const plus = async () => ownerPlus;
const post = (body: unknown) => new Request("https://x.test/r", { method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify(body) });

afterEach(() => { ownerPlus = true; vi.unstubAllGlobals(); servers = {}; members = []; reports = []; subs = []; streaks = []; deleted = []; failStreaks = false; hooks = []; });

describe("handleBannerReport", () => {
  const setup = () => {
    fake();
    servers = { ABC123: { uuid: "u1", name: "Kukusen", look: withBanner(uid(1), NOW) } };
    subs = [{ user_id: uid(1), status: "active", current_period_end: null }];
    members = [{ server_short_code: "ABC123", user_id: REPORTER }];
  };

  it("grava a denúncia com o hash do banner atual e avisa no Discord", async () => {
    setup();
    const r = await handleBannerReport(post({ reason: "image", note: "  coisa   feia " }), env(), "ABC123", plus);
    expect(r.status).toBe(200);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reporter_id: REPORTER, server_short_code: "ABC123", banner_hash: H("b"), reason: "image", note: "coisa feia" });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).not.toContain(REPORTER);
  });

  it("recusa sem login, motivo inválido, servidor ou banner inexistente, e quem não é membro", async () => {
    setup();
    fake(null);
    expect((await handleBannerReport(post({ reason: "image" }), env(), "ABC123", plus)).status).toBe(401);
    fake();
    expect((await handleBannerReport(post({ reason: "nope" }), env(), "ABC123", plus)).status).toBe(400);
    expect((await handleBannerReport(post({ reason: "image" }), env(), "ZZZ999", plus)).status).toBe(404);
    servers.ABC123.look = { ...EMPTY_LOOK };
    expect((await handleBannerReport(post({ reason: "image" }), env(), "ABC123", plus)).status).toBe(404);
    servers.ABC123.look = withBanner(uid(1), NOW);
    members = [];
    expect((await handleBannerReport(post({ reason: "image" }), env(), "ABC123", plus)).status).toBe(403);
    expect(reports).toHaveLength(0);
  });

  it("não aceita denunciar banner que está escondido (o dono perdeu o Plus)", async () => {
    setup();
    ownerPlus = false;
    const r = await handleBannerReport(post({ reason: "image" }), env(), "ABC123", plus);
    expect(r.status).toBe(404);
    expect(reports).toHaveLength(0);
  });

  it("não duplica a denúncia aberta e respeita o limite por dia", async () => {
    setup();
    await handleBannerReport(post({ reason: "image" }), env(), "ABC123", plus);
    await handleBannerReport(post({ reason: "other" }), env(), "ABC123", plus);
    expect(reports).toHaveLength(1);
    reports = Array.from({ length: MAX_BANNER_REPORTS_PER_DAY }, (_, i) => ({ id: uid(200 + i), reporter_id: REPORTER, server_short_code: `S${i}`, status: "resolved", created_at: iso(Date.now()) }));
    expect((await handleBannerReport(post({ reason: "image" }), env(), "ABC123", plus)).status).toBe(429);
  });

  it("os motivos são os da lista", () => {
    expect([...BANNER_REPORT_REASONS]).toEqual(["image", "other"]);
  });
});

describe("painel: listar e decidir", () => {
  const open = (code: string, hash: string, n: number) => ({ id: uid(300 + n), reporter_id: uid(50 + n), server_short_code: code, banner_hash: hash, reason: "image", note: null, status: "open", created_at: iso(NOW + n) });

  it("lista com o nome do servidor, a contagem e se o banner denunciado ainda é o atual", async () => {
    fake();
    servers = { ABC123: { uuid: "u1", name: "Kukusen", look: withBanner(uid(1), NOW, H("b")) }, DEF456: { uuid: "u2", name: "Outro", look: withBanner(uid(2), NOW, H("c")) } };
    reports = [open("ABC123", H("b"), 1), open("ABC123", H("b"), 2), open("DEF456", H("a"), 3)];
    const items = await listBannerReports(env());
    expect(items.map((i) => [i.serverName, i.openForServer, i.current])).toEqual([["Kukusen", 2, true], ["Kukusen", 2, true], ["Outro", 1, false]]);
    expect(JSON.stringify(items)).not.toContain(uid(50));
  });

  it("remover tira o banner (R2 e registro) e fecha as denúncias do servidor", async () => {
    fake();
    servers = { ABC123: { uuid: "u1", name: "Kukusen", look: withBanner(uid(1), NOW, H("b")) } };
    reports = [open("ABC123", H("b"), 1), open("ABC123", H("b"), 2)];
    expect(await resolveBannerReport(env(), reports[0].id, "remove_banner", NOW)).toEqual({ ok: true });
    expect(servers.ABC123.look).toMatchObject({ bannerHash: null, bannerOwner: null, color: "sky" });
    expect(deleted).toEqual(["srvbanner/u1"]);
    expect(reports.every((r) => r.status === "resolved" && r.action === "remove_banner")).toBe(true);
  });

  it("se o host já trocou o banner, remover não derruba o banner novo", async () => {
    fake();
    servers = { ABC123: { uuid: "u1", name: "K", look: withBanner(uid(1), NOW, H("n")) } };
    reports = [open("ABC123", H("b"), 1)];
    expect(await resolveBannerReport(env(), reports[0].id, "remove_banner", NOW)).toEqual({ ok: true });
    expect(servers.ABC123.look?.bannerHash).toBe(H("n"));
    expect(deleted).toEqual([]);
  });

  it("arquivar não mexe no banner; ação ou id inválidos, denúncia já resolvida e inexistente são recusados", async () => {
    fake();
    servers = { ABC123: { uuid: "u1", name: "K", look: withBanner(uid(1), NOW) } };
    reports = [open("ABC123", H("b"), 1)];
    expect(await resolveBannerReport(env(), "lixo", "dismiss")).toMatchObject({ ok: false, status: 400 });
    expect(await resolveBannerReport(env(), reports[0].id, "explodir")).toMatchObject({ ok: false, status: 400 });
    expect(await resolveBannerReport(env(), uid(999), "dismiss")).toMatchObject({ ok: false, status: 404 });
    expect(await resolveBannerReport(env(), reports[0].id, "dismiss", NOW)).toEqual({ ok: true });
    expect(servers.ABC123.look?.bannerHash).toBe(H("b"));
    expect(reports[0].status).toBe("dismissed");
    expect(await resolveBannerReport(env(), reports[0].id, "dismiss")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("clearServerBanner", () => {
  it("devolve none, changed ou removed", async () => {
    servers = { A: { uuid: "u", name: "n", look: withBanner(uid(1), NOW, H("b")) }, B: { uuid: "v", name: "n" } };
    expect(await clearServerBanner(env(), "ZZ")).toBe("none");
    expect(await clearServerBanner(env(), "B")).toBe("none");
    expect(await clearServerBanner(env(), "A", H("x"))).toBe("changed");
    expect(await clearServerBanner(env(), "A", H("b"))).toBe("removed");
    expect(servers.A.look?.bannerHash).toBeNull();
  });
});

describe("sweepStaleServerBanners", () => {
  it("tira o banner de quem terminou o Plus há mais de 90 dias, e só dele", async () => {
    fake();
    servers = {
      OLD111: { uuid: "u1", name: "a", look: withBanner(uid(1), NOW - 300 * DAY) },
      NEW222: { uuid: "u2", name: "b", look: withBanner(uid(2), NOW - 300 * DAY) },
      ACT333: { uuid: "u3", name: "c", look: withBanner(uid(3), NOW - 300 * DAY) },
      NOB444: { uuid: "u4", name: "d", look: { ...EMPTY_LOOK, color: "rose" } },
    };
    subs = [
      { user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 100 * DAY) },
      { user_id: uid(2), status: "canceled", current_period_end: iso(NOW - 20 * DAY) },
      { user_id: uid(3), status: "active", current_period_end: null },
    ];
    expect(await sweepStaleServerBanners(env(), NOW)).toEqual({ checked: 3, cleared: 1 });
    expect(servers.OLD111.look?.bannerHash).toBeNull();
    expect(servers.OLD111.look?.color).toBe("sky"); // cor, etiquetas e recado ficam
    expect(servers.NEW222.look?.bannerHash).toBe(H("b"));
    expect(servers.ACT333.look?.bannerHash).toBe(H("b"));
    expect(deleted).toEqual(["srvbanner/u1"]);
  });

  it("sem dono registrado vale a data do envio; sem data, não mexe", async () => {
    fake();
    servers = {
      A: { uuid: "u1", name: "a", look: withBanner(null, NOW - 120 * DAY) },
      B: { uuid: "u2", name: "b", look: withBanner(null, NOW - 10 * DAY) },
      C: { uuid: "u3", name: "c", look: withBanner(null, null) },
    };
    expect((await sweepStaleServerBanners(env(), NOW)).cleared).toBe(1);
    expect(servers.A.look?.bannerHash).toBeNull();
    expect(servers.B.look?.bannerHash).toBe(H("b"));
    expect(servers.C.look?.bannerHash).toBe(H("b"));
  });

  it("se não conseguir ler as sequências, não apaga nada", async () => {
    fake();
    servers = { OLD111: { uuid: "u1", name: "a", look: withBanner(uid(1), NOW - 300 * DAY) } };
    subs = [{ user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 100 * DAY) }];
    failStreaks = true;
    expect((await sweepStaleServerBanners(env(), NOW)).cleared).toBe(0);
    expect(servers.OLD111.look?.bannerHash).toBe(H("b"));
    expect(deleted).toEqual([]);
  });

  it("sem a chave de serviço ou sem o bucket, não faz nada", async () => {
    fake();
    servers = { A: { uuid: "u1", name: "a", look: withBanner(uid(1), NOW - 300 * DAY) } };
    expect(await sweepStaleServerBanners({ ...env(), SUPABASE_SERVICE_ROLE_KEY: undefined } as never, NOW)).toEqual({ checked: 0, cleared: 0 });
  });
});
