import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOOK_COLORS, LOOK_TAGS, lookColorHex, lookTagKey, noteServerLook, peekServerLook, sanitizeLook } from "@/lib/serverLook";

const HASH = "a".repeat(32);

describe("sanitizeLook", () => {
  it("aceita só o que está nas listas fechadas", () => {
    expect(sanitizeLook({ color: "violet", tags: ["pvp", "casual"], note: "Evento sábado", bannerHash: HASH })).toEqual({ color: "violet", tags: ["pvp", "casual"], note: "Evento sábado", bannerHash: HASH });
    expect(sanitizeLook({ color: "#ff0000", tags: ["nao-existe", "pvp"], note: "  ", bannerHash: "../x" })).toEqual({ color: null, tags: ["pvp"], note: null, bannerHash: null });
  });

  it("limita a 3 etiquetas, sem repetir, e o recado a 140 caracteres", () => {
    const r = sanitizeLook({ tags: ["pvp", "pvp", "casual", "modded", "vanilla"], note: "x".repeat(300) });
    expect(r?.tags).toEqual(["pvp", "casual", "modded"]);
    expect(r?.note).toHaveLength(140);
  });

  it("lixo vira 'sem aparência'", () => {
    for (const bad of [null, undefined, "x", 5, []]) expect(sanitizeLook(bad)).toBeNull();
  });
});

describe("catálogo", () => {
  it("toda cor tem um hex e toda etiqueta tem um texto", () => {
    for (const c of LOOK_COLORS) expect(lookColorHex(c.id)).toMatch(/^#[0-9a-f]{6}$/);
    for (const t of LOOK_TAGS) expect(lookTagKey(t.id)).toBe(t.labelKey);
    expect(lookColorHex("nada")).toBeNull();
    expect(lookTagKey("nada")).toBeNull();
  });
});

describe("guardado dos amigos", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) });
  });

  it("guarda a última aparência vista e esquece quando o host tira tudo", () => {
    noteServerLook("ZZZ111", { color: "sky", tags: ["pvp"], note: null, bannerHash: null });
    expect(peekServerLook("ZZZ111")).toMatchObject({ color: "sky", tags: ["pvp"] });
    expect(JSON.parse(localStorage.getItem("cubicase-guest-look:ZZZ111")!)).toMatchObject({ color: "sky" });
    noteServerLook("ZZZ111", undefined);
    expect(peekServerLook("ZZZ111")).toBeNull();
    expect(localStorage.getItem("cubicase-guest-look:ZZZ111")).toBeNull();
  });
});
