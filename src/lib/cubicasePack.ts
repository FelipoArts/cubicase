import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { documentDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { getJavaVersion, acceptEula } from "@/lib/server";
import { getJREPath, isJREInstalled, installJRE } from "@/lib/jre";
import { fetchLocalServerMods, type RemoteModEntry } from "@/lib/modSync";
import { t } from "@/i18n";

// ============================================================
// Pacotes .cubicase — lado TypeScript
// ============================================================
// O trabalho pesado (varrer, zipar, verificar, extrair com proteção contra
// arquivo hostil) é do backend (src-tauri/src/pack.rs). Aqui ficam: montar o
// pedido de exportação (metadados do servidor, Java, mods do Modrinth a
// omitir no modo leve), a pós-importação (meta novo com UUID/código NOVOS,
// EULA, mods que faltaram) e o estado "pendente" — um servidor importado de um
// pacote leve sem internet, que não pode iniciar até os mods serem baixados.
// ============================================================

export type PackMode = "full" | "light";

export interface OmittedMod {
  filename: string;
  sha1: string;
  url: string;
  sizeBytes: number;
}

export interface PackManifest {
  formatVersion: number;
  kind: string;
  mode: PackMode;
  name: string;
  createdAt: string;
  appVersion: string;
  meta: PackServerMeta;
  javaVersion: number | null;
  includesJre: boolean;
  includesPlayerLists: boolean;
  fileCount: number;
  totalBytes: number;
  omittedMods: OmittedMod[];
}

/** Subconjunto do cubicase-meta.json que viaja no manifesto (nunca uuid/shortCode/wake-on-demand). */
export interface PackServerMeta {
  version?: string | null;
  serverType?: string | null;
  description?: string | null;
  ramGb?: number | null;
  serverJar?: string | null;
  launchArgsDir?: string | null;
  forgeVersion?: string | null;
  modLoaderVersion?: string | null;
}

export interface PackProblem {
  code: string;
  message: string;
}

export interface PackPreflight {
  problems: PackProblem[];
  totalBytes: number;
  fileCount: number;
  omittedBytes: number;
  requiredBytes: number;
  freeBytes: number | null;
  destExists: boolean;
  hasWorld: boolean;
  skippedLinks: number;
}

export interface PackInspection {
  manifest: PackManifest;
  totalBytes: number;
  fileCount: number;
  archiveBytes: number;
  longestPath: number;
}

export interface ExportRequest {
  serverDir: string;
  destPath: string;
  mode: PackMode;
  name: string;
  meta: PackServerMeta;
  javaVersion: number | null;
  jreDir: string | null;
  includePlayerLists: boolean;
  omitMods: OmittedMod[];
  overwrite: boolean;
  appVersion: string;
}

export interface ExportOutcome {
  destPath: string;
  sizeBytes: number;
  fileCount: number;
  totalBytes: number;
}

/** Evento "cubicase-pack-progress" emitido pelo backend. */
export interface PackProgressEvent {
  job: "export" | "import";
  phase: string;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  current: string;
}

export interface PackUiProgress {
  phase: string;
  percent: number;
  current: string;
  doneFiles: number;
  totalFiles: number;
}

// ------------------------------------------------------------
// Funções puras (testadas em __tests__/cubicasePack.test.ts)
// ------------------------------------------------------------

const INVALID_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/** Nome de arquivo `.cubicase` seguro no Windows a partir do nome do servidor. */
export function packFileName(serverName: string): string {
  let base = serverName.replace(INVALID_FILE_CHARS, "_").replace(/[ .]+$/, "").trim();
  if (!base) base = "servidor";
  if (RESERVED_NAMES.test(base)) base = `_${base}`;
  return `${base.slice(0, 80)}.cubicase`;
}

/** Sugere um nome de servidor que não colida (sem diferenciar maiúsculas) com os existentes. */
export function uniqueServerName(desired: string, existing: string[]): string {
  const clean = desired.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[ .]+$/, "") || "Servidor";
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${clean}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${clean}-${Date.now()}`;
}

/** Extrai do cubicase-meta.json só o que pode viajar no pacote. */
export function pickPackMeta(rawMeta: unknown, fallbackVersion: string | null, fallbackType: string): PackServerMeta {
  const m = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    version: str(m.version) ?? fallbackVersion,
    serverType: str(m.serverType) ?? fallbackType,
    description: str(m.description) ?? "",
    ramGb: typeof m.ramGb === "number" && m.ramGb >= 2 ? m.ramGb : null,
    serverJar: str(m.serverJar),
    launchArgsDir: str(m.launchArgsDir),
    forgeVersion: str(m.forgeVersion),
    modLoaderVersion: str(m.modLoaderVersion),
  };
}

/**
 * Modo leve: só omite mods que o Modrinth reconhece (com URL e hash) — o resto
 * (mods sem origem conhecida) TEM que ir dentro do pacote. `unidentified` é
 * true quando há mods mas nenhum foi reconhecido (provável falta de internet
 * na hora de consultar o Modrinth): o pacote sai completo nos mods, e a UI avisa.
 */
export function splitModsForLightMode(mods: RemoteModEntry[]): { omit: OmittedMod[]; kept: number; unidentified: boolean } {
  const omit: OmittedMod[] = [];
  for (const mod of mods) {
    if (mod.source === "modrinth" && mod.url && mod.sha1 && !/[\\/]/.test(mod.filename)) {
      omit.push({ filename: mod.filename, sha1: mod.sha1, url: mod.url, sizeBytes: mod.size_bytes });
    }
  }
  return { omit, kept: mods.length - omit.length, unidentified: mods.length > 0 && omit.length === 0 };
}

/** Meta do servidor importado: UUID e código de convite NOVOS — nunca os do servidor original. */
export function buildImportedMeta(
  manifest: PackManifest,
  folderName: string,
  ids: { uuid: string; shortCode: string },
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  const m = manifest.meta ?? {};
  return {
    schemaVersion: 2,
    uuid: ids.uuid,
    shortCode: ids.shortCode,
    name: folderName,
    version: m.version ?? null,
    serverType: m.serverType ?? "vanilla",
    description: m.description ?? "",
    ...(m.ramGb ? { ramGb: m.ramGb } : {}),
    serverJar: m.serverJar ?? null,
    launchArgsDir: m.launchArgsDir ?? null,
    forgeVersion: m.forgeVersion ?? null,
    modLoaderVersion: m.modLoaderVersion ?? null,
    wakeOnDemandEnabled: false,
    idleTimeoutMinutes: null,
    createdAt: now,
    tags: [],
    importedFromPack: { name: manifest.name, mode: manifest.mode, createdAt: manifest.createdAt },
  };
}

export function generateShortCode(random: () => number = Math.random): string {
  return Array.from({ length: 6 }, () => Math.floor(random() * 36).toString(36)).join("").toUpperCase();
}

export function packPercent(ev: { doneBytes: number; totalBytes: number; phase: string }): number {
  if (ev.phase === "done") return 100;
  if (ev.phase === "verifying" || ev.phase === "finalizing") return 99;
  if (ev.totalBytes <= 0) return 0;
  return Math.min(98, Math.floor((ev.doneBytes / ev.totalBytes) * 98));
}

// ------------------------------------------------------------
// Pendências (mods que faltaram na importação de um pacote leve)
// ------------------------------------------------------------

const PENDING_FILE = "cubicase-pending.json";

export interface PackPending {
  version: 1;
  mods: OmittedMod[];
}

async function pendingPath(serverDir: string): Promise<string> {
  return await join(serverDir, PENDING_FILE);
}

export async function readPending(serverDir: string): Promise<PackPending | null> {
  try {
    const path = await pendingPath(serverDir);
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as PackPending;
    return Array.isArray(parsed?.mods) && parsed.mods.length > 0 ? parsed : null;
  } catch {
    // Arquivo ilegível: trata como "sem pendência" só pra não travar o servidor
    // para sempre — o usuário ainda pode baixar os mods manualmente.
    return null;
  }
}

async function writePending(serverDir: string, mods: OmittedMod[]): Promise<void> {
  const path = await pendingPath(serverDir);
  if (mods.length === 0) {
    await remove(path).catch(() => {});
    return;
  }
  const payload: PackPending = { version: 1, mods };
  await writeTextFile(path, JSON.stringify(payload, null, 2));
}

export interface CompletePendingResult {
  remaining: OmittedMod[];
  downloaded: number;
}

/**
 * Baixa, um por vez, os mods que faltam (URL/SHA1 vêm do manifesto do pacote;
 * o backend confere o hash e apaga o arquivo se vier corrompido). Nunca lança:
 * o que falhar (sem internet, mod removido do Modrinth) continua pendente.
 */
export async function completePending(
  serverDir: string,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<CompletePendingResult> {
  const pending = await readPending(serverDir);
  if (!pending) return { remaining: [], downloaded: 0 };

  const remaining: OmittedMod[] = [];
  let downloaded = 0;
  for (let i = 0; i < pending.mods.length; i++) {
    const mod = pending.mods[i];
    onProgress?.(i, pending.mods.length, mod.filename);
    const destPath = await join(serverDir, "mods", mod.filename);
    try {
      if (await exists(destPath)) {
        downloaded++;
        continue;
      }
      await invoke("download_mod_file", { url: mod.url, destPath, expectedSha1: mod.sha1 });
      downloaded++;
    } catch (err) {
      console.warn("[pack] falha ao baixar mod pendente", mod.filename, err);
      remaining.push(mod);
    }
  }
  onProgress?.(pending.mods.length, pending.mods.length, "");
  await writePending(serverDir, remaining);
  return { remaining, downloaded };
}

// ------------------------------------------------------------
// Exportação
// ------------------------------------------------------------

export interface PrepareExportInput {
  serverDir: string;
  serverName: string;
  serverType: string;
  mcVersion: string | null;
  mode: PackMode;
  includePlayerLists: boolean;
  onStatus?: (status: string) => void;
}

export interface PreparedExport {
  /** Pedido base — falta só `destPath` e `overwrite`, definidos depois de escolher o arquivo. */
  base: Omit<ExportRequest, "destPath" | "overwrite">;
  /** Quantos mods do Modrinth ficam de fora do pacote (modo leve). */
  omittedModCount: number;
  /** Modo leve, mas o Modrinth não reconheceu nenhum mod (provável falta de internet): todos entram no pacote. */
  modsUnidentified: boolean;
}

async function readRawMeta(serverDir: string): Promise<unknown> {
  try {
    const path = await join(serverDir, "cubicase-meta.json");
    if (await exists(path)) return JSON.parse(await readTextFile(path));
  } catch {
    /* meta ilegível: usa só os fallbacks */
  }
  return null;
}

export async function prepareExport(input: PrepareExportInput): Promise<PreparedExport> {
  if (await readPending(input.serverDir)) {
    throw new Error(t("pack.err.hasPending"));
  }

  const meta = pickPackMeta(await readRawMeta(input.serverDir), input.mcVersion, input.serverType);
  const javaVersion = getJavaVersion(meta.version || "1.20.1");
  const appVersion = await getVersion().catch(() => "");

  let jreDir: string | null = null;
  let omitMods: OmittedMod[] = [];
  let modsUnidentified = false;

  if (input.mode === "full") {
    // O modo completo precisa do Java deste servidor no disco; se ainda não
    // foi baixado (servidor nunca iniciado), tenta baixar agora.
    if (!(await isJREInstalled(javaVersion))) {
      input.onStatus?.(t("pack.status.installingJre", { java: javaVersion }));
      try {
        await installJRE(javaVersion, (p) => input.onStatus?.(p.status));
      } catch {
        throw new Error(t("pack.err.jreUnavailable", { java: javaVersion }));
      }
    }
    jreDir = await getJREPath(javaVersion);
  } else {
    input.onStatus?.(t("pack.status.checkingMods"));
    try {
      const split = splitModsForLightMode(await fetchLocalServerMods(input.serverDir));
      omitMods = split.omit;
      modsUnidentified = split.unidentified;
    } catch {
      // Sem como identificar: seguro = levar todos os mods dentro do pacote.
      modsUnidentified = true;
    }
  }

  return {
    base: {
      serverDir: input.serverDir,
      mode: input.mode,
      name: input.serverName,
      meta,
      javaVersion,
      jreDir,
      includePlayerLists: input.includePlayerLists,
      omitMods,
      appVersion,
    },
    omittedModCount: omitMods.length,
    modsUnidentified,
  };
}

export async function runPreflight(req: ExportRequest): Promise<PackPreflight> {
  return await invoke<PackPreflight>("pack_preflight", { req });
}

async function withProgress<T>(job: "export" | "import", onProgress: (p: PackUiProgress) => void, run: () => Promise<T>): Promise<T> {
  const unlisten = await listen<PackProgressEvent>("cubicase-pack-progress", (e) => {
    if (e.payload.job !== job) return;
    onProgress({
      phase: e.payload.phase,
      percent: packPercent(e.payload),
      current: e.payload.current,
      doneFiles: e.payload.doneFiles,
      totalFiles: e.payload.totalFiles,
    });
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
}

export async function runExport(req: ExportRequest, onProgress: (p: PackUiProgress) => void): Promise<ExportOutcome> {
  return await withProgress("export", onProgress, () => invoke<ExportOutcome>("pack_export", { req }));
}

export async function cancelPackJob(): Promise<void> {
  await invoke("pack_cancel").catch(() => {});
}

// ------------------------------------------------------------
// Importação
// ------------------------------------------------------------

export async function inspectPack(packPath: string): Promise<PackInspection> {
  return await invoke<PackInspection>("pack_read", { packPath });
}

export async function getServersRoot(): Promise<string> {
  return await join(await documentDir(), "CubicaseServers");
}

export type JreState = "included" | "present" | "downloaded" | "pending";

export interface ImportPackResult {
  serverPath: string;
  name: string;
  manifest: PackManifest;
  jre: JreState;
  jreWarning: string | null;
  modsOmitted: number;
  modsDownloaded: number;
  modsPending: number;
}

export interface ImportPackInput {
  packPath: string;
  folderName: string;
  manifest: PackManifest;
  onProgress: (p: PackUiProgress) => void;
}

export async function importPack(input: ImportPackInput): Promise<ImportPackResult> {
  const { manifest, folderName, onProgress } = input;
  const parentDir = await getServersRoot();
  await invoke("pack_cleanup_stale", { parentDir }).catch(() => {});

  const version = manifest.meta?.version || "1.20.1";
  const javaVersion = (manifest.javaVersion ?? getJavaVersion(version)) as 8 | 17 | 21 | 25;
  const jreDest = manifest.includesJre ? await getJREPath(javaVersion) : null;

  const outcome = await invoke<{
    serverPath: string;
    jreInstalled: boolean;
    jreWarning: string | null;
    manifest: PackManifest;
  }>("pack_import", { req: { packPath: input.packPath, parentDir, folderName, jreDest } });
  // (o listener de progresso é registrado por importPackWithProgress)
  const serverPath = outcome.serverPath;

  try {
    // Identidade NOVA: dois hosts nunca podem compartilhar UUID/código de convite.
    const meta = buildImportedMeta(manifest, folderName, { uuid: crypto.randomUUID(), shortCode: generateShortCode() });
    await writeTextFile(await join(serverPath, "cubicase-meta.json"), JSON.stringify(meta, null, 2));
    await acceptEula(serverPath);

    await writePending(serverPath, manifest.omittedMods);
    onProgress({ phase: "downloadingMods", percent: 0, current: "", doneFiles: 0, totalFiles: manifest.omittedMods.length });
    const completed = manifest.omittedMods.length
      ? await completePending(serverPath, (done, total, current) =>
          onProgress({ phase: "downloadingMods", percent: total ? Math.floor((done / total) * 100) : 100, current, doneFiles: done, totalFiles: total }),
        )
      : { remaining: [], downloaded: 0 };

    // Java: incluído e instalado / já existia / baixar agora (se faltar e houver internet).
    let jre: JreState;
    if (outcome.jreInstalled) {
      jre = "included";
    } else if (await isJREInstalled(javaVersion)) {
      jre = "present";
    } else {
      try {
        onProgress({ phase: "installingJre", percent: 0, current: `Java ${javaVersion}`, doneFiles: 0, totalFiles: 0 });
        await installJRE(javaVersion, (p) => onProgress({ phase: "installingJre", percent: p.percent, current: p.status, doneFiles: 0, totalFiles: 0 }));
        jre = "downloaded";
      } catch {
        // Sem internet: não é fatal — o Java é baixado ao iniciar o servidor.
        jre = "pending";
      }
    }

    return {
      serverPath,
      name: folderName,
      manifest,
      jre,
      jreWarning: outcome.jreWarning,
      modsOmitted: manifest.omittedMods.length,
      modsDownloaded: completed.downloaded,
      modsPending: completed.remaining.length,
    };
  } catch (err) {
    // Pós-processamento falhou: não deixa um servidor pela metade na lista.
    await remove(serverPath, { recursive: true }).catch(() => {});
    throw err;
  }
}

/** `importPack` com o listener de progresso do backend ligado durante a extração. */
export async function importPackWithProgress(input: ImportPackInput): Promise<ImportPackResult> {
  return await withProgress("import", input.onProgress, () => importPack(input));
}
