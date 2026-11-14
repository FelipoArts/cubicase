// ============================================================
// Testes das imagens de perfil (foto e banner, só Plus): leitura do WebP, regras de envio e entrega
// ============================================================
// R2 de verdade (Miniflare); Supabase simulado em memória.
// ============================================================

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_SPECS, UPLOAD_COOLDOWN_MS, checkImage, handleProfileImageRoute, parseWebp, purgeImage, serveProfileImage,
} from "./profile-images";

// ---------------- arquivos WebP sintéticos (só o cabeçalho conta) ----------------

function riff(chunk: Uint8Array, total = 40): Uint8Array {
  const out = new Uint8Array(Math.max(total, 12 + chunk.length));
  out.set([...("RIFF" + "\0\0\0\0" + "WEBP")].map((c) => c.charCodeAt(0)), 0);
  out.set(chunk, 12);
  const size = out.length - 8;
  out[4] = size & 255; out[5] = (size >> 8) & 255; out[6] = (size >> 16) & 255; out[7] = (size >>> 24) & 255;
  return out;
}
const fourcc = (s: string) => [...s].map((c) => c.charCodeAt(0));

function vp8(w: number, h: number, total = 40): Uint8Array {
  const c = new Uint8Array(40);
  c.set(fourcc("VP8 "), 0);
  c.set([0x30, 0, 0, 0x9d, 0x01, 0x2a], 8); // tag de quadro-chave + código de início
  c[14] = w & 255; c[15] = (w >> 8) & 0x3f; c[16] = h & 255; c[17] = (h >> 8) & 0x3f;
  return riff(c, total);
}
function vp8l(w: number, h: number): Uint8Array {
  const c = new Uint8Array(24);
  c.set(fourcc("VP8L"), 0);
  c[8] = 0x2f;
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  c[9] = bits & 255; c[10] = (bits >> 8) & 255; c[11] = (bits >> 16) & 255; c[12] = (bits >>> 24) & 255;
  return riff(c);
}
function vp8x(w: number, h: number, animated = false): Uint8Array {
  const c = new Uint8Array(24);
  c.set(fourcc("VP8X"), 0);
  c[4] = 10;
  c[8] = animated ? 0x02 : 0;
  const cw = w - 1, ch = h - 1;
  c[12] = cw & 255; c[13] = (cw >> 8) & 255; c[14] = (cw >> 16) & 255;
  c[15] = ch & 255; c[16] = (ch >> 8) & 255; c[17] = (ch >> 16) & 255;
  return riff(c);
}

const AVATAR = IMAGE_SPECS.avatar;
const BANNER = IMAGE_SPECS.banner;

describe("parseWebp", () => {
  it("lê as dimensões dos três formatos", () => {
    expect(parseWebp(vp8(256, 256))).toEqual({ width: 256, height: 256, animated: false });
    expect(parseWebp(vp8l(960, 320))).toEqual({ width: 960, height: 320, animated: false });
    expect(parseWebp(vp8x(256, 256))).toEqual({ width: 256, height: 256, animated: false });
  });

  it("reconhece o WebP animado", () => {
    expect(parseWebp(vp8x(256, 256, true))?.animated).toBe(true);
  });

  it("recusa o que não é WebP, truncado ou com tamanho de RIFF que não bate", () => {
    expect(parseWebp(new Uint8Array(0))).toBeNull();
    expect(parseWebp(new TextEncoder().encode("GIF89a" + "x".repeat(60)))).toBeNull();
    expect(parseWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(60).fill(1)]))).toBeNull(); // PNG
    expect(parseWebp(vp8(256, 256).slice(0, 35))).toBeNull(); // truncado
    const lixo = new Uint8Array([...vp8(256, 256), 1, 2, 3]);
    expect(parseWebp(lixo)).toBeNull(); // sobra no fim
  });

  it("recusa quadro VP8 sem o código de início", () => {
    const bad = vp8(256, 256);
    bad[23] = 0;
    expect(parseWebp(bad)).toBeNull();
  });
});

describe("checkImage", () => {
  it("aceita o tamanho exato e dá um hash de 32 hex, igual para o mesmo conteúdo", async () => {
    const a = await checkImage("avatar", vp8(AVATAR.width, AVATAR.height));
    const b = await checkImage("avatar", vp8(AVATAR.width, AVATAR.height));
    expect(a.ok && a.hash).toMatch(/^[a-f0-9]{32}$/);
    expect(a).toEqual(b);
    const other = await checkImage("avatar", vp8l(AVATAR.width, AVATAR.height));
    expect(other.ok && other.hash).not.toBe(a.ok && a.hash);
  });

  it("recusa dimensões erradas, uma troca de tipo e imagem animada", async () => {
    expect(await checkImage("avatar", vp8(300, 300))).toMatchObject({ ok: false, status: 400 });
    expect(await checkImage("avatar", vp8l(BANNER.width, BANNER.height))).toMatchObject({ ok: false, status: 400 });
    expect(await checkImage("banner", vp8l(AVATAR.width, AVATAR.height))).toMatchObject({ ok: false, status: 400 });
    expect(await checkImage("avatar", vp8x(AVATAR.width, AVATAR.height, true))).toMatchObject({ ok: false, status: 415 });
  });

  it("recusa vazio, grande demais e formato diferente", async () => {
    expect(await checkImage("avatar", new Uint8Array(0))).toMatchObject({ ok: false, status: 400 });
    expect(await checkImage("avatar", vp8(AVATAR.width, AVATAR.height, AVATAR.maxBytes + 10))).toMatchObject({ ok: false, status: 413 });
    expect(await checkImage("avatar", new TextEncoder().encode("não sou uma imagem, mas sou comprido o bastante"))).toMatchObject({ ok: false, status: 415 });
  });
});

// ---------------- rotas, com Supabase em memória ----------------

const USER = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "bbbbbbbb-e89b-42d3-a456-426614174002";

interface Row { user_id: string; display_name: string; avatar_id: string; name_color: string | null; bio: string | null; avatar_hash: string | null; banner_hash: string | null; images_updated_at: string | null }
let rows: Row[] = [];
let plus = true;
let loggedIn = true;

const baseRow = (user_id: string, over: Partial<Row> = {}): Row => ({
  user_id, display_name: "Felipo", avatar_id: "cube", name_color: null, bio: null, avatar_hash: null, banner_hash: null, images_updated_at: null, ...over,
});

function fakeSupabase() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/auth/v1/user")) {
      return loggedIn ? Response.json({ id: USER, email: "a@example.com", user_metadata: {} }) : new Response("{}", { status: 401 });
    }
    if (url.pathname.endsWith("/rest/v1/subscriptions")) return Response.json(plus ? [{ status: "active" }] : []);
    if (url.pathname.endsWith("/rest/v1/profiles")) {
      const uid = url.searchParams.get("user_id")?.replace(/^eq\./, "");
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body));
        rows.filter((r) => r.user_id === uid).forEach((r) => Object.assign(r, patch));
        return new Response(null, { status: 204 });
      }
      const or = url.searchParams.get("or"); // (avatar_hash.eq.X,banner_hash.eq.X)
      if (or) {
        const hash = /eq\.([a-f0-9]{32})/.exec(or)?.[1];
        return Response.json(rows.filter((r) => r.avatar_hash === hash || r.banner_hash === hash).map((r) => ({ user_id: r.user_id })));
      }
      return Response.json(rows.filter((r) => !uid || r.user_id === uid));
    }
    return new Response("[]", { status: 404 });
  }));
}

const imagesEnv = () => ({ SUPABASE_SERVICE_ROLE_KEY: "service-key", PROFILE_IMAGES: env.PROFILE_IMAGES });
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const put = (kind: string, body: Uint8Array | string, headers: Record<string, string> = {}) =>
  handleProfileImageRoute(
    new Request(`https://api.test/api/v1/profile/me/${kind}`, { method: "PUT", headers: { Authorization: "Bearer tok", ...headers }, body }),
    imagesEnv(), "PUT", `/api/v1/profile/me/${kind}`, NOW,
  );
const del = (kind: string) =>
  handleProfileImageRoute(new Request(`https://api.test/api/v1/profile/me/${kind}`, { method: "DELETE", headers: { Authorization: "Bearer tok" } }), imagesEnv(), "DELETE", `/api/v1/profile/me/${kind}`, NOW);

const avatarBytes = () => vp8(AVATAR.width, AVATAR.height);
const hashOfBytes = async (b: Uint8Array) => { const c = await checkImage("avatar", b); return c.ok ? c.hash : ""; };
const inR2 = async (hash: string) => !!(await env.PROFILE_IMAGES.get(`img/${hash}`));

beforeEach(() => { rows = [baseRow(USER)]; plus = true; loggedIn = true; fakeSupabase(); });
afterEach(() => vi.unstubAllGlobals());

describe("enviar (PUT /api/v1/profile/me/{avatar|banner})", () => {
  it("guarda no R2 pelo hash, grava o hash no perfil e devolve o perfil", async () => {
    const bytes = avatarBytes();
    const r = await put("avatar", bytes);
    expect(r?.status).toBe(200);
    const hash = await hashOfBytes(bytes);
    expect((r?.data as any).profile.avatarHash).toBe(hash);
    expect(rows[0].avatar_hash).toBe(hash);
    expect(rows[0].images_updated_at).toBe(new Date(NOW).toISOString());
    expect(await inR2(hash)).toBe(true);
    const stored = await env.PROFILE_IMAGES.get(`img/${hash}`);
    expect(stored?.httpMetadata?.contentType).toBe("image/webp");
  });

  it("o banner usa a própria coluna e as próprias dimensões", async () => {
    const r = await put("banner", vp8(BANNER.width, BANNER.height));
    expect(r?.status).toBe(200);
    expect(rows[0].banner_hash).toMatch(/^[a-f0-9]{32}$/);
    expect(rows[0].avatar_hash).toBeNull();
    rows[0].images_updated_at = null; // sem esperar o intervalo entre envios
    expect((await put("banner", avatarBytes()))?.status).toBe(400); // dimensões do avatar no banner
  });

  it("exige login, perfil criado e Plus ativo", async () => {
    loggedIn = false;
    expect((await put("avatar", avatarBytes()))?.status).toBe(401);
    loggedIn = true;
    rows = [];
    expect((await put("avatar", avatarBytes()))?.status).toBe(400);
    rows = [baseRow(USER)];
    plus = false;
    const r = await put("avatar", avatarBytes());
    expect(r?.status).toBe(403);
    expect(r?.code).toBe("SUBSCRIPTION_REQUIRED");
    expect(rows[0].avatar_hash).toBeNull();
  });

  it("espera um intervalo entre dois envios", async () => {
    rows = [baseRow(USER, { images_updated_at: new Date(NOW - (UPLOAD_COOLDOWN_MS - 1000)).toISOString() })];
    expect((await put("avatar", avatarBytes()))?.status).toBe(429);
    rows = [baseRow(USER, { images_updated_at: new Date(NOW - UPLOAD_COOLDOWN_MS - 1000).toISOString() })];
    expect((await put("avatar", avatarBytes()))?.status).toBe(200);
  });

  it("recusa arquivo que não é WebP, grande demais (por Content-Length e por corpo) e vazio", async () => {
    expect((await put("avatar", new TextEncoder().encode("isto não é uma imagem de verdade, ok?")))?.status).toBe(415);
    expect((await put("avatar", avatarBytes(), { "Content-Length": String(AVATAR.maxBytes + 1) }))?.status).toBe(413);
    expect((await put("avatar", vp8(AVATAR.width, AVATAR.height, AVATAR.maxBytes + 100)))?.status).toBe(413);
    expect((await put("avatar", ""))?.status).toBe(400);
    expect(rows[0].avatar_hash).toBeNull();
  });

  it("trocar a imagem apaga a anterior do R2 se ninguém mais a usa", async () => {
    const first = new Uint8Array(avatarBytes());
    const second = vp8l(AVATAR.width, AVATAR.height);
    await put("avatar", first);
    const firstHash = await hashOfBytes(first);
    rows[0].images_updated_at = null; // sem esperar o intervalo
    await put("avatar", second);
    expect(await inR2(firstHash)).toBe(false);
    expect(await inR2(await hashOfBytes(second))).toBe(true);
  });

  it("trocar o banner direto, já tendo um, funciona sem precisar remover o atual antes", async () => {
    const first = vp8(BANNER.width, BANNER.height);
    const second = vp8l(BANNER.width, BANNER.height);
    const firstHash = (await checkImage("banner", first)) as { ok: true; hash: string };
    const secondHash = (await checkImage("banner", second)) as { ok: true; hash: string };
    expect((await put("banner", first))?.status).toBe(200);
    expect(rows[0].banner_hash).toBe(firstHash.hash);
    // passou o intervalo curto entre envios: a troca é aceita direto
    rows[0].images_updated_at = new Date(NOW - UPLOAD_COOLDOWN_MS - 500).toISOString();
    const r = await put("banner", second);
    expect(r?.status).toBe(200);
    expect(rows[0].banner_hash).toBe(secondHash.hash);
    expect((r?.data as any).profile.bannerHash).toBe(secondHash.hash);
    expect(await inR2(firstHash.hash)).toBe(false); // o anterior foi limpo
    expect(await inR2(secondHash.hash)).toBe(true);
  });

  it("o intervalo entre envios é curto (não deve travar uma troca feita logo em seguida)", () => {
    expect(UPLOAD_COOLDOWN_MS).toBeLessThanOrEqual(5_000);
  });

  it("não apaga a anterior se outra conta usa o mesmo arquivo", async () => {
    const first = avatarBytes();
    const firstHash = await hashOfBytes(first);
    await put("avatar", first);
    rows.push(baseRow(OTHER, { avatar_hash: firstHash })); // outra conta, mesmo conteúdo
    rows[0].images_updated_at = null;
    await put("avatar", vp8l(AVATAR.width, AVATAR.height));
    expect(await inR2(firstHash)).toBe(true);
  });
});

describe("remover (DELETE /api/v1/profile/me/{avatar|banner})", () => {
  it("limpa o hash e apaga o arquivo", async () => {
    const bytes = avatarBytes();
    await put("avatar", bytes);
    const hash = await hashOfBytes(bytes);
    const r = await del("avatar");
    expect(r?.status).toBe(200);
    expect(rows[0].avatar_hash).toBeNull();
    expect(await inR2(hash)).toBe(false);
  });

  it("remover não exige Plus (quem deixou de assinar também pode tirar a imagem)", async () => {
    await put("avatar", avatarBytes());
    plus = false;
    expect((await del("avatar"))?.status).toBe(200);
  });
});

describe("rotas que não são deste módulo", () => {
  it("devolve null", async () => {
    const r = await handleProfileImageRoute(new Request("https://api.test/x"), imagesEnv(), "GET", "/api/v1/profile/me/avatar");
    expect(r).toBeNull();
    expect(await handleProfileImageRoute(new Request("https://api.test/x", { method: "PUT" }), imagesEnv(), "PUT", "/api/v1/profile/me")).toBeNull();
  });
});

describe("purgeImage", () => {
  it("com force apaga mesmo que ainda haja quem aponte (moderação)", async () => {
    const bytes = avatarBytes();
    const hash = await hashOfBytes(bytes);
    await env.PROFILE_IMAGES.put(`img/${hash}`, bytes);
    rows.push(baseRow(OTHER, { avatar_hash: hash }));
    await purgeImage(imagesEnv(), hash);
    expect(await inR2(hash)).toBe(true);
    await purgeImage(imagesEnv(), hash, true);
    expect(await inR2(hash)).toBe(false);
  });

  it("ignora hash inválido ou vazio", async () => {
    await expect(purgeImage(imagesEnv(), "../etc/passwd")).resolves.toBeUndefined();
    await expect(purgeImage(imagesEnv(), null)).resolves.toBeUndefined();
  });
});

describe("GET /api/v1/profile-image/{hash}", () => {
  it("serve o arquivo com cache longo e sem adivinhar tipo", async () => {
    const bytes = avatarBytes();
    const hash = await hashOfBytes(bytes);
    await env.PROFILE_IMAGES.put(`img/${hash}`, bytes);
    const resp = await serveProfileImage(new Request(`https://api.test/api/v1/profile-image/${hash}`), imagesEnv(), hash);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/webp");
    expect(resp.headers.get("Cache-Control")).toContain("immutable");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes);
  });

  it("404 para hash inexistente ou mal formado", async () => {
    const missing = "0".repeat(32);
    expect((await serveProfileImage(new Request(`https://api.test/x/${missing}`), imagesEnv(), missing)).status).toBe(404);
    expect((await serveProfileImage(new Request("https://api.test/x"), imagesEnv(), "../../segredo")).status).toBe(404);
  });
});
