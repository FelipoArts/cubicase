// ============================================================
// Datapacks e pacote de recursos do servidor (via Modrinth)
// ============================================================
// - Datapack: um .zip baixado para <servidor>/<mundo>/datapacks/ (o Minecraft carrega ao iniciar).
// - Pacote de recursos: não é hospedado por nós. O servidor só ensina ao jogador ONDE baixar
//   (resource-pack=<url> + sha1 no server.properties); aqui a URL é a do CDN da Modrinth, que qualquer
//   jogador alcança. O download é do próprio cliente do jogador.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { t as tn } from "@/i18n";
import type { ModrinthVersion, ModrinthVersionFile } from "@/lib/modrinth";

export interface DatapackInfo {
  fileName: string;
  displayName: string;
  sizeBytes: number;
  enabled: boolean;
  isDir: boolean;
}

export const listDatapacks = (serverDir: string) => invoke<DatapackInfo[]>("list_datapacks", { serverDir });
export const toggleDatapack = (serverDir: string, fileName: string) => invoke<void>("toggle_datapack", { serverDir, fileName });
export const deleteDatapack = (serverDir: string, fileName: string) => invoke<void>("delete_datapack", { serverDir, fileName });

export function primaryPackFile(v: ModrinthVersion): ModrinthVersionFile | undefined {
  return v.files.find((f) => f.primary) ?? v.files[0];
}

/** Só o CDN da Modrinth: o jogador baixa direto de lá, e o download do app também só aceita origens conhecidas. */
export function isModrinthCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "cdn.modrinth.com" && !u.port;
  } catch {
    return false;
  }
}

/** Nome da pasta do mundo ativo (level-name), "world" se não houver. */
export async function activeLevelName(serverDir: string): Promise<string> {
  try {
    const props = await invoke<Record<string, string>>("read_server_properties", { serverDir });
    const name = props["level-name"]?.trim();
    return name || "world";
  } catch {
    return "world";
  }
}

/** Baixa o datapack para a pasta `datapacks` do mundo ativo. Devolve o nome do arquivo. */
export async function installDatapack(serverDir: string, version: ModrinthVersion): Promise<string> {
  const file = primaryPackFile(version);
  if (!file) throw new Error(tn("packs.err.noFile"));
  if (!file.filename.toLowerCase().endsWith(".zip") || /[\\/]/.test(file.filename)) throw new Error(tn("packs.err.notZip"));
  const level = await activeLevelName(serverDir);
  const dest = await join(serverDir, level, "datapacks", file.filename);
  await invoke("download_server_jar", { url: file.url, destPath: dest, expectedSha1: file.hashes.sha1 ?? null, expectedSha256: null });
  return file.filename;
}

// ---- pacote de recursos ----

/** O Minecraft recusa pacotes de recursos acima disto (250 MiB nas versões atuais). */
export const MAX_RESOURCE_PACK_BYTES = 250 * 1024 * 1024;

export interface ResourcePackSetting {
  url: string;
  sha1: string;
  required: boolean;
}

export async function readResourcePack(serverDir: string): Promise<ResourcePackSetting | null> {
  try {
    const props = await invoke<Record<string, string>>("read_server_properties", { serverDir });
    const url = props["resource-pack"]?.trim();
    if (!url) return null;
    return { url, sha1: props["resource-pack-sha1"]?.trim() ?? "", required: props["require-resource-pack"]?.trim() === "true" };
  } catch {
    return null;
  }
}

/** Aponta o servidor para um pacote de recursos da Modrinth. Lança com mensagem clara se não puder. */
export async function applyResourcePack(serverDir: string, version: ModrinthVersion, required: boolean): Promise<void> {
  const file = primaryPackFile(version);
  if (!file || !isModrinthCdnUrl(file.url)) throw new Error(tn("packs.err.noFile"));
  const sha1 = file.hashes.sha1?.toLowerCase();
  if (!sha1 || !/^[0-9a-f]{40}$/.test(sha1)) throw new Error(tn("packs.err.noHash"));
  if (typeof file.size === "number" && file.size > MAX_RESOURCE_PACK_BYTES) throw new Error(tn("packs.err.tooBig"));
  await invoke("write_server_properties", {
    serverDir,
    props: { "resource-pack": file.url, "resource-pack-sha1": sha1, "require-resource-pack": required ? "true" : "false" },
  });
}

export async function setResourcePackRequired(serverDir: string, required: boolean): Promise<void> {
  await invoke("write_server_properties", { serverDir, props: { "require-resource-pack": required ? "true" : "false" } });
}

export async function clearResourcePack(serverDir: string): Promise<void> {
  await invoke("write_server_properties", {
    serverDir,
    props: { "resource-pack": "", "resource-pack-sha1": "", "require-resource-pack": "false" },
  });
}
