// ============================================================
// Mundos do servidor (listar, trocar, novo, importar de .zip)
// ============================================================
// A lógica pesada e as defesas (zip-slip, limites, nunca sobrescrever) ficam em src-tauri/src/worlds.rs.
// Trocar de mundo só muda o `level-name`: nenhum mundo é apagado.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { compareVersions } from "@/lib/serverUpgrade";

export interface WorldInfo {
  folder: string;
  levelName: string | null;
  mcVersion: string | null;
  lastPlayedMs: number | null;
  isActive: boolean;
}

export interface WorldZipInfo {
  suggestedName: string;
  levelName: string | null;
  mcVersion: string | null;
  hasNetherFolder: boolean;
  hasEndFolder: boolean;
  fileCount: number;
  unpackedBytes: number;
}

export const listWorlds = (serverDir: string) => invoke<WorldInfo[]>("list_worlds", { serverDir });
export const setActiveWorld = (serverDir: string, folder: string) => invoke<void>("set_active_world", { serverDir, folder });
export const createNewWorld = (serverDir: string, name: string, seed: string | null) => invoke<void>("create_new_world", { serverDir, name, seed });
export const inspectWorldZip = (zipPath: string) => invoke<WorldZipInfo>("inspect_world_zip", { zipPath });
export const importWorldZip = (serverDir: string, zipPath: string, name: string) =>
  invoke<{ folder: string; mcVersion: string | null }>("import_world_zip", { serverDir, zipPath, name });

/** O mundo foi salvo numa versão MAIS NOVA que a do servidor? O Minecraft não abre esses mundos em versões antigas. */
export function worldIsNewerThanServer(worldVersion: string | null, serverVersion: string | null): boolean {
  if (!worldVersion || !serverVersion) return false;
  if (!/^\d+(\.\d+)+$/.test(worldVersion) || !/^\d+(\.\d+)+$/.test(serverVersion)) return false;
  return compareVersions(worldVersion, serverVersion) > 0;
}

/** `base`, `base 2`, `base 3`… o primeiro que não está em `taken` (sem diferenciar maiúsculas). */
export function uniqueWorldName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`.slice(0, 64);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

const SERVER_FOLDERS = new Set(["mods", "plugins", "config", "logs", "libraries", "versions", "cache", "crash-reports"]);

/** Mesmas regras do backend (que é quem decide de verdade); serve só para avisar enquanto a pessoa digita. */
export function worldNameProblem(name: string): "empty" | "invalid" | null {
  const n = name.trim();
  if (!n) return "empty";
  if (n.length > 64 || n.startsWith(".") || /[\\/:*?"<>|\u0000-\u001f]/.test(n) || /[ .]$/.test(n)) return "invalid";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n) || SERVER_FOLDERS.has(n.toLowerCase())) return "invalid";
  return null;
}
