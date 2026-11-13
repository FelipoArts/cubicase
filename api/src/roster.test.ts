// ============================================================
// Testes da lista de membros: perfis públicos e selo Plus em lote (Supabase simulado)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRoster } from "./roster";
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

describe("buildRoster", () => {
  it("junta perfil e Plus, em duas consultas no total, com o host primeiro", async () => {
    const urls = fakeSupabase();
    const r = await buildRoster(env, [
      member("g1", "guest", B),
      member("g2", "guest", null, true),
      member("host", "host", A),
      member("g3", "guest", C),
    ]);
    expect(r.map((m) => m.id)).toEqual(["host", "g1", "g2", "g3"]);
    expect(r[0]).toEqual({ id: "host", role: "host", self: false, profile: { displayName: "Ana", avatarId: "star", nameColor: "rose" }, plus: true });
    expect(r[1]).toMatchObject({ id: "g1", profile: { displayName: "Beto" }, plus: false }); // assinatura cancelada
    expect(r[2]).toMatchObject({ id: "g2", self: true, profile: null, plus: false }); // sem conta
    expect(r[3]).toMatchObject({ id: "g3", profile: null, plus: false }); // Plus mas sem perfil: não aparece
    expect(urls).toHaveLength(2);
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
    expect(r).toEqual([{ id: "host", role: "host", self: false, profile: null, plus: false }]);
  });

  it("Supabase fora do ar: a lista sai sem perfis em vez de falhar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("erro", { status: 500 })));
    const r = await buildRoster(env, [member("host", "host", A), member("g1", "guest", B)]);
    expect(r.map((m) => m.profile)).toEqual([null, null]);
  });
});
