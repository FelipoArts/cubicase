import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks (lib/cubicasePack.ts só orquestra: todo I/O vem de Tauri) ----
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("9.9.9") }));
vi.mock("@tauri-apps/api/path", () => ({
  documentDir: () => Promise.resolve("/docs"),
  join: (...p: string[]) => Promise.resolve(p.join("/")),
}));

// "Disco" em memória
const files = new Map<string, string>();
const removed: string[] = [];
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (p: string) => Promise.resolve(files.has(p)),
  readTextFile: (p: string) => (files.has(p) ? Promise.resolve(files.get(p)!) : Promise.reject(new Error("ENOENT"))),
  writeTextFile: (p: string, c: string) => {
    files.set(p, c);
    return Promise.resolve();
  },
  remove: (p: string) => {
    removed.push(p);
    files.delete(p);
    return Promise.resolve();
  },
}));

const acceptEulaMock = vi.fn(() => Promise.resolve());
vi.mock("@/lib/server", () => ({
  getJavaVersion: (v: string) => (v.startsWith("1.16") ? 17 : 21),
  acceptEula: (...a: unknown[]) => (acceptEulaMock as (...x: unknown[]) => Promise<void>)(...a),
}));

const isJREInstalledMock = vi.fn();
const installJREMock = vi.fn();
vi.mock("@/lib/jre", () => ({
  getJREPath: (v: number) => Promise.resolve(`/appdata/runtime/java-${v}`),
  isJREInstalled: (...a: unknown[]) => isJREInstalledMock(...a),
  installJRE: (...a: unknown[]) => installJREMock(...a),
}));

const fetchLocalServerModsMock = vi.fn();
vi.mock("@/lib/modSync", () => ({
  fetchLocalServerMods: (...a: unknown[]) => fetchLocalServerModsMock(...a),
}));

const lib = await import("@/lib/cubicasePack");

beforeEach(() => {
  invokeMock.mockReset();
  files.clear();
  removed.length = 0;
  acceptEulaMock.mockClear();
  isJREInstalledMock.mockReset();
  installJREMock.mockReset();
  fetchLocalServerModsMock.mockReset();
});

const mod = (filename: string, source: "modrinth" | "unknown", url: string | null = `https://cdn/${filename}`) => ({
  filename,
  size_bytes: 10,
  sha1: `sha-${filename}`,
  source,
  url: source === "modrinth" ? url : null,
});

describe("packFileName", () => {
  it("troca caracteres proibidos, corta ponto/espaço no fim e sempre termina em .cubicase", () => {
    expect(lib.packFileName("Meu Servidor")).toBe("Meu Servidor.cubicase");
    expect(lib.packFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j.cubicase");
    expect(lib.packFileName("termina. . ")).toBe("termina.cubicase");
    expect(lib.packFileName("")).toBe("servidor.cubicase");
  });
  it("nomes reservados do Windows ganham prefixo", () => {
    expect(lib.packFileName("CON")).toBe("_CON.cubicase");
    expect(lib.packFileName("lpt1")).toBe("_lpt1.cubicase");
  });
  it("limita o tamanho do nome", () => {
    expect(lib.packFileName("x".repeat(300)).length).toBe(80 + ".cubicase".length);
  });
});

describe("uniqueServerName", () => {
  it("mantém o nome se livre e numera se colidir (sem diferenciar maiúsculas)", () => {
    expect(lib.uniqueServerName("Mundo", [])).toBe("Mundo");
    expect(lib.uniqueServerName("Mundo", ["mundo"])).toBe("Mundo-2");
    expect(lib.uniqueServerName("Mundo", ["Mundo", "Mundo-2", "MUNDO-3"])).toBe("Mundo-4");
  });
  it("limpa caracteres inválidos e usa um padrão se vazio", () => {
    expect(lib.uniqueServerName("a:b", [])).toBe("a_b");
    expect(lib.uniqueServerName("  ", [])).toBe("Servidor");
  });
});

describe("pickPackMeta", () => {
  it("leva só os campos permitidos — nunca uuid, shortCode ou wake-on-demand", () => {
    const meta = lib.pickPackMeta(
      { uuid: "U", shortCode: "ABC123", wakeOnDemandEnabled: true, idleTimeoutMinutes: 5, version: "1.20.1", serverType: "fabric", ramGb: 6, modLoaderVersion: "0.15", description: "d" },
      null,
      "vanilla",
    );
    expect(meta).toEqual({
      version: "1.20.1", serverType: "fabric", description: "d", ramGb: 6,
      serverJar: null, launchArgsDir: null, forgeVersion: null, modLoaderVersion: "0.15",
    });
    expect(JSON.stringify(meta)).not.toMatch(/uuid|shortCode|wake/i);
  });
  it("usa os fallbacks quando o meta não existe ou está inválido", () => {
    expect(lib.pickPackMeta(null, "1.19.4", "paper")).toMatchObject({ version: "1.19.4", serverType: "paper", ramGb: null });
    expect(lib.pickPackMeta("lixo", "1.19.4", "paper")).toMatchObject({ version: "1.19.4" });
    expect(lib.pickPackMeta({ ramGb: 1 }, null, "vanilla").ramGb).toBeNull();
  });
});

describe("splitModsForLightMode", () => {
  it("omite só o que o Modrinth reconhece; o resto fica no pacote", () => {
    const r = lib.splitModsForLightMode([mod("a.jar", "modrinth"), mod("b.jar", "unknown"), mod("c.jar", "modrinth")]);
    expect(r.omit.map((m) => m.filename)).toEqual(["a.jar", "c.jar"]);
    expect(r.omit[0]).toEqual({ filename: "a.jar", sha1: "sha-a.jar", url: "https://cdn/a.jar", sizeBytes: 10 });
    expect(r.kept).toBe(1);
    expect(r.unidentified).toBe(false);
  });
  it("marca 'não identificado' quando há mods mas nenhum foi reconhecido (provável falta de internet)", () => {
    const r = lib.splitModsForLightMode([mod("a.jar", "unknown"), mod("b.jar", "unknown")]);
    expect(r.omit).toEqual([]);
    expect(r.unidentified).toBe(true);
    expect(lib.splitModsForLightMode([]).unidentified).toBe(false);
  });
  it("nunca omite um mod sem URL/hash ou com nome de arquivo que escapa da pasta mods", () => {
    const r = lib.splitModsForLightMode([
      { ...mod("x.jar", "modrinth"), url: null },
      { ...mod("y.jar", "modrinth"), sha1: "" },
      mod("../evil.jar", "modrinth"),
      mod("sub\\z.jar", "modrinth"),
    ]);
    expect(r.omit).toEqual([]);
  });
});

describe("buildImportedMeta", () => {
  const manifest = {
    name: "Original", mode: "full", createdAt: "2026-01-01", meta: { version: "1.20.1", serverType: "forge", ramGb: 6, forgeVersion: "47.1.0", serverJar: null, launchArgsDir: "libraries/x" },
  } as unknown as import("@/lib/cubicasePack").PackManifest;

  it("gera identidade nova e desliga wake-on-demand", () => {
    const meta = lib.buildImportedMeta(manifest, "Novo", { uuid: "NEW-UUID", shortCode: "ZZZ999" }, "2026-02-02");
    expect(meta).toMatchObject({
      uuid: "NEW-UUID", shortCode: "ZZZ999", name: "Novo", version: "1.20.1", serverType: "forge", ramGb: 6,
      forgeVersion: "47.1.0", launchArgsDir: "libraries/x", wakeOnDemandEnabled: false, idleTimeoutMinutes: null, createdAt: "2026-02-02",
      importedFromPack: { name: "Original", mode: "full", createdAt: "2026-01-01" },
    });
  });
  it("omite ramGb quando o pacote não tem", () => {
    const m = { ...manifest, meta: { version: "1.20.1" } } as unknown as import("@/lib/cubicasePack").PackManifest;
    expect(lib.buildImportedMeta(m, "N", { uuid: "u", shortCode: "c" })).not.toHaveProperty("ramGb");
  });
});

describe("generateShortCode / packPercent", () => {
  it("gera 6 caracteres base36 maiúsculos", () => {
    expect(lib.generateShortCode(() => 0)).toBe("000000");
    expect(lib.generateShortCode(() => 0.999)).toBe("ZZZZZZ");
    expect(lib.generateShortCode()).toMatch(/^[0-9A-Z]{6}$/);
  });
  it("calcula a porcentagem sem nunca chegar a 100 antes do fim", () => {
    expect(lib.packPercent({ doneBytes: 0, totalBytes: 0, phase: "writing" })).toBe(0);
    expect(lib.packPercent({ doneBytes: 50, totalBytes: 100, phase: "writing" })).toBe(49);
    expect(lib.packPercent({ doneBytes: 100, totalBytes: 100, phase: "writing" })).toBe(98);
    expect(lib.packPercent({ doneBytes: 100, totalBytes: 100, phase: "verifying" })).toBe(99);
    expect(lib.packPercent({ doneBytes: 100, totalBytes: 100, phase: "done" })).toBe(100);
  });
});

describe("pendências (completePending)", () => {
  const dir = "/docs/CubicaseServers/S";
  const pendingFile = `${dir}/cubicase-pending.json`;
  const m = (f: string) => ({ filename: f, sha1: `sha-${f}`, url: `https://cdn/${f}`, sizeBytes: 1 });

  it("readPending: sem arquivo, arquivo ilegível ou lista vazia = sem pendência", async () => {
    expect(await lib.readPending(dir)).toBeNull();
    files.set(pendingFile, "lixo");
    expect(await lib.readPending(dir)).toBeNull();
    files.set(pendingFile, JSON.stringify({ version: 1, mods: [] }));
    expect(await lib.readPending(dir)).toBeNull();
  });

  it("baixa tudo e apaga o arquivo de pendência quando não sobra nada", async () => {
    files.set(pendingFile, JSON.stringify({ version: 1, mods: [m("a.jar"), m("b.jar")] }));
    invokeMock.mockResolvedValue(undefined);
    const res = await lib.completePending(dir);
    expect(res).toEqual({ remaining: [], downloaded: 2 });
    expect(invokeMock).toHaveBeenCalledWith("download_mod_file", { url: "https://cdn/a.jar", destPath: `${dir}/mods/a.jar`, expectedSha1: "sha-a.jar" });
    expect(files.has(pendingFile)).toBe(false);
  });

  it("o que falhar (sem internet) continua pendente, sem lançar erro", async () => {
    files.set(pendingFile, JSON.stringify({ version: 1, mods: [m("a.jar"), m("b.jar"), m("c.jar")] }));
    invokeMock.mockImplementation((_cmd: string, args: { url: string }) =>
      args.url.endsWith("b.jar") ? Promise.reject("sem rede") : Promise.resolve());
    const res = await lib.completePending(dir);
    expect(res.downloaded).toBe(2);
    expect(res.remaining.map((x) => x.filename)).toEqual(["b.jar"]);
    expect(JSON.parse(files.get(pendingFile)!).mods.map((x: { filename: string }) => x.filename)).toEqual(["b.jar"]);
  });

  it("mod que já está na pasta conta como baixado sem baixar de novo", async () => {
    files.set(pendingFile, JSON.stringify({ version: 1, mods: [m("a.jar")] }));
    files.set(`${dir}/mods/a.jar`, "x");
    const res = await lib.completePending(dir);
    expect(res).toEqual({ remaining: [], downloaded: 1 });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("prepareExport", () => {
  const base = { serverDir: "/s", serverName: "S", serverType: "fabric", mcVersion: "1.20.1", includePlayerLists: false };

  it("recusa exportar um servidor com importação pendente", async () => {
    files.set("/s/cubicase-pending.json", JSON.stringify({ version: 1, mods: [{ filename: "a.jar", sha1: "x", url: "u", sizeBytes: 1 }] }));
    await expect(lib.prepareExport({ ...base, mode: "light" })).rejects.toThrow(/pendentes/);
  });

  it("modo completo: usa o Java já instalado e manda a pasta dele", async () => {
    isJREInstalledMock.mockResolvedValue(true);
    const r = await lib.prepareExport({ ...base, mode: "full" });
    expect(r.base.jreDir).toBe("/appdata/runtime/java-21");
    expect(r.base.javaVersion).toBe(21);
    expect(r.base.omitMods).toEqual([]);
    expect(r.base.appVersion).toBe("9.9.9");
    expect(installJREMock).not.toHaveBeenCalled();
  });

  it("modo completo: baixa o Java se faltar, e explica se não der (sem internet)", async () => {
    isJREInstalledMock.mockResolvedValue(false);
    installJREMock.mockResolvedValue(undefined);
    await lib.prepareExport({ ...base, mode: "full" });
    expect(installJREMock).toHaveBeenCalledWith(21, expect.any(Function));

    installJREMock.mockRejectedValue(new Error("offline"));
    await expect(lib.prepareExport({ ...base, mode: "full" })).rejects.toThrow(/modo Leve/);
  });

  it("modo leve: omite mods do Modrinth, não leva Java e lê a versão do meta do servidor", async () => {
    files.set("/s/cubicase-meta.json", JSON.stringify({ version: "1.16.5", ramGb: 8, uuid: "U", shortCode: "ABC123" }));
    fetchLocalServerModsMock.mockResolvedValue([mod("a.jar", "modrinth"), mod("b.jar", "unknown")]);
    const r = await lib.prepareExport({ ...base, mode: "light" });
    expect(r.base.jreDir).toBeNull();
    expect(r.base.javaVersion).toBe(17);
    expect(r.base.meta).toMatchObject({ version: "1.16.5", ramGb: 8 });
    expect(JSON.stringify(r.base.meta)).not.toMatch(/uuid|shortCode/);
    expect(r.omittedModCount).toBe(1);
    expect(r.modsUnidentified).toBe(false);
  });

  it("modo leve: se a identificação falhar, TODOS os mods vão no pacote e a UI é avisada", async () => {
    fetchLocalServerModsMock.mockRejectedValue(new Error("offline"));
    const r = await lib.prepareExport({ ...base, mode: "light" });
    expect(r.base.omitMods).toEqual([]);
    expect(r.modsUnidentified).toBe(true);
  });
});

describe("importPack", () => {
  const manifest = (over: Partial<import("@/lib/cubicasePack").PackManifest> = {}) =>
    ({
      formatVersion: 1, kind: "cubicase-pack", mode: "light", name: "Pack", createdAt: "2026-01-01", appVersion: "1",
      meta: { version: "1.20.1", serverType: "fabric", ramGb: 4 }, javaVersion: 21, includesJre: false, includesPlayerLists: false,
      fileCount: 1, totalBytes: 1, omittedMods: [], ...over,
    }) as import("@/lib/cubicasePack").PackManifest;

  const serverPath = "/docs/CubicaseServers/Novo";
  const progress = vi.fn();

  function backend(importResult: Record<string, unknown> = {}) {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pack_cleanup_stale") return Promise.resolve(0);
      if (cmd === "pack_import") return Promise.resolve({ serverPath, jreInstalled: false, jreWarning: null, manifest: manifest(), ...importResult });
      return Promise.resolve();
    });
  }

  it("pacote completo: recria o meta com identidade nova, aceita o EULA e não deixa pendência", async () => {
    backend({ jreInstalled: true });
    const res = await lib.importPack({ packPath: "/p.cubicase", folderName: "Novo", manifest: manifest({ mode: "full", includesJre: true }), onProgress: progress });
    expect(res.jre).toBe("included");
    expect(res.modsPending).toBe(0);
    const meta = JSON.parse(files.get(`${serverPath}/cubicase-meta.json`)!);
    expect(meta.uuid).toMatch(/[0-9a-f-]{36}/);
    expect(meta.shortCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(meta.name).toBe("Novo");
    expect(acceptEulaMock).toHaveBeenCalledWith(serverPath);
    expect(files.has(`${serverPath}/cubicase-pending.json`)).toBe(false);
    const req = invokeMock.mock.calls.find((c) => c[0] === "pack_import")![1].req;
    expect(req).toMatchObject({ packPath: "/p.cubicase", parentDir: "/docs/CubicaseServers", folderName: "Novo", jreDest: "/appdata/runtime/java-21" });
  });

  it("pacote leve sem internet: servidor importado, mods pendentes e Java adiado — sem falhar", async () => {
    backend();
    isJREInstalledMock.mockResolvedValue(false);
    installJREMock.mockRejectedValue(new Error("offline"));
    const omitted = [{ filename: "a.jar", sha1: "s", url: "https://cdn/a.jar", sizeBytes: 1 }];
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "pack_cleanup_stale") return Promise.resolve(0);
      if (cmd === "pack_import") return Promise.resolve({ serverPath, jreInstalled: false, jreWarning: null, manifest: manifest() });
      if (cmd === "download_mod_file") return Promise.reject("sem rede");
      return Promise.resolve(args);
    });
    const res = await lib.importPack({ packPath: "/p.cubicase", folderName: "Novo", manifest: manifest({ omittedMods: omitted }), onProgress: progress });
    expect(res).toMatchObject({ jre: "pending", modsOmitted: 1, modsDownloaded: 0, modsPending: 1 });
    expect(JSON.parse(files.get(`${serverPath}/cubicase-pending.json`)!).mods).toHaveLength(1);
    expect(removed).not.toContain(serverPath);
  });

  it("pacote leve com internet: baixa os mods e o Java", async () => {
    backend();
    isJREInstalledMock.mockResolvedValue(false);
    installJREMock.mockResolvedValue(undefined);
    const omitted = [{ filename: "a.jar", sha1: "s", url: "https://cdn/a.jar", sizeBytes: 1 }];
    const res = await lib.importPack({ packPath: "/p.cubicase", folderName: "Novo", manifest: manifest({ omittedMods: omitted }), onProgress: progress });
    expect(res).toMatchObject({ jre: "downloaded", modsDownloaded: 1, modsPending: 0 });
    expect(files.has(`${serverPath}/cubicase-pending.json`)).toBe(false);
  });

  it("Java já instalado no PC é reaproveitado", async () => {
    backend();
    isJREInstalledMock.mockResolvedValue(true);
    const res = await lib.importPack({ packPath: "/p.cubicase", folderName: "Novo", manifest: manifest(), onProgress: progress });
    expect(res.jre).toBe("present");
    expect(installJREMock).not.toHaveBeenCalled();
  });

  it("erro do backend (pacote hostil, sem espaço…) é propagado e nada é apagado pelo TS", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pack_import" ? Promise.reject("Pacote recusado") : Promise.resolve(0));
    await expect(lib.importPack({ packPath: "/p", folderName: "Novo", manifest: manifest(), onProgress: progress })).rejects.toBe("Pacote recusado");
    expect(removed).toEqual([]);
  });

  it("falha no pós-processamento remove o servidor recém-importado (nada pela metade)", async () => {
    backend();
    acceptEulaMock.mockRejectedValueOnce(new Error("disco"));
    await expect(lib.importPack({ packPath: "/p", folderName: "Novo", manifest: manifest(), onProgress: progress })).rejects.toThrow("disco");
    expect(removed).toContain(serverPath);
  });
});
