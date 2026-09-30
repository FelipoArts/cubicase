// ============================================================
// Backup automático do mundo (baseado em regras, sem IA)
// ============================================================
// Orquestra os comandos Tauri de backup que já existem
// (backup_world/list_world_backups/delete_world_backup — ver
// src-tauri/src/lib.rs) em cima de três gatilhos: parada normal do
// servidor, crash, e um "backup de segurança" periódico para sessões
// longas que nunca são paradas manualmente.
//
// Pula o backup quando o mundo não mudou desde o último (comparando o
// timestamp do comando `world_last_modified`), exceto em crash — aí sempre
// tenta, já que é o momento mais importante de ter uma cópia recente.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { pushDiagnostic } from "@/app/diagnostics";
import { t } from "@/i18n";
import { getBackupsDir } from "@/lib/server";

interface BackupInfo {
  file_name: string;
  size_bytes: number;
  created_at: string;
}

export type AutoBackupReason = "stop" | "crash" | "safety-net";

export interface AutoBackupOptions {
  enabled: boolean;
  retentionCount: number;
}

// Função (não constante) para respeitar o idioma no momento do backup.
const reasonLabel = (reason: AutoBackupReason): string =>
  t(reason === "stop" ? "backup.reason.stop" : reason === "crash" ? "backup.reason.crash" : "backup.reason.safetyNet");

// Último `world_last_modified` que já gerou um backup, por servidor — em
// memória, só dura a sessão do app (reiniciar o app no máximo gera um
// backup a mais, nunca um a menos).
const lastBackedUpMtime = new Map<string, string>();
// Evita rodar dois backups do mesmo servidor ao mesmo tempo se dois
// gatilhos disparam quase juntos (ex: crash bem na hora do safety-net), E
// deixa outro código (ex: renameServer, antes de mexer na pasta) esperar um
// backup em andamento terminar — ver waitForPendingBackup. Guarda a própria
// Promise (não só um marcador), pra dar pra esperar por ela de fora.
const inFlight = new Map<string, Promise<void>>();

/**
 * Espera qualquer backup automático em andamento para `serverDir` terminar.
 * Existe porque o backup de "parada/crash" é disparado sem `await` (ver
 * listener de "minecraft-status-changed" em page.tsx) bem no mesmo instante
 * em que a UI libera ações como renomear o servidor — sem isso, era possível
 * renomear a pasta ENQUANTO esse backup ainda estava lendo/zipando ela,
 * corrompendo ou falhando aquele backup específico (não o mundo em si).
 * Resolve na hora se não houver nada em andamento.
 */
export function waitForPendingBackup(serverDir: string): Promise<void> {
  return inFlight.get(serverDir) ?? Promise.resolve();
}

/**
 * Gera um backup automático do mundo em `serverDir`, se fizer sentido:
 * respeita `options.enabled`, pula se nada mudou desde o último backup
 * (exceto em crash), e poda backups antigos além de `options.retentionCount`
 * depois de um backup bem-sucedido.
 */
export function maybeBackupWorld(
  serverDir: string,
  serverName: string,
  reason: AutoBackupReason,
  options: AutoBackupOptions,
): Promise<void> {
  if (!options.enabled || !serverDir) return Promise.resolve();
  if (inFlight.has(serverDir)) return inFlight.get(serverDir)!;

  // Registrado de forma síncrona (nenhum `await` entre o `has()` acima e
  // este `set()`) — evita duas chamadas quase simultâneas passarem pela
  // checagem juntas antes de qualquer uma marcar "em andamento".
  const run = (async () => {
    try {
      const currentMtime = await invoke<string | null>("world_last_modified", { serverDir }).catch(() => null);
      if (!currentMtime) return; // mundo ainda não existe (servidor nunca chegou a rodar) — nada pra fazer backup

      if (reason !== "crash" && lastBackedUpMtime.get(serverDir) === currentMtime) {
        return; // nada mudou desde o último backup — não gera zip à toa
      }

      const backupsDir = await getBackupsDir(serverName);
      try {
        await invoke("backup_world", { serverDir, backupsDir });
        lastBackedUpMtime.set(serverDir, currentMtime);
        pushDiagnostic({
          level: "info",
          source: t("backup.source"),
          title: t("backup.created.title"),
          message: t("backup.created.message", { reason: reasonLabel(reason) }),
        });
      } catch (err) {
        // Best-effort: em crash o mundo pode estar num estado ruim pra zipar,
        // não é um erro que mereça alarmar o usuário como "error".
        pushDiagnostic({
          level: "warning",
          source: t("backup.source"),
          title: t("backup.failed.title"),
          message: String(err),
        });
        return;
      }

      await pruneOldBackups(serverDir, backupsDir, options.retentionCount);
    } finally {
      inFlight.delete(serverDir);
    }
  })();

  inFlight.set(serverDir, run);
  return run;
}

/**
 * Apaga os backups mais antigos além de `retentionCount`. A retenção conta
 * TODOS os backups da pasta, inclusive os manuais (o botão "Backup agora"
 * usa o mesmo `backup_world`) — os arquivos não carregam metadado de origem.
 */
async function pruneOldBackups(serverDir: string, backupsDir: string, retentionCount: number): Promise<void> {
  if (retentionCount <= 0) return; // <=0 desativa a poda, não apaga tudo
  try {
    const backups = await invoke<BackupInfo[]>("list_world_backups", { serverDir, backupsDir });
    const surplus = backups.slice(retentionCount); // já vem ordenado do mais novo pro mais antigo
    for (const backup of surplus) {
      await invoke("delete_world_backup", { backupsDir, fileName: backup.file_name }).catch(() => {});
    }
  } catch {
    // Poda é best-effort — não deve quebrar o fluxo de backup em si.
  }
}
