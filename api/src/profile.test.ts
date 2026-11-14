// ============================================================
// Testes do perfil do jogador: validação do nome e rotas (Supabase simulado)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { BIO_MAX, handleProfileRoute, isAvatarId, isColorId, validateBio, validateDisplayName, type ProfileDeps } from "./profile";

const USER = "123e4567-e89b-42d3-a456-426614174000";

describe("validateDisplayName", () => {
  it("aceita nomes comuns e arruma os espaços", () => {
    expect(validateDisplayName("Felipo")).toEqual({ ok: true, name: "Felipo" });
    expect(validateDisplayName("  Ana   Clara ")).toEqual({ ok: true, name: "Ana Clara" });
    expect(validateDisplayName("João_99")).toEqual({ ok: true, name: "João_99" });
  });

  it("exige de 3 a 20 caracteres", () => {
    expect(validateDisplayName("ab")).toEqual({ ok: false, reason: "length" });
    expect(validateDisplayName("a".repeat(21))).toEqual({ ok: false, reason: "length" });
    expect(validateDisplayName("a".repeat(20)).ok).toBe(true);
    expect(validateDisplayName(42)).toEqual({ ok: false, reason: "length" });
    expect(validateDisplayName(undefined)).toEqual({ ok: false, reason: "length" });
  });

  it("recusa caracteres fora do permitido", () => {
    expect(validateDisplayName("<script>")).toEqual({ ok: false, reason: "chars" });
    expect(validateDisplayName("_começa")).toEqual({ ok: false, reason: "chars" });
    expect(validateDisplayName("ola*mundo")).toEqual({ ok: false, reason: "chars" });
  });

  it("recusa palavras proibidas, inclusive com acento, caixa e leet", () => {
    expect(validateDisplayName("Hitler")).toEqual({ ok: false, reason: "blocked" });
    expect(validateDisplayName("n1gger")).toEqual({ ok: false, reason: "blocked" });
    expect(validateDisplayName("Eu sou nazi")).toEqual({ ok: false, reason: "blocked" });
    expect(validateDisplayName("p.u.t.a")).toEqual({ ok: false, reason: "blocked" });
  });

  it("não barra nomes legítimos que só contêm a sequência (Scunthorpe)", () => {
    expect(validateDisplayName("computador").ok).toBe(true);
    expect(validateDisplayName("Disputa").ok).toBe(true);
    expect(validateDisplayName("Shitake").ok).toBe(true);
  });

  it("reserva nomes que se passam pelo projeto ou pela equipe", () => {
    expect(validateDisplayName("Cubicase")).toEqual({ ok: false, reason: "reserved" });
    expect(validateDisplayName("Cubicase Staff")).toEqual({ ok: false, reason: "reserved" });
    expect(validateDisplayName("c u b i c a s e")).toEqual({ ok: false, reason: "reserved" });
    expect(validateDisplayName("Suporte")).toEqual({ ok: false, reason: "reserved" });
    expect(validateDisplayName("Admin")).toEqual({ ok: false, reason: "reserved" });
  });
});

describe("validateBio", () => {
  it("vazia ou só espaços vira 'sem bio'", () => {
    expect(validateBio(null)).toEqual({ ok: true, bio: null });
    expect(validateBio(undefined)).toEqual({ ok: true, bio: null });
    expect(validateBio("   \n  ")).toEqual({ ok: true, bio: null });
  });

  it("arruma espaços e quebras de linha, mantém acentos e emojis", () => {
    expect(validateBio("  Jogo  de\n\n\n noite 🌙   e construo  ")).toEqual({ ok: true, bio: "Jogo de\nnoite 🌙 e construo" });
    expect(validateBio("a\r\nb")).toEqual({ ok: true, bio: "a\nb" });
    expect(validateBio("a\nb\nc\nd")).toEqual({ ok: false, reason: "lines" });
  });

  it(`aceita até ${BIO_MAX} caracteres e recusa mais que isso`, () => {
    expect(validateBio("a".repeat(BIO_MAX)).ok).toBe(true);
    expect(validateBio("a".repeat(BIO_MAX + 1))).toEqual({ ok: false, reason: "length" });
    expect(validateBio("🌙".repeat(BIO_MAX)).ok).toBe(true); // conta caracteres, não bytes
  });

  it("recusa links, em vários formatos", () => {
    for (const bio of ["veja https://exemplo.com", "meu site: www.exemplo", "entra em discord.gg/abc", "exemplo.com", "t.me/algo", "loja.xyz"]) {
      expect(validateBio(bio)).toEqual({ ok: false, reason: "links" });
    }
  });

  it("não barra texto comum que só parece link", () => {
    expect(validateBio("Jogo todo dia, ex.: survival e mods. Valeu!").ok).toBe(true);
    expect(validateBio("versão 1.21.4 do jogo").ok).toBe(true);
  });

  it("recusa palavras proibidas, mas não trechos dentro de outras palavras", () => {
    expect(validateBio("eu odeio todo mundo, nazi")).toEqual({ ok: false, reason: "blocked" });
    expect(validateBio("computador novo e disputa boa").ok).toBe(true);
  });

  it("recusa caracteres de controle e o que não é texto", () => {
    expect(validateBio("oi\u0007tudo")).toEqual({ ok: false, reason: "chars" });
    expect(validateBio(42)).toEqual({ ok: false, reason: "chars" });
  });
});

describe("catálogo", () => {
  it("só aceita ids conhecidos", () => {
    expect(isAvatarId("cube")).toBe(true);
    expect(isAvatarId("creeper")).toBe(false);
    expect(isAvatarId(null)).toBe(false);
    expect(isColorId("rose")).toBe(true);
    expect(isColorId("#ff0000")).toBe(false);
  });
});

// ------------------------------------------------------------
// Rotas, com Supabase simulado
// ------------------------------------------------------------

interface Call { url: string; method: string; body: string | null }

/** Simula o Supabase: valida o token em /auth/v1/user e guarda as linhas de profiles em memória. */
function fakeSupabase(opts: { loggedIn?: boolean; rows?: Record<string, unknown>[]; subscriptionStatus?: string; streak?: Record<string, unknown> } = {}) {
  const rows = opts.rows ?? [];
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    if (url.includes("/auth/v1/user")) {
      if (opts.loggedIn === false) return new Response("{}", { status: 401 });
      return Response.json({ id: USER, email: "pessoa@example.com", user_metadata: { full_name: "Pessoa Teste" } });
    }
    if (url.includes("/rest/v1/profiles")) {
      if (method === "POST") {
        const row = JSON.parse(String(init?.body));
        rows.splice(0, rows.length, row);
        return Response.json([row]);
      }
      if (method === "DELETE") { rows.splice(0, rows.length); return new Response(null, { status: 204 }); }
      return Response.json(rows);
    }
    if (url.includes("/rest/v1/subscriptions")) return Response.json(opts.subscriptionStatus ? [{ status: opts.subscriptionStatus }] : []);
    if (url.includes("/rest/v1/plus_streaks")) return Response.json(opts.streak ? [{ user_id: USER, ...opts.streak }] : []);
    return new Response("{}", { status: 404 });
  }));
  return { rows, calls };
}

const deps = (overrides: Partial<ProfileDeps> = {}): ProfileDeps => ({
  env: { SUPABASE_SERVICE_ROLE_KEY: "service-key" },
  rateLimit: async () => true,
  ...overrides,
});

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://api.test${path}`, {
    method,
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/v1/profile/me", () => {
  it("exige login", async () => {
    fakeSupabase({ loggedIn: false });
    const r = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect(r?.status).toBe(401);
  });

  it("sem perfil ainda, devolve só a sugestão de nome (nunca o e-mail)", async () => {
    fakeSupabase();
    const r = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect(r?.status).toBe(200);
    expect(r?.data).toEqual({ profile: null, suggestedName: "Pessoa Teste", plusStreak: { phase: "none", tier: null, days: 0, graceEndsAt: null } });
  });

  it("assina o Plus mas ainda sem registro de sequência: mostra o nível inicial, não esconde o badge", async () => {
    fakeSupabase({ subscriptionStatus: "active" });
    const r = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect((r?.data as any).plusStreak).toEqual({ phase: "active", tier: "wood", days: 0, graceEndsAt: null });
  });

  it("com a sequência registrada, mostra o nível de verdade e o prazo da janela de 7 dias", async () => {
    const DAY = 24 * 3600 * 1000;
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    // 200 dias contínuos, pago até daqui a 100 dias → ativo, nível Ouro
    fakeSupabase({ subscriptionStatus: "active", streak: { streak_started: iso(now - 200 * DAY), counted_ms: 0, segment_start: iso(now - 200 * DAY), last_active_end: iso(now + 100 * DAY) } });
    const active = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect((active?.data as any).plusStreak).toMatchObject({ phase: "active", tier: "gold" });
    // venceu há 2 dias e a assinatura não está ativa → janela de 7 dias, com o nível guardado
    fakeSupabase({ subscriptionStatus: "canceled", streak: { streak_started: iso(now - 200 * DAY), counted_ms: 0, segment_start: iso(now - 200 * DAY), last_active_end: iso(now - 2 * DAY) } });
    const grace = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect((grace?.data as any).plusStreak).toMatchObject({ phase: "grace", tier: "gold" });
    expect((grace?.data as any).plusStreak.graceEndsAt).toBeTruthy();
  });

  it("quem não assina e não tem sequência não recebe badge", async () => {
    fakeSupabase({ subscriptionStatus: "canceled" });
    const r = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect((r?.data as any).plusStreak.phase).toBe("none");
  });

  it("com perfil, devolve só os campos públicos", async () => {
    fakeSupabase({ rows: [{ user_id: USER, display_name: "Felipo", avatar_id: "sword", name_color: "rose" }] });
    const r = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps(), "GET", "/api/v1/profile/me");
    expect((r?.data as any).profile).toEqual({ displayName: "Felipo", avatarId: "sword", nameColor: "rose", bio: null, avatarHash: null, bannerHash: null });
    expect(JSON.stringify(r?.data)).not.toContain(USER);
  });

  it("fica de fora sem a chave de serviço configurada", async () => {
    fakeSupabase();
    const r = await handleProfileRoute(req("GET", "/api/v1/profile/me"), deps({ env: {} }), "GET", "/api/v1/profile/me");
    expect(r?.status).toBe(503);
  });
});

describe("PUT /api/v1/profile/me", () => {
  const put = (body: unknown, d = deps()) => handleProfileRoute(req("PUT", "/api/v1/profile/me", body), d, "PUT", "/api/v1/profile/me");

  it("salva um perfil válido, com a conta vinda do token (não do corpo)", async () => {
    const { calls } = fakeSupabase();
    const r = await put({ displayName: "  Felipo  ", avatarId: "flame", nameColor: "amber", userId: "outro-id" });
    expect(r?.status).toBe(200);
    expect((r?.data as any).profile).toEqual({ displayName: "Felipo", avatarId: "flame", nameColor: "amber", bio: null, avatarHash: null, bannerHash: null });
    const write = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/profiles"));
    expect(JSON.parse(write!.body!)).toMatchObject({ user_id: USER, display_name: "Felipo" });
  });

  it("salva a bio normalizada e a devolve no perfil", async () => {
    const { calls } = fakeSupabase();
    const r = await put({ displayName: "Felipo", avatarId: "cube", nameColor: null, bio: "  Construo   castelos  " });
    expect((r?.data as any).profile.bio).toBe("Construo castelos");
    const write = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/profiles"));
    expect(JSON.parse(write!.body!).bio).toBe("Construo castelos");
  });

  it("sem o campo bio no corpo, não mexe na bio que já existe", async () => {
    const { calls } = fakeSupabase();
    await put({ displayName: "Felipo", avatarId: "cube", nameColor: null });
    const write = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/profiles"));
    expect("bio" in JSON.parse(write!.body!)).toBe(false);
  });

  it("bio vazia limpa a que existia (grava null)", async () => {
    const { calls } = fakeSupabase();
    await put({ displayName: "Felipo", avatarId: "cube", nameColor: null, bio: "   " });
    const write = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/profiles"));
    expect(JSON.parse(write!.body!).bio).toBeNull();
  });

  it("recusa bio com link e não grava nada", async () => {
    const { calls } = fakeSupabase();
    const r = await put({ displayName: "Felipo", avatarId: "cube", nameColor: null, bio: "entra em https://golpe.com" });
    expect(r?.status).toBe(400);
    expect(r?.data).toMatchObject({ field: "bio", reason: "links" });
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/profiles"))).toBe(false);
  });

  it("aceita cor nula (padrão)", async () => {
    fakeSupabase();
    const r = await put({ displayName: "Felipo", avatarId: "cube", nameColor: null });
    expect(r?.status).toBe(200);
  });

  it.each([
    [{ displayName: "ab", avatarId: "cube" }, "displayName"],
    [{ displayName: "Cubicase", avatarId: "cube" }, "displayName"],
    [{ displayName: "Felipo", avatarId: "creeper" }, "avatarId"],
    [{ displayName: "Felipo", avatarId: "cube", nameColor: "#fff" }, "nameColor"],
  ])("recusa %j", async (body, field) => {
    const { calls } = fakeSupabase();
    const r = await put(body);
    expect(r?.status).toBe(400);
    expect((r?.data as any).field).toBe(field);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/profiles"))).toBe(false);
  });

  it("respeita o limite de gravações", async () => {
    fakeSupabase();
    const r = await put({ displayName: "Felipo", avatarId: "cube" }, deps({ rateLimit: async () => false }));
    expect(r?.status).toBe(429);
  });
});

describe("DELETE /api/v1/profile/me", () => {
  it("apaga o perfil da própria conta", async () => {
    const { rows, calls } = fakeSupabase({ rows: [{ user_id: USER, display_name: "Felipo", avatar_id: "cube", name_color: null }] });
    const r = await handleProfileRoute(req("DELETE", "/api/v1/profile/me"), deps(), "DELETE", "/api/v1/profile/me");
    expect(r?.status).toBe(200);
    expect(rows).toHaveLength(0);
    expect(calls.find((c) => c.method === "DELETE")!.url).toContain(`user_id=eq.${USER}`);
  });
});

describe("GET /api/v1/profile/{userId}", () => {
  const get = (id: string) => handleProfileRoute(new Request(`https://api.test/api/v1/profile/${id}`), deps(), "GET", `/api/v1/profile/${id}`);

  it("devolve o perfil público sem precisar de login", async () => {
    fakeSupabase({ rows: [{ user_id: USER, display_name: "Felipo", avatar_id: "moon", name_color: null }] });
    const r = await get(USER);
    expect(r?.status).toBe(200);
    expect((r?.data as any).profile).toEqual({ displayName: "Felipo", avatarId: "moon", nameColor: null, bio: null, avatarHash: null, bannerHash: null });
  });

  it("404 quando não existe e 400 para id mal formado", async () => {
    fakeSupabase();
    expect((await get(USER))?.status).toBe(404);
    expect((await get("nao-e-uuid"))?.status).toBe(400);
  });

  it("ignora rotas que não são do perfil", async () => {
    fakeSupabase();
    const r = await handleProfileRoute(new Request("https://api.test/api/v1/profile/x/y"), deps(), "GET", "/api/v1/profile/x/y");
    expect(r).toBeNull();
  });
});
