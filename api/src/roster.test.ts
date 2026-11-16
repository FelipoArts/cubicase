// ============================================================
// Testes da lista de membros: perfis públicos e selo Plus em lote (Supabase simulado)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAccounts } from "./roster";
import type { RoomMember } from "./durable-objects/link-room";

const A = "aaaaaaaa-e89b-42d3-a456-426614174001"; // perfil + Plus
const B = "bbbbbbbb-e89b-42d3-a456-426614174002"; // perfil, sem Plus
const C = "cccccccc-e89b-42d3-a456-426614174003"; // só Plus, sem perfil

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-key" };

function fakeSupabase() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/rest/v1/profiles")) {
      return Response.json([
        { user_id: A, display_name: "Ana", avatar_id: "star", name_color: "rose" },
        { user_id: B, display_name: "Beto", avatar_id: "cube", name_color: null },
      ]);
    }
    if (url.includes("/rest/v1/subscriptions")) {
      return Response.json([
        { user_id: A, status: "active" },
        { user_id: B, status: "canceled" },
        { user_id: C, status: "trialing" },
      ]);
    }
    return new Response("[]", { status: 404 });
  }));
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

const member = (id: string, role: "host" | "guest", uid: string | null, self = false): RoomMember => ({ id, role, uid, self });


/** Junta os membros com as contas resolvidas (a mesma montagem que a lista de membros do app faz). */
async function buildRoster(e: { SUPABASE_SERVICE_ROLE_KEY?: string }, members: RoomMember[], nowMs = Date.now()) {
  const accounts = await resolveAccounts(e, members.flatMap((m) => (m.uid ? [m.uid] : [])), nowMs);
  const out = members.map((m) => {
    const a = m.uid ? accounts.get(m.uid) : undefined;
    return { id: m.id, role: m.role, self: m.self, profile: a?.profile ?? null, plus: a?.plus ?? false, tier: a?.tier ?? null };
  });
  return out.sort((a, b) => (a.role === b.role ? 0 : a.role === "host" ? -1 : 1));
}

describe("contas na lista", () => {
  it("junta perfil, Plus e nível, em três consultas no total (perfis, assinaturas, sequências), com o host primeiro", async () => {
    const urls = fakeSupabase();
    const r = await buildRoster(env, [
      member("g1", "guest", B),
      member("g2", "guest", null, true),
      member("host", "host", A),
      member("g3", "guest", C),
    ]);
    expect(r.map((m) => m.id)).toEqual(["host", "g1", "g2", "g3"]);
    // Plus sem registro de sequência (assinatura anterior ao badge): nível inicial.
    expect(r[0]).toEqual({ id: "host", role: "host", self: false, profile: { displayName: "Ana", avatarId: "star", nameColor: "rose", bio: null, avatarHash: null, bannerHash: null }, plus: true, tier: "wood" });
    expect(r[1]).toMatchObject({ id: "g1", profile: { displayName: "Beto" }, plus: false }); // assinatura cancelada
    expect(r[2]).toMatchObject({ id: "g2", self: true, profile: null, plus: false }); // sem conta
    expect(r[3]).toMatchObject({ id: "g3", profile: null, plus: false }); // Plus mas sem perfil: não aparece
    expect(urls).toHaveLength(3);
  });

  it("não vaza o uid e consulta cada conta uma vez só", async () => {
    const urls = fakeSupabase();
    const r = await buildRoster(env, [member("host", "host", A), member("g1", "guest", A)]);
    expect(JSON.stringify(r)).not.toContain(A);
    expect(urls[0].match(new RegExp(A, "g"))).toHaveLength(1);
  });

  it("só põe UUID de verdade na consulta", async () => {
    const urls = fakeSupabase();
    const r = await buildRoster(env, [member("g1", "guest", "x),user_id=neq.(1")]);
    expect(urls).toHaveLength(0);
    expect(r[0]).toMatchObject({ profile: null, plus: false });
  });

  it("sem a chave de serviço devolve os membros sem perfil, sem consultar nada", async () => {
    const urls = fakeSupabase();
    const r = await buildRoster({}, [member("host", "host", A)]);
    expect(urls).toHaveLength(0);
    expect(r).toEqual([{ id: "host", role: "host", self: false, profile: null, plus: false, tier: null }]);
  });

  it("Supabase fora do ar: a lista sai sem perfis em vez de falhar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("erro", { status: 500 })));
    const r = await buildRoster(env, [member("host", "host", A), member("g1", "guest", B)]);
    expect(r.map((m) => m.profile)).toEqual([null, null]);
  });
});

describe("contas na lista: nível do badge de tempo de assinatura", () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = Date.UTC(2026, 5, 1);

  /** Supabase simulado com perfis, assinaturas e a tabela plus_streaks. */
  function withStreaks(streaks: Record<string, { counted_ms: number; segment_start: number; last_active_end: number }>) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/profiles")) {
        return Response.json([A, B].map((id, i) => ({ user_id: id, display_name: `Pessoa${i}`, avatar_id: "cube", name_color: null })));
      }
      if (url.includes("/rest/v1/subscriptions")) return Response.json([{ user_id: A, status: "active" }, { user_id: B, status: "active" }]);
      if (url.includes("/rest/v1/plus_streaks")) {
        return Response.json(Object.entries(streaks).map(([id, s]) => ({
          user_id: id,
          streak_started: new Date(s.segment_start).toISOString(),
          counted_ms: s.counted_ms,
          segment_start: new Date(s.segment_start).toISOString(),
          last_active_end: new Date(s.last_active_end).toISOString(),
        })));
      }
      return new Response("[]", { status: 404 });
    }));
  }

  it("calcula o nível pelo tempo contínuo até agora", async () => {
    withStreaks({
      [A]: { counted_ms: 0, segment_start: NOW - 200 * DAY, last_active_end: NOW + 165 * DAY }, // 200 dias → Ouro
      [B]: { counted_ms: 0, segment_start: NOW - 5 * DAY, last_active_end: NOW + 25 * DAY },    // 5 dias → Madeira
    });
    const r = await buildRoster(env, [member("host", "host", A), member("g1", "guest", B)], NOW);
    expect(r.map((m) => m.tier)).toEqual(["gold", "wood"]);
  });

  it("quem não é Plus não tem nível, mesmo com sequência guardada", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/profiles")) return Response.json([{ user_id: A, display_name: "Ana", avatar_id: "cube", name_color: null }]);
      if (url.includes("/rest/v1/subscriptions")) return Response.json([{ user_id: A, status: "canceled" }]);
      if (url.includes("/rest/v1/plus_streaks")) {
        return Response.json([{ user_id: A, streak_started: new Date(NOW - 400 * DAY).toISOString(), counted_ms: 0, segment_start: new Date(NOW - 400 * DAY).toISOString(), last_active_end: new Date(NOW - 10 * DAY).toISOString() }]);
      }
      return new Response("[]", { status: 404 });
    }));
    const r = await buildRoster(env, [member("host", "host", A)], NOW);
    expect(r[0]).toMatchObject({ plus: false, tier: null });
  });

  it("o nível nunca vai além de Madeira se a sequência não está ativa de verdade", async () => {
    withStreaks({ [A]: { counted_ms: 0, segment_start: NOW - 400 * DAY, last_active_end: NOW - 2 * DAY } }); // venceu há 2 dias
    const r = await buildRoster(env, [member("host", "host", A)], NOW);
    expect(r[0]).toMatchObject({ plus: true, tier: "wood" });
  });
});

describe("muitas contas de uma vez", () => {
  it("divide a consulta em blocos: nenhuma URL leva mais de 100 contas (senão passaria do limite e tudo falharia)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return Response.json([]); }));
    const many = Array.from({ length: 250 }, (_, i) => `${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`);
    await buildRoster(env, many.map((u, i) => member(`g${i}`, "guest", u)));
    expect(urls.length).toBeGreaterThanOrEqual(9); // 3 blocos × (perfis, assinaturas, sequências)
    for (const u of urls) {
      expect((u.match(/e89b-42d3/g) ?? []).length).toBeLessThanOrEqual(100);
      expect(u.length).toBeLessThan(8000);
    }
  });
});
