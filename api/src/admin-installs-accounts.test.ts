import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { recordInstallPing, summarizeInstalls, listInstalls, INSTALL_PREFIX, type InstallMeta } from "./installs";
import { recordAudit, listAudit } from "./admin-audit";
import { resetOverviewCache, handleAdminRequest } from "./admin";

const BASE = "https://example.com";
const TOKEN = "token-de-teste-do-painel-0123456789";
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const DAY = 24 * 3600_000;
const ID = "0123456789abcdef0123456789abcdef";
let ipSeq = 0;
const ip = () => `10.88.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function clearPrefix(prefix: string) {
  const l = await env.CUBEFORGE_REGISTRY.list({ prefix });
  for (const k of l.keys) await env.CUBEFORGE_REGISTRY.delete(k.name);
}

describe("ping de instalação", () => {
  beforeEach(async () => { await clearPrefix(INSTALL_PREFIX); });

  it("recusa id, versão ou corpo inválidos", async () => {
    expect((await recordInstallPing(env, null, T0)).ok).toBe(false);
    expect((await recordInstallPing(env, { id: "x", v: "1.0.0" }, T0)).ok).toBe(false);
    expect((await recordInstallPing(env, { id: ID, v: "<script>" }, T0)).ok).toBe(false);
    expect((await listInstalls(env.CUBEFORGE_REGISTRY)).length).toBe(0);
  });

  it("grava uma vez, não regrava no mesmo dia e atualiza quando a versão muda", async () => {
    expect(await recordInstallPing(env, { id: ID, v: "0.8.4", os: "windows" }, T0)).toEqual({ ok: true, written: true });
    expect(await recordInstallPing(env, { id: ID, v: "0.8.4", os: "windows" }, T0 + 3600_000)).toEqual({ ok: true, written: false });
    expect(await recordInstallPing(env, { id: ID, v: "0.8.5", os: "windows" }, T0 + 3600_000)).toEqual({ ok: true, written: true });
    const all = await listInstalls(env.CUBEFORGE_REGISTRY);
    expect(all).toHaveLength(1);
    expect(all[0].v).toBe("0.8.5");
    expect(all[0].f).toBe(new Date(T0).toISOString()); // a primeira aparição não muda
    await recordInstallPing(env, { id: ID, v: "0.8.5", os: "windows" }, T0 + 2 * DAY);
    expect((await listInstalls(env.CUBEFORGE_REGISTRY))[0].l).toBe(new Date(T0 + 2 * DAY).toISOString());
  });

  it("o formato com e sem hífens é a mesma instalação e o sistema desconhecido vira 'other'", async () => {
    await recordInstallPing(env, { id: "01234567-89ab-cdef-0123-456789abcdef", v: "1.0.0", os: "amiga" }, T0);
    await recordInstallPing(env, { id: ID, v: "1.0.0", os: "amiga" }, T0);
    const all = await listInstalls(env.CUBEFORGE_REGISTRY);
    expect(all).toHaveLength(1);
    expect(all[0].o).toBe("other");
  });

  it("a rota pública responde 200 e 400", async () => {
    const post = (body: unknown) => SELF.fetch(`${BASE}/api/v1/installs/ping`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify(body) });
    expect((await post({ id: ID, v: "0.8.4", os: "windows" })).status).toBe(200);
    expect((await post({ id: "nope", v: "0.8.4" })).status).toBe(400);
  });
});

describe("marcos e falhas no ping", () => {
  beforeEach(async () => { await clearPrefix(INSTALL_PREFIX); });
  it("junta os bits (nunca perde um), ignora lixo e regrava quando aparece um marco novo no mesmo dia", async () => {
    await recordInstallPing(env, { id: ID, v: "0.8.4", os: "windows", s: 3, e: 0 }, T0);
    expect(await recordInstallPing(env, { id: ID, v: "0.8.4", os: "windows", s: 3, e: 0 }, T0 + 60_000)).toEqual({ ok: true, written: false });
    expect(await recordInstallPing(env, { id: ID, v: "0.8.4", os: "windows", s: 4, e: 2 }, T0 + 120_000)).toEqual({ ok: true, written: true });
    await recordInstallPing(env, { id: ID, v: "0.8.4", os: "windows", s: "x", e: -5 }, T0 + 130_000);
    const [m] = await listInstalls(env.CUBEFORGE_REGISTRY);
    expect([m.s, m.e]).toEqual([7, 2]);
  });
});

describe("funil, retenção, sumiram e falhas", () => {
  const m = (f: number, l: number, v: string, s = 0, e = 0): InstallMeta => ({ f: new Date(f).toISOString(), l: new Date(l).toISOString(), v, o: "windows", s, e });
  it("calcula cada bloco", () => {
    const items = [
      m(T0 - 30 * DAY, T0 - 1000, "0.8.4", 1 | 2 | 4 | 8 | 16),         // ativa, foi até o fim
      m(T0 - 30 * DAY, T0 - 29 * DAY, "0.8.4", 1 | 2, 2),               // sumiu: parou em "Criou servidor", com falha
      m(T0 - 30 * DAY, T0 - 30 * DAY + 3600_000, "0.8.3", 0),           // sumiu: só abriu
      m(T0 - 1 * DAY, T0 - 1000, "0.8.4", 1),                           // nova
    ];
    const s = summarizeInstalls(items, T0);
    expect(s.funnel.map((x) => x.count)).toEqual([4, 3, 2, 0, 1, 1, 1]);
    expect(s.guestFunnel.map((x) => x.count)).toEqual([4, 0, 0]);
    expect(s.gone.total).toBe(2);
    expect(s.gone.byStage.map((x) => x.label).sort()).toEqual(["Criou/instalou um servidor", "Só abriu o app"]);
    expect(s.errors.find((x) => x.key === "server_start_failed")).toMatchObject({ installs: 1, gone: 1 });
    const old = s.retention.find((r) => r.size === 3)!;
    expect([old.d1, old.d7, old.d14]).toEqual([2, 1, 1]); // 1 dia: duas voltaram; 7 e 14 dias: só a ativa
    expect(s.retention.find((r) => r.size === 1)!.d7).toBeNull(); // coorte nova demais para medir 7 dias
  });
});

describe("funil de quem só joga", () => {
  const m = (s: number): InstallMeta => ({ f: new Date(T0 - 5 * DAY).toISOString(), l: new Date(T0 - 1000).toISOString(), v: "0.8.11", o: "windows", s });
  it("conta quem adicionou e quem entrou no servidor de um amigo, separado do funil de quem hospeda", () => {
    const s = summarizeInstalls([m(64 | 128), m(64), m(0), m(2 | 32)], T0);
    expect(s.guestFunnel.map((x) => [x.key, x.count])).toEqual([["installed", 4], ["guest_added", 2], ["guest_connected", 1]]);
    expect(s.funnel.map((x) => [x.key, x.count])).toEqual([["installed", 4], ["account", 0], ["server_installed", 1], ["start_attempted", 1], ["server_started", 0], ["invited", 0], ["player_joined", 0]]);
  });
  it("aceita os bits novos no ping (até 255) e continua ignorando o que passa disso", async () => {
    await clearPrefix(INSTALL_PREFIX);
    await recordInstallPing(env, { id: ID, v: "0.8.11", os: "windows", s: 255, e: 0 }, T0);
    await recordInstallPing(env, { id: ID, v: "0.8.11", os: "windows", s: 256, e: 0 }, T0 + 130_000);
    const [row] = await listInstalls(env.CUBEFORGE_REGISTRY);
    expect(row.s).toBe(255);
  });
});

describe("summarizeInstalls", () => {
  const m = (f: number, l: number, v: string, o = "windows"): InstallMeta => ({ f: new Date(f).toISOString(), l: new Date(l).toISOString(), v, o });
  it("conta janelas, versões (mais nova primeiro) e novas por dia", () => {
    const s = summarizeInstalls([
      m(T0 - 100 * DAY, T0 - 3600_000, "0.8.4"),
      m(T0 - 2 * DAY, T0 - 2 * DAY, "0.8.10"),
      m(T0 - 3 * DAY, T0 - 20 * DAY, "0.8.9", "linux"),
      m(T0 - 200 * DAY, T0 - 90 * DAY, "0.7.0"),
    ], T0);
    expect([s.total, s.active24h, s.active7d, s.active30d]).toEqual([4, 1, 2, 3]);
    expect(s.versions.map((x) => x.version)).toEqual(["0.8.10", "0.8.9", "0.8.4"]);
    expect(s.newPerDay).toHaveLength(30);
    expect(s.newPerDay.reduce((a, b) => a + b.count, 0)).toBe(2);
    expect(s.nearKvWriteLimit).toBe(false);
  });
});

describe("registro de ações", () => {
  beforeEach(async () => { await clearPrefix("audit:"); });
  it("lista da mais nova para a mais antiga e limpa caracteres de controle", async () => {
    await recordAudit(env, { action: "grant_plus", target: "u1", label: "a@x.com" }, T0);
    await recordAudit(env, { action: "rename", target: "u2", label: "b@x.com\nfalso", detail: "antes: Fulano" }, T0 + 1000);
    const items = await listAudit(env);
    expect(items.map((i) => i.action)).toEqual(["rename", "grant_plus"]);
    expect(items[0].label).not.toContain("\n");
  });
});

describe("rotas de contas do admin", () => {
  const e = { ...env, ADMIN_TOKEN: TOKEN };
  const probe = { fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch, tcp: async () => {} };
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    handleAdminRequest(new Request(`${BASE}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } }), e, "1.2.3.4", async () => true, probe) as Promise<Response>;
  beforeEach(() => resetOverviewCache());

  it("exigem o token", async () => {
    expect((await call("/api/v1/admin/accounts?q=ab", {}, null)).status).toBe(401);
    expect((await call("/api/v1/admin/audit", {}, null)).status).toBe(401);
    expect((await call("/api/v1/admin/accounts/00000000-0000-4000-8000-000000000000/action", { method: "POST", body: "{}" }, null)).status).toBe(401);
  });

  it("recusam ação inválida", async () => {
    const r = await call("/api/v1/admin/accounts/00000000-0000-4000-8000-000000000000/action", { method: "POST", body: JSON.stringify({ action: "apagar_tudo" }) });
    expect(r.status).toBe(400);
  });

  it("a auditoria lista o que foi registrado", async () => {
    await clearPrefix("audit:");
    await recordAudit(env, { action: "grant_plus", target: "u1", label: "a@x.com" }, T0);
    const r = await call("/api/v1/admin/audit");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).items[0].action).toBe("grant_plus");
  });
});
