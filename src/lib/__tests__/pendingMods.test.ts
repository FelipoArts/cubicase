import { describe, it, expect, vi } from "vitest";

// pendingMods importa APIs do Tauri; reconcile/pendingModPageUrl são puras, então basta stubar os módulos.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ join: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(), remove: vi.fn() }));

import { reconcile, pendingModPageUrl, type PendingMod } from "../pendingMods";

const pending = (over: Partial<PendingMod>): PendingMod => ({
  key: "1:2",
  name: "Mod",
  fileName: "mod-1.0.jar",
  slug: "mod",
  projectId: 1,
  fileId: 2,
  packName: "Pack",
  addedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("reconcile", () => {
  it("remove o que já está na pasta, ignorando maiúsculas e .disabled", () => {
    const left = reconcile(
      [pending({ key: "a", fileName: "Mod-1.0.jar" }), pending({ key: "b", fileName: "outro.jar" }), pending({ key: "c", fileName: "off.jar" })],
      ["mod-1.0.jar", "off.jar.disabled"]
    );
    expect(left.map((m) => m.key)).toEqual(["b"]);
  });

  it("mantém pendências sem nome de arquivo conhecido (só o host pode dispensar)", () => {
    expect(reconcile([pending({ fileName: null })], ["qualquer.jar"])).toHaveLength(1);
  });
});

describe("pendingModPageUrl", () => {
  it("aponta para a página do arquivo na CurseForge", () => {
    expect(pendingModPageUrl(pending({ slug: "jei", fileId: 99 }))).toBe("https://www.curseforge.com/minecraft/mc-mods/jei/files/99");
  });
  it("sem slug usa o id do projeto", () => {
    expect(pendingModPageUrl(pending({ slug: null, projectId: 7, fileId: 9 }))).toContain("/7/files/9");
  });
});
