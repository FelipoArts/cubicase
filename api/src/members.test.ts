// ============================================================
// Testes dos membros do servidor (quem adicionou o servidor, com o online em destaque)
// ============================================================
// Roda o KV de verdade (Miniflare) e simula o Supabase em memória.
// ============================================================

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MEMBERS, MAX_REPORTS_PER_DAY, deleteServerMembers, handleMembersRoute, recordHost } from "./members";

const UID = {
  A: "aaaaaaaa-e89b-42d3-a456-426614174001", // anfitrião
  B: "bbbbbbbb-e89b-42d3-a456-426614174002", // membro com perfil e Plus
  C: "cccccccc-e89b-42d3-a456-426614174003", // membro sem perfil
  D: "dddddddd-e89b-42d3-a456-426614174004", // de fora
} as const;
const SC = "MEMB01";

interface Row { server_short_code: string; user_id: string; role: "host" | "member"; created_at: string }
let table: Row[] = [];
let clock = 0;
interface Report { reporter_id: string; target_id: string; server_short_code: string; reason: string; note: string | null; status: string; created_at: string }
let reports: Report[] = [];
const hookCalls: { url: string; body: string }[] = [];

/** Simula o Supabase: valida o token (Bearer tok-A, tok-B...) e guarda server_members em memória. */
function fakeSupabase() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.pathname.endsWith("/auth/v1/user")) {
      const key = /^Bearer tok-([A-D])$/.exec(headers.get("Authorization") ?? "")?.[1] as keyof typeof UID | undefined;
      if (!key) return new Response("{}", { status: 401 });
      return Response.json({ id: UID[key], email: `${key}@example.com`, user_metadata: {} });
    }
    if (url.pathname.endsWith("/rest/v1/server_members")) {
      const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
      const sc = eq("server_short_code");
      const matches = (r: Row) =>
        (!sc || r.server_short_code === sc) &&
        (!url.searchParams.get("user_id") || (url.searchParams.get("user_id")!.startsWith("neq.") ? r.user_id !== url.searchParams.get("user_id")!.slice(4) : r.user_id === eq("user_id"))) &&
        (!url.searchParams.get("role") || r.role === eq("role"));
      if (method === "GET") {
        const found = table.filter(matches);
        if (headers.get("Prefer")?.includes("count=exact")) {
          return new Response(JSON.stringify(found.slice(0, 1)), { status: 200, headers: { "content-range": `0-0/${found.length}` } });
        }
        return Response.json(found);
      }
      if (method === "POST") {
        const merge = headers.get("Prefer")?.includes("merge-duplicates");
        for (const r of JSON.parse(String(init?.body)) as Omit<Row, "created_at">[]) {
          const existing = table.find((x) => x.server_short_code === r.server_short_code && x.user_id === r.user_id);
          if (existing) { if (merge) existing.role = r.role; continue; }
          table.push({ ...r, created_at: new Date(1_700_000_000_000 + clock++ * 1000).toISOString() });
        }
        return new Response(null, { status: 201 });
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Partial<Row>;
        table.filter(matches).forEach((r) => Object.assign(r, patch));
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        const gone = new Set(table.filter(matches));
        table = table.filter((r) => !gone.has(r));
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname.endsWith("/rest/v1/profile_reports")) {
      const eqv = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
      if (method === "POST") {
        reports.push({ ...(JSON.parse(String(init?.body)) as Omit<Report, "status" | "created_at">), status: "open", created_at: new Date().toISOString() });
        return new Response(null, { status: 201 });
      }
      let found = reports.filter((r) => (!eqv("reporter_id") || r.reporter_id === eqv("reporter_id")) && (!eqv("target_id") || r.target_id === eqv("target_id")) && (!eqv("status") || r.status === eqv("status")));
      const gte = url.searchParams.get("created_at")?.replace(/^gte\./, "");
      if (gte) found = found.filter((r) => r.created_at >= gte);
      if (headers.get("Prefer")?.includes("count=exact")) return new Response(JSON.stringify(found.slice(0, 1)), { status: 200, headers: { "content-range": `0-0/${found.length}` } });
      return Response.json(found);
    }
    if (url.hostname === "discord.test") { hookCalls.push({ url: String(input), body: String(init?.body) }); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/rest/v1/profiles")) {
      return Response.json([
        { user_id: UID.A, display_name: "Ana", avatar_id: "star", name_color: "rose" },
        { user_id: UID.B, display_name: "Beto", avatar_id: "cube", name_color: null },
      ]);
    }
    if (url.pathname.endsWith("/rest/v1/subscriptions")) return Response.json([{ user_id: UID.B, status: "active" }]);
    return new Response("[]", { status: 404 }); // plus_streaks e o resto: sem registro
  }));
}

const deps = (online: string[] = [], anonymous = 0) => ({
  env: { SUPABASE_SERVICE_ROLE_KEY: "service-key", CUBEFORGE_REGISTRY: env.CUBEFORGE_REGISTRY, LINK_ROOM: env.LINK_ROOM },
  online: async () => ({ uids: new Set(online), anonymous }),
});
const req = (token: string | null, method = "GET", body?: unknown) =>
  new Request("https://api.test/x", {
    method,
    headers: { ...(token ? { Authorization: `Bearer tok-${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = (token: string | null, method: string, path: string, body?: unknown, d = deps()) =>
  handleMembersRoute(req(token, method, body), d, method, path);

async function makeServer(code = SC) {
  await env.CUBEFORGE_REGISTRY.put(`server:${code}`, JSON.stringify({ shortCode: code }));
}
const roles = (code = SC) => table.filter((r) => r.server_short_code === code).map((r) => `${r.user_id.slice(0, 1)}:${r.role}`).sort();

beforeEach(async () => { table = []; clock = 0; reports = []; hookCalls.length = 0; fakeSupabase(); await makeServer(); });
afterEach(() => vi.unstubAllGlobals());

describe("entrar na lista (POST /servers/{sc}/members/me)", () => {
  it("exige login e um servidor que exista", async () => {
    expect((await call(null, "POST", `/api/v1/servers/${SC}/members/me`))?.status).toBe(401);
    expect((await call("B", "POST", "/api/v1/servers/NAOEXISTE/members/me"))?.status).toBe(404);
    expect(table).toHaveLength(0);
  });

  it("registra a conta de quem pediu (vinda do token, nunca do corpo) e é idempotente", async () => {
    expect((await call("B", "POST", `/api/v1/servers/${SC}/members/me`, { userId: UID.D }))?.status).toBe(200);
    expect((await call("B", "POST", `/api/v1/servers/${SC}/members/me`))?.status).toBe(200);
    expect(roles()).toEqual(["b:member"]);
  });

  it("não rebaixa o anfitrião que também adiciona o próprio servidor", async () => {
    await recordHost(deps().env, SC, UID.A);
    await call("A", "POST", `/api/v1/servers/${SC}/members/me`);
    expect(roles()).toEqual(["a:host"]);
  });

  it("respeita o teto de membros do servidor", async () => {
    for (let i = 0; i < MAX_MEMBERS; i++) table.push({ server_short_code: SC, user_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, role: "member", created_at: new Date(i).toISOString() });
    const r = await call("B", "POST", `/api/v1/servers/${SC}/members/me`);
    expect(r?.status).toBe(409);
    expect(table.some((x) => x.user_id === UID.B)).toBe(false);
  });
});

describe("registrar vários de uma vez (PUT /memberships)", () => {
  it("só entra nos servidores que existem e ignora código inválido", async () => {
    await makeServer("OUTRO02");
    const r = await call("B", "PUT", "/api/v1/memberships", { shortCodes: [SC, "outro02", "NAOEXISTE", "x y!", 42, SC] });
    expect(r?.status).toBe(200);
    expect((r?.data as any).added).toBe(2);
    expect(table.map((x) => x.server_short_code).sort()).toEqual(["MEMB01", "OUTRO02"]);
  });

  it("recusa corpo inválido e lotes grandes demais", async () => {
    expect((await call("B", "PUT", "/api/v1/memberships", { shortCodes: "x" }))?.status).toBe(400);
    expect((await call("B", "PUT", "/api/v1/memberships", { shortCodes: Array.from({ length: 101 }, (_, i) => `COD${i}`) }))?.status).toBe(400);
    expect((await call(null, "PUT", "/api/v1/memberships", { shortCodes: [] }))?.status).toBe(401);
  });
});

describe("sair da lista (DELETE /servers/{sc}/members/me)", () => {
  it("remove só a própria linha de membro", async () => {
    await call("B", "POST", `/api/v1/servers/${SC}/members/me`);
    await call("C", "POST", `/api/v1/servers/${SC}/members/me`);
    expect((await call("B", "DELETE", `/api/v1/servers/${SC}/members/me`))?.status).toBe(200);
    expect(roles()).toEqual(["c:member"]);
  });

  it("o anfitrião não sai da lista por esta rota", async () => {
    await recordHost(deps().env, SC, UID.A);
    await call("A", "DELETE", `/api/v1/servers/${SC}/members/me`);
    expect(roles()).toEqual(["a:host"]);
  });
});

describe("anfitrião (recordHost)", () => {
  it("quem abre o servidor vira o anfitrião e o anterior volta a ser membro", async () => {
    await recordHost(deps().env, SC, UID.A);
    await recordHost(deps().env, SC, UID.B);
    expect(roles()).toEqual(["a:member", "b:host"]);
  });

  it("não faz nada sem a chave de serviço ou com id inválido", async () => {
    await recordHost({ ...deps().env, SUPABASE_SERVICE_ROLE_KEY: undefined }, SC, UID.A);
    await recordHost(deps().env, SC, "nao-e-uuid");
    expect(table).toHaveLength(0);
  });
});

describe("listar (GET /servers/{sc}/members)", () => {
  beforeEach(async () => {
    await recordHost(deps().env, SC, UID.A);
    await call("C", "POST", `/api/v1/servers/${SC}/members/me`);
    await call("B", "POST", `/api/v1/servers/${SC}/members/me`);
  });

  it("só quem é membro vê a lista", async () => {
    expect((await call("D", "GET", `/api/v1/servers/${SC}/members`))?.status).toBe(403);
    expect((await call(null, "GET", `/api/v1/servers/${SC}/members`))?.status).toBe(401);
  });

  it("anfitrião primeiro, depois quem está jogando, depois os demais; marca quem pediu", async () => {
    const r = await call("C", "GET", `/api/v1/servers/${SC}/members`, undefined, deps([UID.B]));
    const members = (r?.data as any).members as any[];
    expect(members.map((m) => [m.role, m.online])).toEqual([["host", false], ["member", true], ["member", false]]);
    expect(members[0].profile).toMatchObject({ displayName: "Ana" });
    expect(members[1]).toMatchObject({ plus: true, tier: "wood", profile: { displayName: "Beto" } }); // Plus sem registro: nível inicial
    expect(members[2]).toMatchObject({ profile: null, plus: false, tier: null }); // conta sem perfil
    expect(members.filter((m) => m.self)).toHaveLength(1);
    expect(members.find((m) => m.self)?.profile).toBeNull(); // C pediu
    expect(r?.data).toMatchObject({ total: 3, onlineCount: 1 });
  });

  it("o anfitrião online também aparece em destaque, e nunca vaza a conta de ninguém", async () => {
    const r = await call("B", "GET", `/api/v1/servers/${SC}/members`, undefined, deps([UID.A, UID.B]));
    const raw = JSON.stringify(r?.data);
    for (const uid of Object.values(UID)) expect(raw).not.toContain(uid);
    expect(raw).not.toContain("@example.com");
    const members = (r?.data as any).members as any[];
    expect(members[0]).toMatchObject({ role: "host", online: true });
    // o id é opaco e estável
    const again = await call("B", "GET", `/api/v1/servers/${SC}/members`, undefined, deps());
    expect(((again?.data as any).members as any[]).map((m) => m.id).sort()).toEqual(members.map((m) => m.id).sort());
    expect(new Set(members.map((m) => m.id)).size).toBe(3);
  });

  it("conta quem está jogando sem conta, sem listar ninguém", async () => {
    const r = await call("B", "GET", `/api/v1/servers/${SC}/members`, undefined, deps([UID.B], 3));
    expect(r?.data).toMatchObject({ total: 3, onlineCount: 1, anonymousOnline: 3 });
    expect(((r?.data as any).members as any[]).length).toBe(3); // os sem conta entram só no número
  });

  it("sem a chave de serviço configurada a rota fica de fora", async () => {
    const r = await handleMembersRoute(req("B"), { ...deps(), env: { ...deps().env, SUPABASE_SERVICE_ROLE_KEY: undefined } }, "GET", `/api/v1/servers/${SC}/members`);
    expect(r?.status).toBe(503);
  });
});

describe("denunciar o perfil de um membro (POST /servers/{sc}/members/{id}/report)", () => {
  beforeEach(async () => {
    await recordHost(deps().env, SC, UID.A);
    await call("B", "POST", `/api/v1/servers/${SC}/members/me`);
    await call("C", "POST", `/api/v1/servers/${SC}/members/me`);
  });

  /** O id opaco de um membro, como o app o recebe: pela ordem de entrada (A host, B, C). */
  async function idOf(who: "A" | "B" | "C"): Promise<string> {
    const r = await call("B", "GET", `/api/v1/servers/${SC}/members`);
    const members = (r?.data as any).members as any[];
    const host = members.find((m) => m.role === "host");
    const rest = members.filter((m) => m.role !== "host"); // B e C, na ordem de entrada
    return who === "A" ? host.id : who === "B" ? rest[0].id : rest[1].id;
  }
  const report = (token: string | null, id: string, body: unknown, d = deps()) =>
    call(token, "POST", `/api/v1/servers/${SC}/members/${id}/report`, body, d);

  it("grava a denúncia com a conta de quem denunciou (do token) e a de quem foi denunciado", async () => {
    const r = await report("B", await idOf("C"), { reason: "image", note: "  foto   imprópria " });
    expect(r?.status).toBe(200);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reporter_id: UID.B, target_id: UID.C, server_short_code: SC, reason: "image", note: "foto imprópria", status: "open" });
  });

  it("só membro denuncia, e o alvo tem de ser outro membro", async () => {
    const target = await idOf("C");
    expect((await report("D", target, { reason: "image" }))?.status).toBe(403);
    expect((await report(null, target, { reason: "image" }))?.status).toBe(401);
    expect((await report("B", "0123456789ab", { reason: "image" }))?.status).toBe(404);
    expect((await report("B", await idOf("B"), { reason: "image" }))?.status).toBe(400); // o próprio perfil
    expect(reports).toHaveLength(0);
  });

  it("recusa motivo inválido", async () => {
    const target = await idOf("C");
    expect((await report("B", target, { reason: "porque sim" }))?.status).toBe(400);
    expect((await report("B", target, {}))?.status).toBe(400);
  });

  it("não duplica uma denúncia que já está aberta", async () => {
    const target = await idOf("C");
    await report("B", target, { reason: "image" });
    expect((await report("B", target, { reason: "other" }))?.status).toBe(200);
    expect(reports).toHaveLength(1);
  });

  it("limita as denúncias por conta em 24 horas", async () => {
    const target = await idOf("C");
    for (let i = 0; i < MAX_REPORTS_PER_DAY; i++) {
      reports.push({ reporter_id: UID.B, target_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, server_short_code: SC, reason: "other", note: null, status: "resolved", created_at: new Date().toISOString() });
    }
    expect((await report("B", target, { reason: "image" }))?.status).toBe(429);
  });

  it("avisa o dono no Discord sem mandar dado pessoal", async () => {
    const target = await idOf("C");
    const withHook = { ...deps(), env: { ...deps().env, ADMIN_DISCORD_WEBHOOK: "https://discord.test/hook" } };
    await report("B", target, { reason: "name_or_bio", note: "segredo do denunciante" }, withHook);
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0].body).toContain("denúncia");
    for (const uid of Object.values(UID)) expect(hookCalls[0].body).not.toContain(uid);
    expect(hookCalls[0].body).not.toContain("segredo do denunciante");
  });
});

describe("apagar o servidor", () => {
  it("leva a lista de membros junto, só a daquele servidor", async () => {
    await makeServer("OUTRO02");
    await call("B", "POST", `/api/v1/servers/${SC}/members/me`);
    await call("B", "POST", "/api/v1/servers/OUTRO02/members/me");
    await deleteServerMembers(deps().env, SC);
    expect(table.map((r) => r.server_short_code)).toEqual(["OUTRO02"]);
  });
});

describe("rotas que não são deste módulo", () => {
  it("devolve null", async () => {
    expect(await call("B", "GET", "/api/v1/servers/MEMB01")).toBeNull();
    expect(await call("B", "PATCH", `/api/v1/servers/${SC}/members/me`)).toBeNull();
  });
});
