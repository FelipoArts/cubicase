import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { sameSecret, nextHealthState, summarizeReleases, summarizeUsers, healthCron, storeFeedback, resetOverviewCache, handleAdminRequest, type CheckResult, type HealthState } from "./admin";

const BASE = "https://example.com";
const TOKEN = "token-de-teste-do-painel-0123456789";
const T0 = "2026-10-31T10:00:00.000Z";
const T1 = "2026-10-31T10:05:00.000Z";
const T2 = "2026-10-31T10:10:00.000Z";
const T3 = "2026-10-31T10:15:00.000Z";

const res = (id: string, ok: boolean, detail = "x"): CheckResult => ({ id, label: id.toUpperCase(), ok, detail, ms: 5 });
let ipSeq = 0;
const ip = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  SELF.fetch(`${BASE}${path}`, { ...init, headers: { "CF-Connecting-IP": ip(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });

describe("sameSecret", () => {
  it("compara igual e diferente, inclusive de tamanhos diferentes", async () => {
    expect(await sameSecret("abc", "abc")).toBe(true);
    expect(await sameSecret("abc", "abd")).toBe(false);
    expect(await sameSecret("abc", "abcd")).toBe(false);
  });
});

describe("nextHealthState", () => {
  it("só declara fora do ar na segunda falha seguida e avisa uma vez", () => {
    const a = nextHealthState(null, [res("api", true)], T0);
    expect(a.alerts).toEqual([]);
    const b = nextHealthState(a.state, [res("api", false, "HTTP 500")], T1);
    expect(b.state.checks.api.ok).toBe(true);
    expect(b.state.checks.api.fails).toBe(1);
    expect(b.alerts).toEqual([]);
    const c = nextHealthState(b.state, [res("api", false, "HTTP 500")], T2);
    expect(c.state.checks.api.ok).toBe(false);
    expect(c.state.checks.api.since).toBe(T2);
    expect(c.alerts).toEqual([{ id: "api", label: "API", ok: false, detail: "HTTP 500" }]);
    const d = nextHealthState(c.state, [res("api", false, "HTTP 500")], T3);
    expect(d.alerts).toEqual([]); // continua fora do ar: sem repetir o aviso
  });

  it("avisa quando volta e uma falha isolada não vira alerta", () => {
    const down: HealthState = nextHealthState(nextHealthState(null, [res("a", true)], T0).state, [res("a", false)], T1).state;
    const downTwice = nextHealthState(down, [res("a", false)], T2).state;
    const back = nextHealthState(downTwice, [res("a", true)], T3);
    expect(back.alerts).toEqual([{ id: "a", label: "A", ok: true, detail: "x" }]);
    expect(back.state.checks.a.fails).toBe(0);
    const blip = nextHealthState(nextHealthState(back.state, [res("a", false)], "2026-10-31T10:20:00.000Z").state, [res("a", true)], "2026-10-31T10:25:00.000Z");
    expect(blip.alerts).toEqual([]);
  });

  it("serviço que já nasce fora do ar (segunda rodada) também avisa; sem mudança, não pede para gravar", () => {
    const first = nextHealthState(null, [res("a", true), res("b", true)], T0);
    const same = nextHealthState(first.state, [res("a", true), res("b", true)], T1);
    expect(same.changed).toBe(false);
    expect(same.state.updatedAt).toBe(T0);
    expect(same.state.cronAt).toBe(T1);
    const hourLater = nextHealthState(first.state, [res("a", true), res("b", true)], "2026-10-31T11:01:00.000Z");
    expect(hourLater.changed).toBe(true);
  });
});

describe("resumos", () => {
  it("summarizeReleases soma só instaladores e ignora rascunhos", () => {
    const r = summarizeReleases([
      { tag_name: "v2", draft: true, prerelease: false, published_at: null, assets: [{ name: "a.exe", download_count: 99 }] },
      { tag_name: "v1", draft: false, prerelease: false, published_at: T0, assets: [{ name: "a.exe", download_count: 3 }, { name: "a.msi", download_count: 2 }, { name: "a.exe.sig", download_count: 7 }, { name: "latest.json", download_count: 40 }] },
    ]);
    expect(r.latest).toBe("v1");
    expect(r.installers).toBe(5);
    expect(r.updateChecks).toBe(40);
  });

  it("summarizeUsers conta janelas e monta os 30 dias", () => {
    const now = Date.parse(T0);
    const s = summarizeUsers([
      { email: "a@x.com", created_at: "2026-10-31T08:00:00Z", app_metadata: { provider: "google" } },
      { email: "b@x.com", created_at: "2026-10-27T08:00:00Z" },
      { email: "c@x.com", created_at: "2026-08-01T08:00:00Z" },
    ], now);
    expect([s.total, s.last24h, s.last7d, s.last30d]).toEqual([3, 1, 2, 2]);
    expect(s.perDay).toHaveLength(30);
    expect(s.perDay.at(-1)).toEqual({ date: "2026-10-31", count: 1 });
    expect(s.recent[0].email).toBe("a@x.com");
  });
});

describe("healthCron", () => {
  const probes = (ok: boolean, sent: string[]) => ({
    fetch: (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("webhook.test")) { sent.push(u); return new Response("", { status: 204 }); }
      return ok ? new Response("{}", { status: 200 }) : new Response("", { status: 503 });
    }) as typeof fetch,
    tcp: async () => { if (!ok) throw new Error("sem resposta"); },
  });

  it("guarda o estado, avisa no Discord na segunda falha e não repete", async () => {
    const sent: string[] = [];
    const e = { ...env, ADMIN_DISCORD_WEBHOOK: "https://webhook.test/hook" };
    await env.CUBEFORGE_REGISTRY.delete("admin:health");
    await healthCron(e, probes(true, sent), T0);
    await healthCron(e, probes(false, sent), T1);
    expect(sent).toHaveLength(0);
    const down = await healthCron(e, probes(false, sent), T2);
    expect(sent).toHaveLength(1);
    expect(down.checks.supabase.ok).toBe(false);
    expect(down.checks.kv.ok).toBe(true);
    await healthCron(e, probes(false, sent), T3);
    expect(sent).toHaveLength(1);
    await healthCron(e, probes(true, sent), "2026-10-31T10:20:00.000Z");
    expect(sent).toHaveLength(2);
  });
});

describe("rotas /admin", () => {
  beforeEach(() => { resetOverviewCache(); });
  const e = { ...env, ADMIN_TOKEN: TOKEN };
  const okProbe = { fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch, tcp: async () => {} };
  const req = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    new Request(`${BASE}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const go = (r: Request, allow = true, ev = e) => handleAdminRequest(r, ev, "1.2.3.4", async () => allow, okProbe);

  it("sem ADMIN_TOKEN configurado responde 404 (a página também)", async () => {
    expect((await go(req("/api/v1/admin/health"), true, env))?.status).toBe(404);
    expect((await go(req("/admin", {}, null), true, env))?.status).toBe(404);
  });

  it("rota que não é do painel passa adiante", async () => {
    expect(await go(req("/api/v1/servers"))).toBeNull();
  });

  it("a página abre sem token e não leva nenhum dado", async () => {
    const r = (await go(req("/admin", {}, null)))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await r.text()).not.toContain(TOKEN);
  });

  it("token errado ou ausente é 401; depois de muitas tentativas, 429", async () => {
    expect((await go(req("/api/v1/admin/health", {}, "errado")))?.status).toBe(401);
    expect((await go(req("/api/v1/admin/feedback", {}, null)))?.status).toBe(401);
    expect((await go(req("/api/v1/admin/health", {}, "errado"), false))?.status).toBe(429);
  });

  it("saúde: roda as checagens sob pedido e devolve o estado", async () => {
    await env.CUBEFORGE_REGISTRY.delete("admin:health");
    const r = (await go(req("/api/v1/admin/health?refresh=1")))!;
    const body = (await r.json()) as { state: HealthState };
    expect(r.status).toBe(200);
    expect(Object.keys(body.state.checks)).toEqual(expect.arrayContaining(["kv", "supabase", "updates", "discord", "relay"]));
    expect(Object.values(body.state.checks).every((c) => c.ok)).toBe(true);
  });

  it("relatos: guarda, lista e apaga", async () => {
    const fb = { category: "bug", subject: "Não abre", message: "Clico e nada acontece aqui.", email: "a@b.com", appVersion: "0.8.1", os: "Windows 11", locale: "pt-BR" };
    await storeFeedback(e, fb, "aabbccddeeff00112233aabb", false);
    const list = (await (await go(req("/api/v1/admin/feedback")))!.json()) as { items: { id: string; emailed: boolean; subject: string }[] };
    const mine = list.items.find((i) => i.id === "aabbccddeeff00112233aabb")!;
    expect(mine.subject).toBe("Não abre");
    expect(mine.emailed).toBe(false);
    expect((await go(req("/api/v1/admin/feedback/aabbccddeeff00112233aabb", { method: "DELETE" })))?.status).toBe(200);
    const after = (await (await go(req("/api/v1/admin/feedback")))!.json()) as { items: { id: string }[] };
    expect(after.items.find((i) => i.id === "aabbccddeeff00112233aabb")).toBeUndefined();
  });

  it("o envio da Central de Ajuda guarda o relato mesmo quando o e-mail não está configurado", async () => {
    const r = await call("/api/v1/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "problem", subject: "Teste do painel", message: "Mensagem de teste para o painel do dono.", email: "t@exemplo.com" }) }, null);
    expect(r.status).toBe(503);
    const list = (await (await go(req("/api/v1/admin/feedback")))!.json()) as { items: { subject: string; emailed: boolean }[] };
    const mine = list.items.find((i) => i.subject === "Teste do painel");
    expect(mine?.emailed).toBe(false);
  });
});
