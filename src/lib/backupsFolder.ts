import { invoke } from "@tauri-apps/api/core";

// ============================================================
// Pasta dos backups do mundo
// ============================================================
// Por padrão `Documentos/CubicaseBackups`; a pessoa pode escolher outra em Configurações. Quem decide é o Rust
// (src-tauri/src/backups_dir.rs), que guarda a escolha e valida a pasta: o backup pedido pelo painel web ou pelo
// Discord também precisa saber onde gravar, sem passar pela interface.
// ============================================================

export interface BackupsSettings {
  /** Pasta em uso agora. */
  path: string;
  defaultPath: string;
  isCustom: boolean;
  /** Pasta que valia antes da última troca (só se ainda existir): lá ficaram os backups antigos. */
  previous: string | null;
  /** false quando a pasta escolhida não está acessível agora (disco externo desconectado, por exemplo). */
  available: boolean;
}

export const getBackupsSettings = () => invoke<BackupsSettings>("get_backups_settings");

/** Escolhe a pasta de backups; `null` volta para a padrão. Os backups que já existem não são movidos. */
export const setBackupsRoot = (path: string | null) => invoke<BackupsSettings>("set_backups_root", { path });

/** Subpasta com o nome do servidor dentro da pasta de backups em uso. */
export async function backupsDirFor(serverName: string): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  return join((await getBackupsSettings()).path, serverName);
}

/** O servidor foi renomeado: leva a subpasta de backups junto. Devolve se havia o que mover. */
export const renameServerBackups = (oldName: string, newName: string) =>
  invoke<boolean>("rename_server_backups", { oldName, newName });

/** A pasta fica dentro do OneDrive? Cada backup grande seria enviado para a nuvem. */
export const isInsideOneDrive = (path: string) => /[\\/]onedrive[^\\/]*[\\/]/i.test(path.endsWith("\\") || path.endsWith("/") ? path : `${path}\\`);
