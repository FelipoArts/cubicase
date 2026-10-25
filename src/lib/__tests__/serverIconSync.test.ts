import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { dataUrlToBytes, iconHashOf } from "@/lib/serverIconSync";

describe("ícone do servidor (sincronização)", () => {
  it("o hash é o início do SHA-256 dos bytes — o mesmo que o Worker calcula", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await iconHashOf(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea");
  });

  it("converte o data URL do PNG em bytes e recusa o que não é PNG em base64", () => {
    const bytes = dataUrlToBytes("data:image/png;base64,iVBORw0KGgo=");
    expect(bytes && Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(dataUrlToBytes("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(dataUrlToBytes("data:image/png;base64,@@@")).toBeNull();
    expect(dataUrlToBytes("https://exemplo.com/a.png")).toBeNull();
  });
});
