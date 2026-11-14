// ============================================================
// Testes da aparência do servidor: cor, etiquetas, recado, banner (R2 e Plus simulados)
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { applyLookEdit, bannerKey, publicLook, putBanner, removeBanner, serveBanner, EMPTY_LOOK, type ServerLook } from "./server-look";
import type { ImagesEnv } from "./profile-images";

const UID = "aaaaaaaa-e89b-42d3-a456-426614174001";
const SV = { uuid: "srv-uuid-1" };

/** WebP "VP8L" mínimo e válido para o cabeçalho: 960x320, sem animação. */
function webp(width = 960, height = 320): Uint8Array {
  const b = new Uint8Array(40);
  const put = (at: number, text: string) => [...text].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, "RIFF"); put(8, "WEBP"); put(12, "VP8L");
  const riff = b.length - 8;
  b[4] = riff & 255; b[5] = (riff >> 8) & 255; b[6] = (riff >> 16) & 255; b[7] = (riff >> 24) & 255;
  b[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  b[21] = bits & 255; b[22] = (bits >> 8) & 255; b[23] = (bits >> 16) & 255; b[24] = (bits >>> 24) & 255;
  return b;
}

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (k: string, v: Uint8Array) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    get: vi.fn(async (k: string) => (store.has(k) ? { arrayBuffer: async () => store.get(k)!.buffer } : null)),
  };
  return { bucket, store, env: { PROFILE_IMAGES: bucket as unknown as R2Bucket, SUPABASE_SERVICE_ROLE_KEY: "k" } as ImagesEnv };
}

describe("applyLookEdit", () => {
  it("aceita cor, etiquetas e recado da lista e arruma o recado", () => {
    const r = applyLookEdit(undefined, { color: "violet", tags: ["survival", "ptbr"], note: "  Evento   sábado\n\n\n às 20h  " });
    expect(r).toEqual({ ok: true, look: { ...EMPTY_LOOK, color: "violet", tags: ["survival", "ptbr"], note: "Evento sábado\nàs 20h" } });
  });

  it("só muda o que veio e preserva o resto (inclusive o banner)", () => {
    const current: ServerLook = { ...EMPTY_LOOK, color: "rose", tags: ["pvp"], note: "oi", bannerHash: "h".repeat(32), bannerOwner: UID, bannerAt: 5 };
    const r = applyLookEdit(current, { color: null });
    expect(r).toEqual({ ok: true, look: { ...current, color: null } });
  });

  it("recusa cor fora da lista, etiqueta desconhecida, repetida ou além de 3", () => {
    expect(applyLookEdit(undefined, { color: "#ff0000" }).ok).toBe(false);
    expect(applyLookEdit(undefined, { tags: ["nao-existe"] }).ok).toBe(false);
    expect(applyLookEdit(undefined, { tags: ["pvp", "pvp"] }).ok).toBe(false);
    expect(applyLookEdit(undefined, { tags: ["pvp", "casual", "modded", "vanilla"] }).ok).toBe(false);
    expect(applyLookEdit(undefined, { tags: "pvp" }).ok).toBe(false);
  });

  it("recado: sem link, no máximo 140 caracteres e 2 linhas; vazio vira nada", () => {
    expect(applyLookEdit(undefined, { note: "entre em discord.gg/abc" }).ok).toBe(false);
    expect(applyLookEdit(undefined, { note: "a".repeat(141) }).ok).toBe(false);
    expect(applyLookEdit(undefined, { note: "a".repeat(140) }).ok).toBe(true);
    expect(applyLookEdit(undefined, { note: "a\nb\nc" }).ok).toBe(false);
    expect(applyLookEdit(undefined, { note: "a\nb" }).ok).toBe(true);
    const empty = applyLookEdit({ ...EMPTY_LOOK, note: "x" }, { note: "   " });
    expect(empty).toMatchObject({ ok: true, look: { note: null } });
  });

  it("corpo que não é objeto é recusado", () => {
    expect(applyLookEdit(undefined, null).ok).toBe(false);
    expect(applyLookEdit(undefined, "x").ok).toBe(false);
  });
});

describe("publicLook", () => {
  const look: ServerLook = { ...EMPTY_LOOK, color: "sky", tags: ["casual"], note: "oi", bannerHash: "b".repeat(32), bannerOwner: UID, bannerAt: 1 };

  it("sem aparência definida, não há o que mostrar", async () => {
    expect(await publicLook(fakeBucket().env, undefined)).toBeNull();
  });

  it("mostra o banner enquanto o dono tem Plus e nunca devolve a conta dele", async () => {
    const r = await publicLook(fakeBucket().env, look, async () => true);
    expect(r).toEqual({ color: "sky", tags: ["casual"], note: "oi", bannerHash: "b".repeat(32) });
    expect(JSON.stringify(r)).not.toContain(UID);
  });

  it("some só o banner quando o Plus do dono acabou; cor, etiquetas e recado ficam", async () => {
    const r = await publicLook(fakeBucket().env, look, async () => false);
    expect(r).toEqual({ color: "sky", tags: ["casual"], note: "oi", bannerHash: null });
  });

  it("banner sem dono registrado não aparece", async () => {
    const r = await publicLook(fakeBucket().env, { ...look, bannerOwner: null }, async () => true);
    expect(r?.bannerHash).toBeNull();
  });
});

describe("putBanner / removeBanner", () => {
  it("grava o WebP sob a chave do servidor e devolve o hash e o dono", async () => {
    const { env, store } = fakeBucket();
    const r = await putBanner(env, SV, UID, webp(), 10_000, async () => true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.look).toMatchObject({ bannerOwner: UID, bannerAt: 10_000 });
    expect(r.look.bannerHash).toMatch(/^[a-f0-9]{32}$/);
    expect(store.has(bannerKey(SV.uuid))).toBe(true);
  });

  it("sem Plus recusa com 403 e não grava nada", async () => {
    const { env, store } = fakeBucket();
    const r = await putBanner(env, SV, UID, webp(), 10_000, async () => false);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(store.size).toBe(0);
  });

  it("recusa arquivo que não é WebP, tamanho errado e envio logo em seguida", async () => {
    const { env } = fakeBucket();
    expect(await putBanner(env, SV, UID, new Uint8Array([1, 2, 3]), 1, async () => true)).toMatchObject({ ok: false, status: 415 });
    expect(await putBanner(env, SV, UID, webp(100, 100), 1, async () => true)).toMatchObject({ ok: false, status: 400 });
    const first = await putBanner(env, SV, UID, webp(), 1_000, async () => true);
    if (!first.ok) throw new Error("esperava sucesso");
    expect(await putBanner(env, { ...SV, look: first.look }, UID, webp(), 2_000, async () => true)).toMatchObject({ ok: false, status: 429 });
    expect((await putBanner(env, { ...SV, look: first.look }, UID, webp(), 9_000, async () => true)).ok).toBe(true);
  });

  it("remover apaga o arquivo e zera o banner, preservando o resto", async () => {
    const { env, store } = fakeBucket();
    const r = await putBanner(env, SV, UID, webp(), 1, async () => true);
    if (!r.ok) throw new Error("esperava sucesso");
    const after = await removeBanner(env, { ...SV, look: { ...r.look, color: "teal" } });
    expect(after).toMatchObject({ color: "teal", bannerHash: null, bannerOwner: null, bannerAt: null });
    expect(store.size).toBe(0);
  });
});

describe("serveBanner", () => {
  const cors = { "Access-Control-Allow-Origin": "*" };

  it("serve o WebP com cache longo só quando o ?v= bate com o hash atual", async () => {
    const { env } = fakeBucket();
    const r = await putBanner(env, SV, UID, webp(), 1, async () => true);
    if (!r.ok) throw new Error("esperava sucesso");
    const server = { ...SV, look: r.look };
    const versioned = await serveBanner(env, server, new URL(`https://x.test/b?v=${r.look.bannerHash}`), cors, async () => true);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("Content-Type")).toBe("image/webp");
    expect(versioned.headers.get("Cache-Control")).toContain("immutable");
    const plain = await serveBanner(env, server, new URL("https://x.test/b?v=errado"), cors, async () => true);
    expect(plain.headers.get("Cache-Control")).not.toContain("immutable");
  });

  it("404 sem banner ou quando o Plus do dono acabou", async () => {
    const { env } = fakeBucket();
    expect((await serveBanner(env, SV, new URL("https://x.test/b"), cors)).status).toBe(404);
    const r = await putBanner(env, SV, UID, webp(), 1, async () => true);
    if (!r.ok) throw new Error("esperava sucesso");
    expect((await serveBanner(env, { ...SV, look: r.look }, new URL("https://x.test/b"), cors, async () => false)).status).toBe(404);
  });
});
