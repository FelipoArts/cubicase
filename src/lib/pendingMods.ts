import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import type { UnresolvedModpackMod } from "@/lib/modpackImport";

// ============================================================
// Mods pendentes (download bloqueado em todas as fontes)
// ============================================================
// Quando o autor de um mod bloqueia o download por aplicativos de terceiros e
// o mesmo arquivo também não está na Modrinth (ver resolveCurseForgeFiles em
// modpackImport.ts), o Cubicase não consegue instalá-lo — o host precisa
// baixar pelo site. Este arquivo guarda, por servidor, o que ficou faltando e
// de qual modpack veio, para a pendência não sumir quando o resumo da
// instalação é fechado. Diferente de cubicase-pending.json (pacote .cubicase,
// mods que falharam por falta de internet e podem ser baixados de novo), aqui
// tentar outra vez não adianta.
// ============================================================

const PENDING_MODS_FILE = "cubicase-pending-mods.json";

export interface PendingMod {
  /** `${projectId}:${fileId}` — um mod pendente por arquivo da CurseForge. */
  key: string;
  name: string;
  /** Nome do arquivo .jar esperado; permite detectar sozinho quando o host o coloca na pasta. */
  fileName: string | null;
  slug: string | null;
  projectId: number;
  fileId: number;
  packName: string;
  addedAt: string;
}

interface PendingModsFile {
  version: 1;
  mods: PendingMod[];
}

const normalizeName = (name: string) => name.replace(/\.disabled$/i, "").toLowerCase();

export function pendingModPageUrl(mod: PendingMod): string {
  const slug = mod.slug ?? String(mod.projectId);
  return `https://www.curseforge.com/minecraft/mc-mods/${slug}/files/${mod.fileId}`;
}

/** Remove da lista os mods cujo arquivo já está na pasta (o host os baixou e colocou lá). */
export function reconcile(entries: PendingMod[], presentFileNames: string[]): PendingMod[] {
  const present = new Set(presentFileNames.map(normalizeName));
  return entries.filter((m) => !m.fileName || !present.has(normalizeName(m.fileName)));
}

async function filePath(serverDir: string): Promise<string> {
  return await join(serverDir, PENDING_MODS_FILE);
}

export async function readPendingMods(serverDir: string): Promise<PendingMod[]> {
  try {
    const path = await filePath(serverDir);
    if (!(await exists(path))) return [];
    const parsed = JSON.parse(await readTextFile(path)) as PendingModsFile;
    return Array.isArray(parsed?.mods) ? parsed.mods : [];
  } catch {
    return [];
  }
}

async function writePendingMods(serverDir: string, mods: PendingMod[]): Promise<void> {
  const path = await filePath(serverDir);
  if (mods.length === 0) {
    await remove(path).catch(() => {});
    return;
  }
  const payload: PendingModsFile = { version: 1, mods };
  await writeTextFile(path, JSON.stringify(payload, null, 2));
}

/** Soma à lista os mods que não puderam ser instalados (sem duplicar o mesmo arquivo). */
export async function addPendingMods(serverDir: string, packName: string, unresolved: UnresolvedModpackMod[]): Promise<void> {
  if (unresolved.length === 0) return;
  const current = await readPendingMods(serverDir);
  const byKey = new Map(current.map((m) => [m.key, m]));
  for (const u of unresolved) {
    const key = `${u.projectId}:${u.fileId}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      name: u.name ?? u.slug ?? `#${u.projectId}`,
      fileName: u.fileName,
      slug: u.slug,
      projectId: u.projectId,
      fileId: u.fileId,
      packName,
      addedAt: new Date().toISOString(),
    });
  }
  await writePendingMods(serverDir, [...byKey.values()]);
}

/**
 * Lê as pendências e já tira as que foram resolvidas (arquivo presente em
 * mods/). Persiste a limpeza, então o aviso some sozinho depois que o host
 * coloca o .jar na pasta.
 */
export async function reconcilePendingMods(serverDir: string): Promise<PendingMod[]> {
  const entries = await readPendingMods(serverDir);
  if (entries.length === 0) return [];
  let files: string[] = [];
  try {
    const list = await invoke<{ file_name: string }[]>("list_mods", { serverDir, folderName: "mods" });
    files = list.map((m) => m.file_name);
  } catch {
    return entries; // sem conseguir listar a pasta, não arrisca apagar pendência
  }
  const remaining = reconcile(entries, files);
  if (remaining.length !== entries.length) await writePendingMods(serverDir, remaining);
  return remaining;
}

export async function dismissPendingMods(serverDir: string, keys: string[] | "all"): Promise<PendingMod[]> {
  const current = await readPendingMods(serverDir);
  const remaining = keys === "all" ? [] : current.filter((m) => !keys.includes(m.key));
  await writePendingMods(serverDir, remaining);
  return remaining;
}
