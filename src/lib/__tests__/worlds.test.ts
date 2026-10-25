import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/path", () => ({ join: (...p: string[]) => Promise.resolve(p.join("/")) }));
// serverUpgrade (usado só para comparar versões) puxa o resto do app: mocka o que ele importa.
vi.mock("@/lib/server", () => ({}));
vi.mock("@/lib/modrinth", () => ({}));
vi.mock("@tauri-apps/plugin-fs", () => ({}));

const { uniqueWorldName, worldIsNewerThanServer, worldNameProblem } = await import("@/lib/worlds");
const { applyResourcePack, clearResourcePack, installDatapack, isModrinthCdnUrl, MAX_RESOURCE_PACK_BYTES } = await import("@/lib/worldPacks");
import type { ModrinthVersion } from "@/lib/modrinth";

const SHA1 = "a".repeat(40);
function version(file: Partial<{ url: string; filename: string; size: number; sha1: string | undefined }> = {}): ModrinthVersion {
  return {
    id: "v1", project_id: "p1", version_number: "1", name: "X", game_versions: ["1.20.1"], loaders: [], dependencies: [],
    files: [{
      url: file.url ?? "https://cdn.modrinth.com/data/p1/versions/v1/pack.zip",
      filename: file.filename ?? "pack.zip",
      primary: true,
      hashes: { sha1: "sha1" in file ? file.sha1 : SHA1 },
      size: file.size ?? 1000,
    }],
  } as ModrinthVersion;
}

beforeEach(() => invokeMock.mockReset());

describe("mundos", () => {
  it("mundo mais novo que o servidor é detectado; versão desconhecida ou estranha não bloqueia", () => {
    expect(worldIsNewerThanServer("1.21.4", "1.20.1")).toBe(true);
    expect(worldIsNewerThanServer("1.20.1", "1.20.1")).toBe(false);
    expect(worldIsNewerThanServer("1.19.4", "1.20.1")).toBe(false);
    expect(worldIsNewerThanServer("26.1", "1.21.4")).toBe(true);
    expect(worldIsNewerThanServer(null, "1.20.1")).toBe(false);
    expect(worldIsNewerThanServer("24w14a", "1.20.1")).toBe(false);
  });

  it("nome único: acrescenta número sem diferenciar maiúsculas e respeita 64 caracteres", () => {
    expect(uniqueWorldName("world", [])).toBe("world");
    expect(uniqueWorldName("World", ["world"])).toBe("World 2");
    expect(uniqueWorldName("a", ["a", "a 2", "A 3"])).toBe("a 4");
    expect(uniqueWorldName("x".repeat(64), ["x".repeat(64)]).length).toBeLessThanOrEqual(64);
  });

  it("nome do mundo: o aviso na tela segue as regras do backend", () => {
    expect(worldNameProblem("Meu Mundo 2")).toBeNull();
    expect(worldNameProblem("  ")).toBe("empty");
    for (const bad of ["a/b", "a:b", ".oculto", "fim.", "CON", "com1", "mods", "Plugins", "x".repeat(65), "a\nb"]) {
      expect(worldNameProblem(bad), bad).toBe("invalid");
    }
  });
});

describe("pacote de recursos e datapacks", () => {
  it("só aceita URL do CDN da Modrinth", () => {
    expect(isModrinthCdnUrl("https://cdn.modrinth.com/data/a/b.zip")).toBe(true);
    for (const bad of ["http://cdn.modrinth.com/a.zip", "https://evil.example/a.zip", "https://cdn.modrinth.com.evil.example/a.zip", "https://cdn.modrinth.com:8443/a.zip", "nao-url"]) {
      expect(isModrinthCdnUrl(bad), bad).toBe(false);
    }
  });

  it("aplica o pacote: URL, checksum em minúsculas e 'obrigatório' vão para o server.properties", async () => {
    invokeMock.mockResolvedValue(undefined);
    await applyResourcePack("/srv", version({ sha1: "A".repeat(40) }), true);
    expect(invokeMock).toHaveBeenCalledWith("write_server_properties", {
      serverDir: "/srv",
      props: { "resource-pack": "https://cdn.modrinth.com/data/p1/versions/v1/pack.zip", "resource-pack-sha1": "a".repeat(40), "require-resource-pack": "true" },
    });
  });

  it("recusa pacote sem checksum, grande demais, ou de fora da Modrinth — e não escreve nada", async () => {
    await expect(applyResourcePack("/srv", version({ sha1: undefined }), false)).rejects.toThrow();
    await expect(applyResourcePack("/srv", version({ sha1: "xyz" }), false)).rejects.toThrow();
    await expect(applyResourcePack("/srv", version({ size: MAX_RESOURCE_PACK_BYTES + 1 }), false)).rejects.toThrow();
    await expect(applyResourcePack("/srv", version({ url: "https://evil.example/p.zip" }), false)).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("remover o pacote limpa as três propriedades", async () => {
    invokeMock.mockResolvedValue(undefined);
    await clearResourcePack("/srv");
    expect(invokeMock.mock.calls[0][1].props).toEqual({ "resource-pack": "", "resource-pack-sha1": "", "require-resource-pack": "false" });
  });

  it("datapack vai para <servidor>/<mundo ativo>/datapacks e só se for .zip", async () => {
    invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "read_server_properties" ? { "level-name": "Aventura" } : undefined));
    const name = await installDatapack("/srv", version({ filename: "vida.zip" }));
    expect(name).toBe("vida.zip");
    const dl = invokeMock.mock.calls.find((c) => c[0] === "download_server_jar")![1];
    expect(dl.destPath).toBe("/srv/Aventura/datapacks/vida.zip");
    expect(dl.expectedSha1).toBe(SHA1);

    invokeMock.mockClear();
    await expect(installDatapack("/srv", version({ filename: "script.exe" }))).rejects.toThrow();
    await expect(installDatapack("/srv", version({ filename: "..\\x.zip" }))).rejects.toThrow();
    expect(invokeMock.mock.calls.some((c) => c[0] === "download_server_jar")).toBe(false);
  });

  it("sem level-name no server.properties o mundo é 'world'", async () => {
    invokeMock.mockImplementation((cmd: string) => (cmd === "read_server_properties" ? Promise.reject("sem arquivo") : Promise.resolve(undefined)));
    await installDatapack("/srv", version({ filename: "a.zip" }));
    expect(invokeMock.mock.calls.find((c) => c[0] === "download_server_jar")![1].destPath).toBe("/srv/world/datapacks/a.zip");
  });
});
