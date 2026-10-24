import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/path", () => ({ join: (...p: string[]) => Promise.resolve(p.join("/")) }));

const existsMock = vi.fn();
const readDirMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (...a: unknown[]) => existsMock(...a),
  readDir: (...a: unknown[]) => readDirMock(...a),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
}));

const lookupMock = vi.fn();
const latestMock = vi.fn();
const projectVersionsMock = vi.fn();
vi.mock("@/lib/modrinth", () => ({
  lookupVersionsByHashes: (...a: unknown[]) => lookupMock(...a),
  latestCompatibleByHashes: (...a: unknown[]) => latestMock(...a),
  getProjectVersionsFor: (...a: unknown[]) => projectVersionsMock(...a),
  getModrinthProjectTitle: (id: string) => Promise.resolve(`Projeto ${id}`),
  readModInstallRegistry: () => Promise.resolve({}),
  writeModInstallRegistry: () => Promise.resolve(),
}));

vi.mock("@/lib/server", () => ({
  FABRIC_SERVER_JAR_NAME: "fabric-server-launch.jar",
  fetchVersionManifest: vi.fn(),
  fetchMavenSha1: vi.fn(),
  getAllReleaseVersions: vi.fn(),
  getBackupsDir: (n: string) => Promise.resolve(`/backups/${n}`),
  getFabricInstallerVersions: () => Promise.resolve([{ version: "1.1.2", stable: true }]),
  getFabricLoaderVersions: vi.fn(),
  getForgeVersions: vi.fn(),
  getJavaVersion: () => 17,
  getMinecraftServerUrl: vi.fn(),
  getPaperBuilds: vi.fn(),
  getProviderByName: vi.fn(),
  pickStable: <T extends { stable: boolean }>(l: T[]) => l.find((v) => v.stable) ?? l[0] ?? null,
  urlExists: vi.fn(),
}));

const { compareVersions, isUpgradeSupported, analyzeMods, findForgeLaunch, runServerUpgrade } = await import("@/lib/serverUpgrade");
import type { LoaderTarget, ModPlan } from "@/lib/serverUpgrade";
import type { ServerInfo } from "@/lib/server";

function ver(id: string, project: string, extra: Partial<{ game_versions: string[]; loaders: string[]; deps: string[]; file: string }> = {}) {
  return {
    id,
    project_id: project,
    version_number: id,
    name: `Mod ${project}`,
    game_versions: extra.game_versions ?? ["1.20.1"],
    loaders: extra.loaders ?? ["fabric"],
    dependencies: (extra.deps ?? []).map((p) => ({ project_id: p, version_id: null, dependency_type: "required" as const })),
    files: [{ url: `https://cdn.modrinth.com/${id}.jar`, filename: extra.file ?? `${id}.jar`, primary: true, hashes: { sha1: `sha-${id}` } }],
  };
}

const info = {
  name: "Amigos", path: "/srv/Amigos", version: "1.20.1", serverType: "fabric", serverJar: "fabric-server-launch.jar",
  forgeVersion: null, modLoaderVersion: "0.15.0",
} as unknown as ServerInfo;

const target: LoaderTarget = { serverType: "fabric", mcVersion: "1.20.4", loaderVersion: "0.15.3", label: "Fabric 1.20.4 (0.15.3)" };

beforeEach(() => {
  invokeMock.mockReset();
  existsMock.mockReset();
  readDirMock.mockReset();
  lookupMock.mockReset();
  latestMock.mockReset();
  projectVersionsMock.mockReset();
});

describe("versões", () => {
  it("compara números por segmento, não por texto", () => {
    expect(compareVersions("1.20.4", "1.20.1")).toBeGreaterThan(0);
    expect(compareVersions("1.21", "1.20.6")).toBeGreaterThan(0);
    expect(compareVersions("1.9", "1.10")).toBeLessThan(0);
    expect(compareVersions("47.10", "47.2.0")).toBeGreaterThan(0);
    expect(compareVersions("26.1", "1.21.4")).toBeGreaterThan(0);
    expect(compareVersions("1.20", "1.20.0")).toBe(0);
  });

  it("só servidores de tipo conhecido e com versão legível são atualizáveis", () => {
    expect(isUpgradeSupported({ serverType: "paper", version: "1.20.1" })).toBe(true);
    expect(isUpgradeSupported({ serverType: "neoforge", version: "21.1" })).toBe(true);
    expect(isUpgradeSupported({ serverType: "purpur", version: "1.20.1" })).toBe(false);
    expect(isUpgradeSupported({ serverType: "fabric", version: null })).toBe(false);
    expect(isUpgradeSupported({ serverType: "fabric", version: "snapshot" })).toBe(false);
  });
});

describe("analyzeMods", () => {
  it("classifica cada mod: serve, atualiza, sem versão e não verificado, e acrescenta dependências", async () => {
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "list_mods") {
        return Promise.resolve([
          { file_name: "serve.jar", display_name: "Serve", enabled: true },
          { file_name: "atualiza.jar", display_name: "Atualiza", enabled: true },
          { file_name: "semversao.jar", display_name: "Sem versão", enabled: true },
          { file_name: "fora.jar", display_name: "Fora da Modrinth", enabled: true },
          { file_name: "desligado.jar.disabled", display_name: "Desligado", enabled: false },
        ]);
      }
      if (cmd === "compute_file_sha1") return Promise.resolve(`H-${args.path!.split("/").pop()}`);
      throw new Error(`comando não mockado: ${cmd}`);
    });
    const vServe = ver("serve-old", "P1", { game_versions: ["1.20.1", "1.20.4"] });
    const vAtual = ver("atual-old", "P2");
    const vNova = ver("atual-new", "P2", { game_versions: ["1.20.4"], deps: ["DEP1", "P1"] });
    const vSem = ver("sem-old", "P3");
    lookupMock.mockResolvedValue(new Map([["h-serve.jar", vServe], ["h-atualiza.jar", vAtual], ["h-semversao.jar", vSem]]));
    latestMock.mockResolvedValue(new Map([["h-serve.jar", vServe], ["h-atualiza.jar", vNova]]));
    projectVersionsMock.mockResolvedValue([ver("dep-new", "DEP1", { game_versions: ["1.20.4"] })]);

    const plan = (await analyzeMods(info, target))!;
    const byFile = Object.fromEntries(plan.items.map((i) => [i.fileName, i.verdict]));
    expect(byFile).toEqual({ "serve.jar": "ok", "atualiza.jar": "update", "semversao.jar": "incompatible", "fora.jar": "unknown" });
    expect(plan.items.some((i) => i.fileName.includes("desligado"))).toBe(false); // desativados nem entram
    expect(plan.analysisFailed).toBe(false);
    // DEP1 é exigido e não está instalado; P1 já está (não duplica)
    expect(plan.extras.map((e) => e.version.id)).toEqual(["dep-new"]);
    expect(projectVersionsMock).toHaveBeenCalledTimes(1);
    expect(projectVersionsMock.mock.calls[0]).toEqual(["DEP1", ["fabric"], "1.20.4"]);
  });

  it("consulta que falha NÃO vira 'incompatível': tudo fica não verificado", async () => {
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "list_mods") return Promise.resolve([{ file_name: "a.jar", display_name: "A", enabled: true }]);
      return Promise.resolve(`H-${args.path}`);
    });
    lookupMock.mockResolvedValue(new Map([["h-/srv/amigos/mods/a.jar", ver("a-old", "P1")]]));
    latestMock.mockRejectedValue(new Error("HTTP 500"));
    const plan = (await analyzeMods(info, target))!;
    expect(plan.analysisFailed).toBe(true);
    expect(plan.items.map((i) => i.verdict)).toEqual(["unknown"]);
  });

  it("vanilla não tem mods: sem plano", async () => {
    expect(await analyzeMods({ ...info, serverType: "vanilla" } as ServerInfo, { ...target, serverType: "vanilla" })).toBeNull();
  });
});

describe("findForgeLaunch", () => {
  it("com duas versões em libraries/, escolhe exatamente a pedida (não a primeira que achar)", async () => {
    existsMock.mockImplementation((p: string) => Promise.resolve(p.endsWith("1.20.4-49.2.13/win_args.txt") || p.endsWith("1.20.1-47.3.0/win_args.txt")));
    const r = await findForgeLaunch("/srv/f", "forge", "1.20.4", "49.2.13");
    expect(r).toEqual({ mode: "argfile", argsDir: "libraries/net/minecraftforge/forge/1.20.4-49.2.13" });
  });

  it("Forge antigo: jar da versão certa na raiz, sem confundir com o instalador", async () => {
    existsMock.mockResolvedValue(false);
    readDirMock.mockResolvedValue([
      { name: "forge-1.12.2-14.23.5.2860-installer.jar", isDirectory: false },
      { name: "forge-1.12.2-14.23.5.2859.jar", isDirectory: false },
      { name: "forge-1.12.2-14.23.5.2860.jar", isDirectory: false },
    ]);
    expect(await findForgeLaunch("/srv/f", "forge", "1.12.2", "14.23.5.2860")).toEqual({ mode: "jar", jarName: "forge-1.12.2-14.23.5.2860.jar" });
    readDirMock.mockResolvedValue([]);
    expect(await findForgeLaunch("/srv/f", "forge", "1.12.2", "14.23.5.2860")).toBeNull();
  });
});

describe("runServerUpgrade", () => {
  const plan = (): ModPlan => ({
    folder: "mods",
    analysisFailed: false,
    missingDeps: [],
    extras: [{ title: "Dep", version: ver("dep-new", "DEP1", { game_versions: ["1.20.4"], file: "dep-new.jar" }) }],
    items: [
      { fileName: "atualiza-1.20.1.jar", displayName: "Atualiza", verdict: "update", newVersion: ver("atual-new", "P2", { game_versions: ["1.20.4"], file: "atualiza-1.20.4.jar" }) },
      { fileName: "semversao.jar", displayName: "Sem", verdict: "incompatible" },
      { fileName: "serve.jar", displayName: "Serve", verdict: "ok" },
      { fileName: "fora.jar", displayName: "Fora", verdict: "unknown" },
    ],
  });
  const cmds = () => invokeMock.mock.calls.map((c) => c[0] as string);

  it("backup → downloads para a pasta de preparo → UM commit com o plano certo → solta a trava", async () => {
    invokeMock.mockImplementation((cmd: string) => (cmd === "backup_server_full" ? Promise.resolve({ file_name: "ANTES-DE-ATUALIZAR_Amigos_1.zip" }) : Promise.resolve(undefined)));
    const out = await runServerUpgrade({ info, target, modPlan: plan(), disableIncompatible: true, fullBackup: true }, () => {});

    expect(cmds()[0]).toBe("begin_server_upgrade");
    expect(cmds()[1]).toBe("backup_server_full");
    expect(cmds().filter((c) => c === "commit_server_upgrade")).toHaveLength(1);
    expect(cmds()[cmds().length - 1]).toBe("end_server_upgrade");
    // todos os downloads aconteceram ANTES do commit, e só dentro da pasta de preparo
    const commitIdx = cmds().indexOf("commit_server_upgrade");
    const downloads = invokeMock.mock.calls.map((c, i) => ({ c, i })).filter(({ c }) => c[0] === "download_server_jar");
    expect(downloads.length).toBe(3); // launcher + 1 mod atualizado + 1 dependência
    for (const d of downloads) {
      expect(d.i).toBeLessThan(commitIdx);
      expect((d.c[1] as { destPath: string }).destPath).toContain("/.cubicase-upgrade/");
    }
    const commit = invokeMock.mock.calls[commitIdx][1].commit;
    expect(commit.serverDir).toBe("/srv/Amigos");
    expect(commit.itemsFolder).toBe("mods");
    expect(commit.modInstalls.sort()).toEqual(["atualiza-1.20.4.jar", "dep-new.jar"]);
    expect(commit.modRemovals).toEqual(["atualiza-1.20.1.jar"]);
    expect(commit.modDisables).toEqual(["semversao.jar"]);
    expect(commit.loader).toEqual({ stagedName: "fabric-server-launch.jar", finalName: "fabric-server-launch.jar", retire: [] });
    expect(commit.metaPatch).toMatchObject({ version: "1.20.4", modLoaderVersion: "0.15.3", serverJar: "fabric-server-launch.jar" });
    expect(out).toEqual({ backupFile: "ANTES-DE-ATUALIZAR_Amigos_1.zip", updatedMods: 1, addedMods: 1, disabledMods: 1 });
  });

  it("sem marcar 'desativar', os incompatíveis não são tocados; sem backup, não pede backup", async () => {
    invokeMock.mockResolvedValue(undefined);
    await runServerUpgrade({ info, target, modPlan: plan(), disableIncompatible: false, fullBackup: false }, () => {});
    expect(cmds()).not.toContain("backup_server_full");
    const commit = invokeMock.mock.calls.find((c) => c[0] === "commit_server_upgrade")![1].commit;
    expect(commit.modDisables).toEqual([]);
  });

  it("falha num download: NÃO faz commit, solta a trava e propaga o erro", async () => {
    invokeMock.mockImplementation((cmd: string, args: { destPath?: string }) => {
      if (cmd === "download_server_jar" && args.destPath?.endsWith("atualiza-1.20.4.jar")) return Promise.reject("HTTP 503");
      return Promise.resolve(undefined);
    });
    await expect(runServerUpgrade({ info, target, modPlan: plan(), disableIncompatible: true, fullBackup: false }, () => {})).rejects.toBeTruthy();
    expect(cmds()).not.toContain("commit_server_upgrade");
    expect(cmds()[cmds().length - 1]).toBe("end_server_upgrade");
  });

  it("falha ao começar (servidor rodando): nada acontece e a trava não é 'solta' por quem não a tinha", async () => {
    invokeMock.mockImplementation((cmd: string) => (cmd === "begin_server_upgrade" ? Promise.reject("parado") : Promise.resolve(undefined)));
    await expect(runServerUpgrade({ info, target, modPlan: null, disableIncompatible: false, fullBackup: true }, () => {})).rejects.toBeTruthy();
    expect(cmds()).toEqual(["begin_server_upgrade"]);
  });

  it("mesma versão do Minecraft (sem plano de mods): só troca o loader e o metadado", async () => {
    invokeMock.mockResolvedValue(undefined);
    await runServerUpgrade({ info, target: { ...target, mcVersion: "1.20.1" }, modPlan: null, disableIncompatible: false, fullBackup: false }, () => {});
    const commit = invokeMock.mock.calls.find((c) => c[0] === "commit_server_upgrade")![1].commit;
    expect(commit.itemsFolder).toBeNull();
    expect(commit.modInstalls).toEqual([]);
  });
});
