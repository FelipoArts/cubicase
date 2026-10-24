// ============================================================
// Atualização de versão de um servidor (Minecraft e/ou loader)
// ============================================================
// Fluxo (o assistente em src/app/components/host/ServerUpgradeWizard.tsx só chama isto):
//   1. loadUpgradeOptions → o que dá para atualizar (build nova do mesmo Minecraft, ou versões mais novas);
//   2. resolveLoaderTarget → qual build do loader serve para a versão escolhida;
//   3. analyzeMods → o que acontece com cada mod/plugin (mantém, atualiza sozinho, sem versão, não verificado);
//   4. runServerUpgrade → backup opcional, downloads para uma pasta de PREPARO, e só então a troca de arquivos
//      (comando Rust `commit_server_upgrade`, tudo-ou-nada, com desfazer automático).
//
// Regra de ouro: nada do servidor é alterado antes do commit. Antes dele, qualquer falha só apaga a pasta de
// preparo. (Única exceção: o instalador do Forge/NeoForge escreve em libraries/, mas só ACRESCENTA — a versão
// antiga continua intacta — e o cubicase-meta.json, que decide qual versão vale, é o último passo do commit.)
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { t as tn } from "@/i18n";
import {
  fetchVersionManifest,
  fetchMavenSha1,
  FABRIC_SERVER_JAR_NAME,
  getAllReleaseVersions,
  getBackupsDir,
  getFabricInstallerVersions,
  getFabricLoaderVersions,
  getForgeVersions,
  getJavaVersion,
  getMinecraftServerUrl,
  getPaperBuilds,
  getProviderByName,
  pickStable,
  urlExists,
  type ForgeBuild,
  type PaperBuild,
  type ServerInfo,
} from "@/lib/server";
import {
  getModrinthProjectTitle,
  getProjectVersionsFor,
  latestCompatibleByHashes,
  lookupVersionsByHashes,
  readModInstallRegistry,
  writeModInstallRegistry,
  type ModrinthVersion,
} from "@/lib/modrinth";

export const UPGRADE_STAGING_DIR = ".cubicase-upgrade";
/** Prefixo que o backend põe na mensagem quando o desfazer automático ficou incompleto (ver upgrade.rs). */
export const ROLLBACK_FAILED_MARK = "[ROLLBACK_FAILED] ";

export type UpgradableType = "vanilla" | "paper" | "fabric" | "forge" | "neoforge";
const UPGRADABLE_TYPES: readonly string[] = ["vanilla", "paper", "fabric", "forge", "neoforge"];

// ------------------------------------------------------------
// Versões
// ------------------------------------------------------------

/** Compara números separados por ponto ("1.20.4" × "1.21", "47.2.0" × "47.10"): <0, 0 ou >0. Segmento não numérico vale 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** O servidor pode ser atualizado por aqui? (tipo conhecido e versão do Minecraft legível) */
export function isUpgradeSupported(info: Pick<ServerInfo, "serverType" | "version">): boolean {
  return UPGRADABLE_TYPES.includes(info.serverType) && !!info.version && /^\d+(\.\d+)+$/.test(info.version);
}

/** O que será instalado: o Minecraft e (conforme o tipo) o loader. */
export interface LoaderTarget {
  serverType: UpgradableType;
  mcVersion: string;
  /** Fabric: versão do loader; Forge/NeoForge: versão da build; Paper: número da build (texto); Vanilla: null. */
  loaderVersion: string | null;
  paperBuild?: PaperBuild;
  forgeBuild?: ForgeBuild;
  /** Texto para a interface: "Paper 1.21.4 (build 211)". */
  label: string;
}

export const TYPE_LABELS: Record<UpgradableType, string> = {
  vanilla: "Vanilla",
  paper: "Paper",
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

function labelFor(type: UpgradableType, mc: string, loaderVersion: string | null): string {
  const name = TYPE_LABELS[type];
  if (type === "vanilla" || !loaderVersion) return `${name} ${mc}`;
  if (type === "paper") return `${name} ${mc} (build ${loaderVersion})`;
  return `${name} ${mc} (${loaderVersion})`;
}

/** Qual build do loader instalar para `mcVersion`. `null` = esse loader não existe para essa versão (ou sem internet). */
export async function resolveLoaderTarget(type: UpgradableType, mcVersion: string): Promise<LoaderTarget | null> {
  switch (type) {
    case "vanilla": {
      try {
        await getMinecraftServerUrl(mcVersion);
      } catch {
        return null;
      }
      return { serverType: type, mcVersion, loaderVersion: null, label: labelFor(type, mcVersion, null) };
    }
    case "paper": {
      const builds = await getPaperBuilds(mcVersion);
      const pick = builds.find((b) => b.recommended) ?? builds[0];
      if (!pick) return null;
      return { serverType: type, mcVersion, loaderVersion: String(pick.build), paperBuild: pick, label: labelFor(type, mcVersion, String(pick.build)) };
    }
    case "fabric": {
      const builds = await getFabricLoaderVersions(mcVersion);
      const pick = pickStable(builds.map((b) => ({ ...b })));
      if (!pick) return null;
      return { serverType: type, mcVersion, loaderVersion: pick.loaderVersion, label: labelFor(type, mcVersion, pick.loaderVersion) };
    }
    case "forge":
    case "neoforge": {
      const builds = (await getForgeVersions(mcVersion)).filter((b) => b.provider === type);
      if (builds.length === 0) return null;
      // Recomendada primeiro; senão a de número mais alto (a ordem da lista não é garantida entre provedores).
      const best = builds.find((b) => b.recommended) ?? [...builds].sort((a, b) => compareVersions(b.forgeVersion, a.forgeVersion))[0];
      return { serverType: type, mcVersion, loaderVersion: best.forgeVersion, forgeBuild: best, label: labelFor(type, mcVersion, best.forgeVersion) };
    }
  }
}

export interface UpgradeOptions {
  /** Uma build mais nova do MESMO Minecraft (null = já está na última, ou o tipo não tem builds). */
  sameVersion: LoaderTarget | null;
  /** Versões do Minecraft mais novas que a atual (mais recente primeiro). */
  newerVersions: string[];
}

/** Versão do loader instalada hoje, no mesmo formato de `LoaderTarget.loaderVersion`. */
export function installedLoaderVersion(info: Pick<ServerInfo, "serverType" | "forgeVersion" | "modLoaderVersion">): string | null {
  return info.serverType === "forge" || info.serverType === "neoforge" ? info.forgeVersion : info.modLoaderVersion;
}

export async function loadUpgradeOptions(info: ServerInfo): Promise<UpgradeOptions> {
  const type = info.serverType as UpgradableType;
  const current = info.version!;
  const manifest = await fetchVersionManifest();
  const newerVersions = getAllReleaseVersions(manifest).filter((v) => compareVersions(v, current) > 0);

  let sameVersion: LoaderTarget | null = null;
  if (type !== "vanilla") {
    const latest = await resolveLoaderTarget(type, current);
    const installed = installedLoaderVersion(info);
    if (latest && latest.loaderVersion && installed && compareVersions(latest.loaderVersion, installed) > 0) {
      sameVersion = latest;
    }
  }
  return { sameVersion, newerVersions };
}

// ------------------------------------------------------------
// Mods e plugins
// ------------------------------------------------------------

export type ModVerdict = "ok" | "update" | "incompatible" | "unknown";

export interface ModPlanItem {
  fileName: string;
  displayName: string;
  verdict: ModVerdict;
  /** Só em "update": a versão que substitui o arquivo atual. */
  newVersion?: ModrinthVersion;
}

export interface ModPlan {
  folder: "mods" | "plugins";
  items: ModPlanItem[];
  /** Dependências obrigatórias que as versões novas pedem e o servidor ainda não tem. */
  extras: { title: string; version: ModrinthVersion }[];
  /** Dependências obrigatórias sem versão compatível (só aviso). */
  missingDeps: string[];
  /** A consulta à Modrinth falhou: tudo ficou "não verificado" (não é o mesmo que incompatível). */
  analysisFailed: boolean;
}

interface ListedMod {
  file_name: string;
  display_name: string;
  enabled: boolean;
}

/** Loaders da Modrinth que servem para cada tipo (plugins aceitam as três famílias). */
export function modrinthLoadersFor(type: UpgradableType): string[] {
  if (type === "paper") return ["paper", "spigot", "bukkit"];
  return [type];
}

export function modsFolderFor(type: UpgradableType): "mods" | "plugins" | null {
  if (type === "paper") return "plugins";
  if (type === "fabric" || type === "forge" || type === "neoforge") return "mods";
  return null; // vanilla não tem mods
}

function primaryFile(v: ModrinthVersion) {
  return v.files.find((f) => f.primary) ?? v.files[0];
}

/** Classifica cada mod ativo: serve como está, tem versão nova, não tem versão para o alvo, ou não foi possível verificar. */
export async function analyzeMods(info: ServerInfo, target: LoaderTarget): Promise<ModPlan | null> {
  const folder = modsFolderFor(target.serverType);
  if (!folder) return null;

  const listed = (await invoke<ListedMod[]>("list_mods", { serverDir: info.path, folderName: folder })).filter((m) => m.enabled);
  const plan: ModPlan = { folder, items: [], extras: [], missingDeps: [], analysisFailed: false };
  if (listed.length === 0) return plan;

  // SHA-1 de cada arquivo (em lotes, para não inundar o IPC).
  const hashes = new Map<string, string>(); // arquivo -> hash
  for (let i = 0; i < listed.length; i += 8) {
    await Promise.all(
      listed.slice(i, i + 8).map(async (m) => {
        try {
          hashes.set(m.file_name, (await invoke<string>("compute_file_sha1", { path: await join(info.path, folder, m.file_name) })).toLowerCase());
        } catch {
          /* arquivo ilegível: fica "não verificado" */
        }
      })
    );
  }

  const loaders = modrinthLoadersFor(target.serverType);
  const identified = await lookupVersionsByHashes([...hashes.values()]);
  let latest = new Map<string, ModrinthVersion>();
  try {
    latest = await latestCompatibleByHashes([...identified.keys()], loaders, target.mcVersion);
  } catch {
    plan.analysisFailed = true;
  }

  const installedProjects = new Set<string>();
  for (const m of listed) {
    const hash = hashes.get(m.file_name);
    const current = hash ? identified.get(hash) : undefined;
    const item: ModPlanItem = { fileName: m.file_name, displayName: m.display_name, verdict: "unknown" };
    if (current) installedProjects.add(current.project_id);
    if (current && hash && !plan.analysisFailed) {
      const best = latest.get(hash);
      if (!best) {
        item.verdict = "incompatible";
      } else if (best.id === current.id || (current.game_versions.includes(target.mcVersion) && current.loaders.some((l) => loaders.includes(l)))) {
        item.verdict = "ok"; // a versão instalada já serve para o alvo
      } else if (primaryFile(best)) {
        item.verdict = "update";
        item.newVersion = best;
      } else {
        item.verdict = "incompatible";
      }
    }
    plan.items.push(item);
  }

  // Dependências obrigatórias das versões novas que ainda não estão no servidor.
  if (!plan.analysisFailed) {
    const wanted = new Set<string>();
    for (const it of plan.items) {
      for (const d of it.newVersion?.dependencies ?? []) {
        if (d.dependency_type === "required" && d.project_id && !installedProjects.has(d.project_id)) wanted.add(d.project_id);
      }
    }
    for (const projectId of [...wanted].slice(0, 40)) {
      let title = projectId;
      try {
        title = await getModrinthProjectTitle(projectId);
        const versions = await getProjectVersionsFor(projectId, loaders, target.mcVersion);
        const pick = versions[0];
        if (pick && primaryFile(pick)) plan.extras.push({ title, version: pick });
        else plan.missingDeps.push(title);
      } catch {
        plan.missingDeps.push(title);
      }
    }
  }
  return plan;
}

export function summarizeModPlan(plan: ModPlan | null) {
  const count = (v: ModVerdict) => plan?.items.filter((i) => i.verdict === v).length ?? 0;
  return { ok: count("ok"), update: count("update"), incompatible: count("incompatible"), unknown: count("unknown"), extras: plan?.extras.length ?? 0 };
}

// ------------------------------------------------------------
// Execução
// ------------------------------------------------------------

export type UpgradeStep = "prepare" | "backup" | "loader" | "mods" | "apply" | "done";

export interface UpgradeProgress {
  step: UpgradeStep;
  percent: number;
  message: string;
}

export interface UpgradeRequest {
  info: ServerInfo;
  target: LoaderTarget;
  modPlan: ModPlan | null;
  /** Desativar (renomear para .disabled) os mods sem versão para o alvo. */
  disableIncompatible: boolean;
  /** Backup completo do servidor antes de mexer em qualquer coisa. */
  fullBackup: boolean;
}

export interface UpgradeOutcome {
  backupFile: string | null;
  updatedMods: number;
  addedMods: number;
  disabledMods: number;
}

interface StagedLoader {
  loader?: { stagedName: string; finalName: string; retire: string[] };
  metaPatch: Record<string, string | null>;
}

async function download(url: string, destPath: string, sha1: string | null, sha256: string | null = null) {
  await invoke("download_server_jar", { url, destPath, expectedSha1: sha1, expectedSha256: sha256 });
}

/** Prepara os arquivos do loader novo SEM tocar no servidor (exceto Forge/NeoForge, que só acrescenta em libraries/). */
async function stageLoader(info: ServerInfo, target: LoaderTarget, onMessage: (m: string, pct: number) => void): Promise<StagedLoader> {
  const stageDir = await join(info.path, UPGRADE_STAGING_DIR, "loader");
  const mc = target.mcVersion;
  onMessage(tn("upgrade.step.loader", { what: target.label }), 30);

  switch (target.serverType) {
    case "vanilla": {
      const { url, sha1 } = await getMinecraftServerUrl(mc);
      await download(url, await join(stageDir, "server.jar"), sha1);
      return { loader: { stagedName: "server.jar", finalName: "server.jar", retire: [] }, metaPatch: { version: mc, serverJar: "server.jar", launchArgsDir: null } };
    }
    case "paper": {
      const build = target.paperBuild;
      if (!build) throw new Error(tn("upgrade.err.noBuild", { what: target.label }));
      await download(build.downloadUrl, await join(stageDir, build.jarName), null, build.sha256);
      const old = info.serverJar && info.serverJar.toLowerCase().endsWith(".jar") ? [info.serverJar] : [];
      return {
        loader: { stagedName: build.jarName, finalName: build.jarName, retire: old },
        metaPatch: { version: mc, modLoaderVersion: String(build.build), serverJar: build.jarName, launchArgsDir: null },
      };
    }
    case "fabric": {
      const installer = pickStable(await getFabricInstallerVersions());
      if (!installer || !target.loaderVersion) throw new Error(tn("srv.err.fabricInstaller"));
      const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(target.loaderVersion)}/${encodeURIComponent(installer.version)}/server/jar`;
      await download(url, await join(stageDir, FABRIC_SERVER_JAR_NAME), null);
      return {
        loader: { stagedName: FABRIC_SERVER_JAR_NAME, finalName: FABRIC_SERVER_JAR_NAME, retire: [] },
        metaPatch: { version: mc, modLoaderVersion: target.loaderVersion, serverJar: FABRIC_SERVER_JAR_NAME, launchArgsDir: null },
      };
    }
    case "forge":
    case "neoforge":
      return await stageForge(info, target, onMessage);
  }
}

/** Forge/NeoForge: roda o instalador do servidor NA PASTA do servidor (é assim que se atualiza um Forge) e acha como iniciar. */
async function stageForge(info: ServerInfo, target: LoaderTarget, onMessage: (m: string, pct: number) => void): Promise<StagedLoader> {
  const type = target.serverType as "forge" | "neoforge";
  const mc = target.mcVersion;
  const ver = target.loaderVersion;
  if (!ver) throw new Error(tn("upgrade.err.noBuild", { what: target.label }));
  const loaderName = TYPE_LABELS[type];

  const provider = getProviderByName(type);
  const installerUrl = provider.getInstallerUrl(mc, ver);
  if (!(await urlExists(installerUrl))) throw new Error(tn("srv.err.forgeUnavailable", { loader: loaderName, forgeVersion: ver, mc }));

  // Java da versão nova (o instalador roda com ele).
  const javaVer = getJavaVersion(mc);
  const { getJREPath, isJREInstalled, installJRE } = await import("@/lib/jre");
  if (!(await isJREInstalled(javaVer))) {
    onMessage(tn("srv.progress.downloadingJava", { java: javaVer }), 35);
    await installJRE(javaVer, () => {});
  }
  const javaExe = await join(await getJREPath(javaVer), "bin", "java.exe");

  const installerPath = await join(info.path, "forge-installer.jar");
  const jvmArgsPath = await join(info.path, "user_jvm_args.txt");
  // O instalador pode reescrever o user_jvm_args.txt (flags do usuário): guarda e devolve depois.
  let savedJvmArgs: string | null = null;
  try {
    if (await exists(jvmArgsPath)) savedJvmArgs = await readTextFile(jvmArgsPath);
  } catch { /* sem o arquivo */ }

  try {
    onMessage(tn("upgrade.step.forge", { what: target.label }), 40);
    await download(installerUrl, installerPath, await fetchMavenSha1(installerUrl));
    await invoke("run_forge_installer", { javaPath: javaExe, installerPath });
  } finally {
    await remove(installerPath).catch(() => {});
    if (savedJvmArgs !== null) await writeTextFile(jvmArgsPath, savedJvmArgs).catch(() => {});
  }

  const launch = await findForgeLaunch(info.path, type, mc, ver);
  if (!launch) throw new Error(tn("upgrade.err.forgeLaunch", { loader: loaderName }));
  return {
    metaPatch: {
      version: mc,
      forgeVersion: ver,
      serverJar: launch.mode === "jar" ? launch.jarName : null,
      launchArgsDir: launch.mode === "argfile" ? launch.argsDir : null,
    },
  };
}

/**
 * Como iniciar a build RECÉM-instalada. Com mais de uma versão em libraries/ (a antiga continua lá) não dá para
 * "achar qualquer win_args.txt": procura exatamente a pasta da versão pedida.
 */
export async function findForgeLaunch(
  serverPath: string,
  type: "forge" | "neoforge",
  mc: string,
  ver: string
): Promise<{ mode: "argfile"; argsDir: string } | { mode: "jar"; jarName: string } | null> {
  const candidates =
    type === "forge"
      ? [`libraries/net/minecraftforge/forge/${mc}-${ver}`]
      : [`libraries/net/neoforged/neoforge/${ver}`, `libraries/net/neoforged/forge/${mc}-${ver}`];
  for (const rel of candidates) {
    const dir = await join(serverPath, ...rel.split("/"));
    for (const argsFile of ["win_args.txt", "unix_args.txt"]) {
      if (await exists(await join(dir, argsFile))) return { mode: "argfile", argsDir: rel };
    }
  }
  // Forge antigo (1.16 e anterior): jar na raiz.
  try {
    const names = (await readDir(serverPath)).filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith(".jar")).map((e) => e.name);
    const prefix = `forge-${mc}-${ver}`.toLowerCase();
    const matches = names.filter((n) => n.toLowerCase().startsWith(prefix) && !n.toLowerCase().includes("installer"));
    const pick = matches.find((n) => /shim\.jar$/i.test(n)) ?? matches.find((n) => /universal\.jar$/i.test(n)) ?? matches[0];
    if (pick) return { mode: "jar", jarName: pick };
  } catch { /* pasta ilegível */ }
  return null;
}

/** Faz a atualização inteira. Em qualquer falha, o servidor continua como estava (ver o cabeçalho do arquivo). */
export async function runServerUpgrade(req: UpgradeRequest, onProgress: (p: UpgradeProgress) => void): Promise<UpgradeOutcome> {
  const { info, target, modPlan } = req;
  const report = (step: UpgradeStep, percent: number, message: string) => onProgress({ step, percent, message });
  const outcome: UpgradeOutcome = { backupFile: null, updatedMods: 0, addedMods: 0, disabledMods: 0 };

  report("prepare", 2, tn("upgrade.step.prepare"));
  await invoke("begin_server_upgrade", { serverDir: info.path });
  try {
    if (req.fullBackup) {
      report("backup", 6, tn("upgrade.step.backup"));
      const backupsDir = await getBackupsDir(info.name);
      const made = await invoke<{ file_name: string }>("backup_server_full", { serverDir: info.path, backupsDir });
      outcome.backupFile = made.file_name;
    }

    const staged = await stageLoader(info, target, (m, pct) => report("loader", pct, m));

    // Mods: tudo baixado para a pasta de preparo antes de qualquer troca.
    const installs: { fileName: string; version: ModrinthVersion }[] = [];
    const removals: string[] = [];
    const disables: string[] = [];
    if (modPlan) {
      for (const it of modPlan.items) {
        if (it.verdict === "update" && it.newVersion) {
          const f = primaryFile(it.newVersion);
          if (f) {
            installs.push({ fileName: f.filename, version: it.newVersion });
            removals.push(it.fileName);
          }
        } else if (it.verdict === "incompatible" && req.disableIncompatible) {
          disables.push(it.fileName);
        }
      }
      for (const extra of modPlan.extras) {
        const f = primaryFile(extra.version);
        if (f && !installs.some((i) => i.fileName.toLowerCase() === f.filename.toLowerCase())) {
          installs.push({ fileName: f.filename, version: extra.version });
        }
      }
      let i = 0;
      for (const ins of installs) {
        i++;
        const f = primaryFile(ins.version)!;
        report("mods", 55 + Math.round((i / installs.length) * 25), tn("upgrade.step.mods", { name: f.filename, i, n: installs.length }));
        await download(f.url, await join(info.path, UPGRADE_STAGING_DIR, modPlan.folder, f.filename), f.hashes.sha1 ?? null);
      }
    }

    report("apply", 85, tn("upgrade.step.apply"));
    await invoke("commit_server_upgrade", {
      commit: {
        serverDir: info.path,
        loader: staged.loader ?? null,
        itemsFolder: modPlan && (installs.length || removals.length || disables.length) ? modPlan.folder : null,
        modInstalls: installs.map((i) => i.fileName),
        modRemovals: removals,
        modDisables: disables,
        metaPatch: staged.metaPatch,
      },
    });
    outcome.updatedMods = removals.length;
    outcome.addedMods = installs.length - removals.length;
    outcome.disabledMods = disables.length;

    // Registro de proveniência dos mods (melhor esforço: não afeta o servidor).
    if (modPlan && installs.length > 0) {
      try {
        const registry = await readModInstallRegistry(info.path);
        for (const old of removals) delete registry[old];
        for (const ins of installs) {
          const f = primaryFile(ins.version)!;
          registry[f.filename] = {
            source: "modrinth",
            projectId: ins.version.project_id,
            versionId: ins.version.id,
            projectTitle: ins.version.name,
            versionNumber: ins.version.version_number,
            requiredDependencyProjectIds: ins.version.dependencies.filter((d) => d.dependency_type === "required" && !!d.project_id).map((d) => d.project_id as string),
          };
        }
        await writeModInstallRegistry(info.path, registry);
      } catch { /* só proveniência */ }
    }

    report("done", 100, tn("upgrade.step.done"));
    return outcome;
  } finally {
    // Solta a trava e apaga a pasta de preparo e a lixeira, com sucesso ou não.
    await invoke("end_server_upgrade", { serverDir: info.path }).catch(() => {});
  }
}
