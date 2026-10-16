import { beforeEach, describe, expect, it, vi } from "vitest";

// A lista de mods vem do HOST (qualquer pessoa com o código): nada nela é confiável.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/path", () => ({ join: (...p: string[]) => Promise.resolve(p.join("/")) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn(), readDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
const lookupMock = vi.fn();
vi.mock("@/lib/modrinth", () => ({ lookupModrinthByHashes: (...a: unknown[]) => lookupMock(...a) }));
vi.mock("@/i18n", () => ({ t: (k: string) => k }));

const { isSafeModFilename, sanitizeRemoteMods, runModSync, fetchRemoteModsList, setModsSource } = await import("@/lib/modSync");

const SHA = "a".repeat(40);

beforeEach(() => {
  invokeMock.mockReset();
  lookupMock.mockReset();
});

describe("isSafeModFilename", () => {
  it("aceita nomes normais de mod", () => {
    expect(isSafeModFilename("sodium-fabric-0.5.8+mc1.20.1.jar")).toBe(true);
    expect(isSafeModFilename("JEI [1.20.1] v2.JAR")).toBe(true);
  });

  it("rejeita traversal, caminhos absolutos, streams e extensões que não são .jar", () => {
    for (const bad of [
      "..\\..\\Startup\\x.jar",
      "../x.jar",
      "sub/x.jar",
      "C:\\Windows\\x.jar",
      "x.jar:stream",
      "x.bat",
      "x.jar.bat",
      "con.jar",
      "NUL.jar",
      "a..b.jar",
      "",
      "x".repeat(300) + ".jar",
    ]) {
      expect(isSafeModFilename(bad), bad).toBe(false);
    }
    expect(isSafeModFilename(42)).toBe(false);
    expect(isSafeModFilename(null)).toBe(false);
  });
});

describe("sanitizeRemoteMods", () => {
  it("descarta entradas perigosas/malformadas e ignora a URL mandada pelo host", () => {
    const out = sanitizeRemoteMods([
      { filename: "ok.jar", size_bytes: 10, sha1: SHA.toUpperCase(), source: "modrinth", url: "https://evil.example/x.jar" },
      { filename: "..\\..\\evil.jar", size_bytes: 10, sha1: SHA, source: "unknown", url: null },
      { filename: "semhash.jar", size_bytes: 10, sha1: "xyz", source: "unknown", url: null },
      { filename: "tam.jar", size_bytes: -1, sha1: SHA, source: "unknown", url: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filename: "ok.jar", sha1: SHA, source: "modrinth", url: null });
    expect(sanitizeRemoteMods({ not: "an array" })).toEqual([]);
  });
});

describe("runModSync", () => {
  const entry = (filename: string, source: "modrinth" | "mesh") => ({ filename, sizeBytes: 1, source, status: "pending" as const });

  it("mod 'modrinth' usa a URL devolvida pela Modrinth (pelo hash), nunca a do host", async () => {
    lookupMock.mockResolvedValue(new Map([[SHA, { url: "https://cdn.modrinth.com/data/x/ok.jar" }]]));
    invokeMock.mockResolvedValue(undefined);
    const mods = [{ filename: "ok.jar", size_bytes: 1, sha1: SHA, source: "modrinth" as const, url: "https://evil.example/x.jar" }];
    const entries = [entry("ok.jar", "modrinth")];
    await runModSync({ shortCode: "ABC", instanceModsDir: "/inst/mods", remoteMods: mods, entries, onProgress: () => {} });
    expect(invokeMock).toHaveBeenCalledWith("download_mod_file", expect.objectContaining({ url: "https://cdn.modrinth.com/data/x/ok.jar", destPath: "/inst/mods/ok.jar" }));
    expect(entries[0].status).toBe("ok");
  });

  it("sem confirmação da Modrinth cai para o proxy do host (loopback), não para a URL do host", async () => {
    lookupMock.mockResolvedValue(new Map());
    invokeMock.mockResolvedValue(undefined);
    const mods = [{ filename: "ok.jar", size_bytes: 1, sha1: SHA, source: "modrinth" as const, url: "https://evil.example/x.jar" }];
    const entries = [entry("ok.jar", "modrinth")];
    await runModSync({ shortCode: "ABC", instanceModsDir: "/inst/mods", remoteMods: mods, entries, onProgress: () => {} });
    const call = invokeMock.mock.calls[0][1] as { url: string };
    expect(call.url.startsWith("http://127.0.0.1:25568/mods/file?")).toBe(true);
  });

  it("nome perigoso que escape da sanitização nunca chega ao download", async () => {
    const mods = [{ filename: "..\\..\\evil.jar", size_bytes: 1, sha1: SHA, source: "unknown" as const, url: null }];
    const entries = [entry("..\\..\\evil.jar", "mesh")];
    await runModSync({ shortCode: "ABC", instanceModsDir: "/inst/mods", remoteMods: mods, entries, onProgress: () => {} });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(entries[0].status).toBe("failed");
  });
});

describe("origem dos mods no plano B (Radmin)", () => {
  const entry = (filename: string) => ({ filename, sizeBytes: 1, source: "mesh" as const, status: "pending" as const });

  it("sem Modrinth, o arquivo vem do servidor de mods do host na rede do Radmin", async () => {
    lookupMock.mockResolvedValue(new Map());
    invokeMock.mockResolvedValue(undefined);
    setModsSource({ kind: "radmin", host: "26.202.7.93" });
    try {
      const mods = [{ filename: "a.jar", size_bytes: 1, sha1: SHA, source: "unknown" as const, url: null }];
      await runModSync({ shortCode: "ABC", instanceModsDir: "/inst/mods", remoteMods: mods, entries: [entry("a.jar")], onProgress: () => {} });
      const call = invokeMock.mock.calls[0][1] as { url: string };
      expect(call.url).toBe("http://26.202.7.93:25567/mods/file?code=ABC&name=a.jar");
    } finally {
      setModsSource({ kind: "proxy" });
    }
  });

  it("a lista de mods é buscada pelo Rust (comando validado), e os erros viram as mesmas mensagens do P2P", async () => {
    setModsSource({ kind: "radmin", host: "26.202.7.93" });
    try {
      invokeMock.mockResolvedValueOnce(JSON.stringify([{ filename: "a.jar", size_bytes: 1, sha1: SHA, source: "unknown", url: null }]));
      const list = await fetchRemoteModsList("ABC");
      expect(invokeMock).toHaveBeenCalledWith("fetch_radmin_mods_list", { host: "26.202.7.93", code: "ABC" });
      expect(list).toHaveLength(1);

      invokeMock.mockRejectedValueOnce("NOT_HOSTING");
      await expect(fetchRemoteModsList("ABC")).rejects.toThrow("modsync.notHosting");
      invokeMock.mockRejectedValueOnce("UNREACHABLE");
      await expect(fetchRemoteModsList("ABC")).rejects.toThrow("modsync.hostUnreachable");
      invokeMock.mockResolvedValueOnce("isto não é json");
      expect(await fetchRemoteModsList("ABC")).toEqual([]);
    } finally {
      setModsSource({ kind: "proxy" });
    }
  });

  it("voltar para o P2P restaura o proxy local", async () => {
    setModsSource({ kind: "radmin", host: "26.1.2.3" });
    setModsSource({ kind: "proxy" });
    lookupMock.mockResolvedValue(new Map());
    invokeMock.mockResolvedValue(undefined);
    const mods = [{ filename: "a.jar", size_bytes: 1, sha1: SHA, source: "unknown" as const, url: null }];
    await runModSync({ shortCode: "ABC", instanceModsDir: "/inst/mods", remoteMods: mods, entries: [entry("a.jar")], onProgress: () => {} });
    expect((invokeMock.mock.calls[0][1] as { url: string }).url.startsWith("http://127.0.0.1:25568/")).toBe(true);
  });
});
