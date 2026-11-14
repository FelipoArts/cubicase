// ============================================================
// Testes da limpeza de imagens de contas sem Plus (Supabase e R2 simulados)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_GRACE_DAYS, isSweepTime, sweepStaleImages } from "./profile-images-sweep";

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 14, 3, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const uid = (n: number) => `${String(n).padStart(8, "0")}-e89b-42d3-a456-426614174000`;
const H = (c: string) => c.repeat(32);

interface P { user_id: string; avatar_hash: string | null; banner_hash: string | null; images_updated_at: string | null }
let profiles: P[] = [];
let subs: { user_id: string; status: string; current_period_end: string | null }[] = [];
let streaks: { user_id: string; last_active_end: string | null }[] = [];
let deleted: string[] = [];
let failList: string | null = null;

function fake() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (failList && url.pathname.endsWith(failList)) return new Response("erro", { status: 500 });
    if (url.pathname.endsWith("/rest/v1/profiles")) {
      if (method === "PATCH") {
        const id = url.searchParams.get("user_id")!.replace("eq.", "");
        profiles.filter((p) => p.user_id === id).forEach((p) => Object.assign(p, JSON.parse(String(init!.body))));
        return new Response(null, { status: 204 });
      }
      const or = url.searchParams.get("or") ?? "";
      const hash = /eq\.([a-f0-9]{32})/.exec(or)?.[1];
      if (hash) return Response.json(profiles.filter((p) => p.avatar_hash === hash || p.banner_hash === hash).slice(0, 1));
      const off = Number(url.searchParams.get("offset") ?? 0), lim = Number(url.searchParams.get("limit") ?? 1000);
      return Response.json(profiles.filter((p) => p.avatar_hash || p.banner_hash).slice(off, off + lim));
    }
    const ids = (url.searchParams.get("user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
    if (url.pathname.endsWith("/rest/v1/subscriptions")) return Response.json(subs.filter((s) => ids.includes(s.user_id)));
    if (url.pathname.endsWith("/rest/v1/plus_streaks")) return Response.json(streaks.filter((s) => ids.includes(s.user_id)));
    return new Response("[]", { status: 404 });
  }));
}

const env = () => ({ SUPABASE_SERVICE_ROLE_KEY: "service-key", PROFILE_IMAGES: { delete: async (k: string) => { deleted.push(k); } } as unknown as R2Bucket });
const person = (n: number, a: string | null, b: string | null = null, up: number | null = null): P => ({ user_id: uid(n), avatar_hash: a, banner_hash: b, images_updated_at: up === null ? null : iso(up) });

afterEach(() => { vi.unstubAllGlobals(); profiles = []; subs = []; streaks = []; deleted = []; failList = null; });

describe("isSweepTime", () => {
  it("só vale na janela das 03:00 UTC", () => {
    expect(isSweepTime(Date.UTC(2026, 10, 14, 3, 0))).toBe(true);
    expect(isSweepTime(Date.UTC(2026, 10, 14, 3, 4))).toBe(true);
    expect(isSweepTime(Date.UTC(2026, 10, 14, 3, 5))).toBe(false);
    expect(isSweepTime(Date.UTC(2026, 10, 14, 12, 0))).toBe(false);
  });
});

describe("sweepStaleImages", () => {
  it(`apaga as imagens de quem terminou o Plus há mais de ${IMAGE_GRACE_DAYS} dias`, async () => {
    fake();
    profiles = [person(1, H("a"), H("b"))];
    subs = [{ user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 100 * DAY) }];
    streaks = [{ user_id: uid(1), last_active_end: iso(NOW - 100 * DAY) }];
    expect(await sweepStaleImages(env(), NOW)).toEqual({ checked: 1, cleared: 1 });
    expect(profiles[0]).toMatchObject({ avatar_hash: null, banner_hash: null });
    expect(deleted.sort()).toEqual([`img/${H("a")}`, `img/${H("b")}`]);
  });

  it("não mexe em quem terminou há menos que isso", async () => {
    fake();
    profiles = [person(1, H("a"))];
    subs = [{ user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 30 * DAY) }];
    expect(await sweepStaleImages(env(), NOW)).toMatchObject({ cleared: 0 });
    expect(profiles[0].avatar_hash).toBe(H("a"));
    expect(deleted).toEqual([]);
  });

  it("não mexe em quem assina (nem em quem tem assinatura manual sem data)", async () => {
    fake();
    profiles = [person(1, H("a")), person(2, H("b")), person(3, H("c"))];
    subs = [
      { user_id: uid(1), status: "active", current_period_end: null },
      { user_id: uid(2), status: "trialing", current_period_end: iso(NOW - 500 * DAY) },
    ];
    streaks = [{ user_id: uid(1), last_active_end: iso(NOW - 500 * DAY) }];
    // a terceira conta nunca teve assinatura nem sequência: vale o último envio, que é recente
    profiles[2].images_updated_at = iso(NOW - 10 * DAY);
    expect((await sweepStaleImages(env(), NOW)).cleared).toBe(0);
  });

  it("usa o maior entre o fim do período e o da sequência", async () => {
    fake();
    profiles = [person(1, H("a"))];
    subs = [{ user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 200 * DAY) }];
    streaks = [{ user_id: uid(1), last_active_end: iso(NOW - 20 * DAY) }]; // pago até 20 dias atrás
    expect((await sweepStaleImages(env(), NOW)).cleared).toBe(0);
  });

  it("sem assinatura nem sequência, vale a data do último envio; sem data nenhuma, não mexe", async () => {
    fake();
    profiles = [person(1, H("a"), null, NOW - 120 * DAY), person(2, H("b"))];
    expect((await sweepStaleImages(env(), NOW)).cleared).toBe(1);
    expect(profiles[0].avatar_hash).toBeNull();
    expect(profiles[1].avatar_hash).toBe(H("b"));
  });

  it("não apaga o arquivo se outra conta ainda usa os mesmos bytes", async () => {
    fake();
    profiles = [person(1, H("a")), person(2, H("a"))];
    subs = [
      { user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 100 * DAY) },
      { user_id: uid(2), status: "active", current_period_end: null },
    ];
    expect((await sweepStaleImages(env(), NOW)).cleared).toBe(1);
    expect(profiles[0].avatar_hash).toBeNull();
    expect(profiles[1].avatar_hash).toBe(H("a"));
    expect(deleted).toEqual([]);
  });

  it("se não conseguir ler assinaturas ou sequências, não apaga nada", async () => {
    fake();
    profiles = [person(1, H("a"))];
    subs = [{ user_id: uid(1), status: "canceled", current_period_end: iso(NOW - 100 * DAY) }];
    failList = "/rest/v1/plus_streaks";
    expect((await sweepStaleImages(env(), NOW)).cleared).toBe(0);
    failList = "/rest/v1/subscriptions";
    expect((await sweepStaleImages(env(), NOW)).cleared).toBe(0);
    expect(profiles[0].avatar_hash).toBe(H("a"));
    expect(deleted).toEqual([]);
  });

  it("sem a chave de serviço ou sem o bucket, não faz nada", async () => {
    fake();
    expect(await sweepStaleImages({ PROFILE_IMAGES: env().PROFILE_IMAGES }, NOW)).toEqual({ checked: 0, cleared: 0 });
    expect(await sweepStaleImages({ SUPABASE_SERVICE_ROLE_KEY: "k" } as never, NOW)).toEqual({ checked: 0, cleared: 0 });
  });
});
