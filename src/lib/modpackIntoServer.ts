import { invoke } from "@tauri-apps/api/core";
import { join, appLocalDataDir } from "@tauri-apps/api/path";
import { exists, remove } from "@tauri-apps/plugin-fs";
import { parseModpack, type ParsedModpack, type ModpackModEntry, type UnresolvedModpackMod } from "@/lib/modpackImport";
import {
  readModIdentities,
  readJarIdentity,
  classifyIncoming,
  countStatuses,
  type IncomingStatus,
  type ModIdentity,
  type PlanCounts,
} from "@/lib/modIdentity";
import { readModInstallRegistry, writeModInstallRegistry, type ModrinthVersion } from "@/lib/modrinth";
import { addPendingMods } from "@/lib/pendingMods";
import { t } from "@/i18n";

// ============================================================
// Instalar um modpack num servidor que JÁ existe
// ============================================================
// Diferente de installModpack (modpackImport.ts), que cria um servidor novo a
// partir do pack, aqui o servidor já tem versão, loader e talvez mods. Dois
// modpacks quase sempre compartilham mods, e o mesmo mod em versões
// diferentes (ou em arquivos com nomes diferentes) terminaria duplicado na
// pasta. Por isso a instalação tem DUAS fases:
//
//  1. stageModpack: baixa o pack e todos os arquivos para uma área de preparo
//     (fora do servidor), lê a identidade de cada jar e compara com o que o
//     servidor já tem — nada é tocado ainda;
//  2. applyStagedModpack: com a decisão do host, move para a pasta o que é
//     novo, ignora o idêntico e trata o conflito de versão — por padrão
//     MANTÉM o que já está no servidor (o que funciona não é mexido); se o
//     host escolher usar as versões do pack, o arquivo antigo vai para
//     "mods-backup/" em vez de ser apagado.
//
// Cada arquivo do pack vai para a pasta que o próprio pack indica (mods/,
// config/...). Só os de mods/ passam pela comparação de identidade; os demais
// (configs etc.) são "criar se não existir" — nunca sobrescrevem. Reinstalar o
// mesmo pack é seguro: tudo vira "já presente" e nada é duplicado. Se um
// arquivo individual falhar, os outros seguem e a falha é listada no final.
// ============================================================

const DOWNLOAD_CONCURRENCY = 4;
const MODS_DIR = "mods";

export type ConflictStrategy = "keep" | "replace";

export interface StagedMod {
  entry: ModpackModEntry;
  /** Vive em mods/ (passa pela checagem de identidade) ou é um arquivo comum (config etc.). */
  isMod: boolean;
  stagedPath: string;
  destPath: string;
  modId: string | null;
  version: string | null;
  status: IncomingStatus;
  existing?: ModIdentity;
}

export interface StagedModpack {
  serverDir: string;
  stagingDir: string;
  parsed: ParsedModpack;
  files: StagedMod[];
  unresolved: UnresolvedModpackMod[];
  /** Contagem só dos mods (mods/), que é o que importa para o resumo. */
  counts: PlanCounts;
  /** Arquivos comuns do pack (configs etc.) que ainda não existem no servidor. */
  extraFiles: number;
}

export interface StageProgress {
  status: string;
  percent: number;
}

export interface ApplyResult {
  added: number;
  skipped: number;
  replaced: number;
  keptOnConflict: number;
  extras: number;
  failed: { name: string; error: string }[];
  backupDir: string | null;
}

/** Roda `worker` sobre `items` com no máximo `limit` em paralelo, preservando a ordem do resultado. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function discard(stagingDir: string): Promise<void> {
  await remove(stagingDir, { recursive: true }).catch(() => {});
}

/**
 * Fase 1: baixa o pack escolhido e todos os arquivos para a área de preparo e
 * classifica cada um contra o servidor. Em qualquer erro apaga a área de preparo.
 */
export async function stageModpack(opts: {
  serverDir: string;
  serverType: string;
  mcVersion: string;
  packVersion: ModrinthVersion;
  onProgress: (p: StageProgress) => void;
}): Promise<StagedModpack> {
  const { serverDir, serverType, mcVersion, packVersion, onProgress } = opts;
  const packFile = packVersion.files.find((f) => f.primary) ?? packVersion.files[0];
  if (!packFile?.url) throw new Error(t("modrinth.noFile"));

  const stagingDir = await join(await appLocalDataDir(), "modpack-staging", String(Date.now()));
  try {
    onProgress({ status: t("modpackInto.downloadingPack"), percent: 3 });
    const packPath = await join(stagingDir, packFile.filename);
    await invoke("download_server_jar", {
      url: packFile.url,
      destPath: packPath,
      expectedSha1: packFile.hashes.sha1 ?? null,
      expectedSha256: null,
    });

    onProgress({ status: t("modpackInto.readingPack"), percent: 10 });
    const parsed = await parseModpack(packPath);
    if (parsed.loader !== serverType || parsed.mcVersion !== mcVersion) {
      throw new Error(
        t("modpackInto.mismatch", {
          packLoader: parsed.loader,
          packMc: parsed.mcVersion,
          serverLoader: serverType,
          serverMc: mcVersion,
        })
      );
    }

    const total = parsed.mods.length;
    let done = 0;
    const downloaded = await mapPool(parsed.mods, DOWNLOAD_CONCURRENCY, async (entry) => {
      const isMod = entry.dir === MODS_DIR;
      const stagedPath = await join(stagingDir, "files", entry.dir, entry.filename);
      const destPath = await join(serverDir, entry.dir, entry.filename);
      await invoke("download_server_jar", { url: entry.url, destPath: stagedPath, expectedSha1: entry.sha1, expectedSha256: null });
      const id = isMod ? await readJarIdentity(stagedPath) : { mod_id: null, version: null };
      done++;
      onProgress({
        status: t("modpackInto.downloadingMods", { done, total }),
        percent: 10 + Math.round((done / Math.max(total, 1)) * 80),
      });
      return { entry, isMod, stagedPath, destPath, modId: id.mod_id, version: id.version };
    });

    onProgress({ status: t("modpackInto.comparing"), percent: 94 });
    const existing = await readModIdentities(serverDir, MODS_DIR);
    const files: StagedMod[] = [];
    const usedDest = new Set<string>();
    for (const d of downloaded) {
      let classification: { status: IncomingStatus; existing?: ModIdentity } = d.isMod
        ? classifyIncoming(existing, { filename: d.entry.filename, mod_id: d.modId, version: d.version })
        : { status: "new" };
      // A leitura de identidade só vê .jar: qualquer arquivo "novo" que já esteja no disco (um
      // config, um .zip, um mod sem metadados) conta como já presente — reinstalar não duplica nem falha.
      if (classification.status === "new" && (await exists(d.destPath).catch(() => false))) {
        classification = { status: "identical" };
      }
      // Dois itens do próprio pack para o mesmo destino (pack mal montado): só o primeiro vale.
      const destKey = d.destPath.toLowerCase();
      if (classification.status !== "identical" && usedDest.has(destKey)) classification = { status: "identical" };
      if (classification.status !== "identical") usedDest.add(destKey);
      files.push({ ...d, ...classification });
    }
    // Mesmo mod (mesmo id) duas vezes no pack com nomes de arquivo diferentes: instala só um.
    const seenIds = new Set<string>();
    for (const f of files) {
      if (!f.isMod || !f.modId || f.status === "identical") continue;
      if (seenIds.has(f.modId)) f.status = "identical";
      else seenIds.add(f.modId);
    }

    const mods = files.filter((f) => f.isMod);
    return {
      serverDir,
      stagingDir,
      parsed,
      files,
      unresolved: parsed.unresolvedMods,
      counts: countStatuses(mods),
      extraFiles: files.filter((f) => !f.isMod && f.status === "new").length,
    };
  } catch (err) {
    await discard(stagingDir);
    throw err;
  }
}

export function discardStagedModpack(staged: StagedModpack): Promise<void> {
  return discard(staged.stagingDir);
}

/**
 * Fase 2: aplica o que foi preparado. `keep` (padrão recomendado) deixa
 * intocado o que já está no servidor quando há conflito de versão; `replace`
 * usa a versão do pack e guarda a antiga em mods-backup/<data>/.
 * Uma falha em um arquivo não interrompe os demais: vai para `result.failed`.
 */
export async function applyStagedModpack(
  staged: StagedModpack,
  strategy: ConflictStrategy,
  onProgress: (p: StageProgress) => void
): Promise<ApplyResult> {
  const { serverDir, parsed } = staged;
  const registry = await readModInstallRegistry(serverDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = await join(serverDir, "mods-backup", stamp);
  const result: ApplyResult = { added: 0, skipped: 0, replaced: 0, keptOnConflict: 0, extras: 0, failed: [], backupDir: null };

  try {
    for (let i = 0; i < staged.files.length; i++) {
      const f = staged.files[i];
      onProgress({
        status: t("modpackInto.applying", { done: i + 1, total: staged.files.length }),
        percent: Math.round((i / Math.max(staged.files.length, 1)) * 85),
      });
      const record = {
        source: f.entry.source,
        installedViaModpack: parsed.packName,
        projectId: f.entry.projectId,
        fileOrVersionId: f.entry.fileOrVersionId,
      };

      try {
        if (f.status === "identical") {
          result.skipped++;
        } else if (f.status === "conflict" && strategy === "keep") {
          result.keptOnConflict++;
        } else if (f.status === "conflict" && f.existing) {
          await invoke("install_staged_mod", {
            serverDir,
            stagedPath: f.stagedPath,
            destPath: f.destPath,
            replacePath: await join(serverDir, MODS_DIR, f.existing.file_name),
            backupDir,
          });
          delete registry[f.existing.file_name.replace(/\.disabled$/i, "")];
          registry[f.entry.filename] = record;
          result.replaced++;
          result.backupDir = backupDir;
        } else {
          await invoke("install_staged_mod", { serverDir, stagedPath: f.stagedPath, destPath: f.destPath, replacePath: null, backupDir: null });
          if (f.isMod) {
            registry[f.entry.filename] = record;
            result.added++;
          } else {
            result.extras++;
          }
        }
      } catch (err) {
        result.failed.push({ name: f.entry.filename, error: String(err) });
      }
    }
    await writeModInstallRegistry(serverDir, registry);
    await addPendingMods(serverDir, parsed.packName, staged.unresolved).catch(() => {});

    if (parsed.overridesFolders.length > 0) {
      onProgress({ status: t("modpackInto.extras"), percent: 92 });
      for (const folder of parsed.overridesFolders) {
        await invoke("extract_modpack_overrides", {
          zipPath: parsed.zipPath,
          destDir: serverDir,
          overridesFolder: folder,
          skipExisting: true,
        });
      }
    }
    onProgress({ status: t("modpackInto.done"), percent: 100 });
    return result;
  } finally {
    if (await exists(staged.stagingDir).catch(() => false)) await discard(staged.stagingDir);
  }
}
