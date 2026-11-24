import { invoke } from "@tauri-apps/api/core";
import { pushDiagnostic } from "@/app/diagnostics";
import { t } from "@/i18n";
import { getServersRoot } from "@/lib/serversRoot";

// ============================================================
// "Acesso controlado a pastas" do Windows (proteção contra ransomware)
// ============================================================
// Quando ligado, o Segurança do Windows impede programas que ele não conhece de gravar em Documentos,
// Área de Trabalho e Imagens. Os servidores do Cubicase ficam em Documentos\CubicaseServers (e os
// backups, por padrão, em Documentos\CubicaseBackups), então um bloqueio ali impede de criar o
// servidor, salvar o mundo e fazer backup. O recurso vem desligado no Windows: só afeta quem o ligou.
//
// Aqui ficam: reconhecer o erro de "acesso negado", dizer ao usuário o porquê e o que fazer, e um teste
// de gravação feito uma vez por sessão nas duas pastas.
// ============================================================

/** O erro (de qualquer origem: Rust, plugin-fs, Java) é um "acesso negado" do sistema de arquivos? */
export function isAccessDeniedError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /os error 5\b|access is denied|acesso negado|AccessDeniedException|PermissionDenied|EPERM|EACCES/i.test(text);
}

/** Título e texto prontos para o usuário. `folder` é a pasta que o Windows recusou (se conhecida). */
export function accessDeniedText(folder?: string): { title: string; message: string } {
  const where = folder ?? t("access.denied.somewhere");
  return {
    title: t("access.denied.title"),
    message: t("access.denied.message", { folder: where }),
  };
}

/** Mostra o aviso explicativo como diagnóstico. */
export function reportAccessDenied(folder?: string, detail?: string): void {
  const { title, message } = accessDeniedText(folder);
  pushDiagnostic({ level: "error", source: t("diag.source.server"), title, message, detail });
}

/** Testa a gravação em `path`: "ok", "denied" (Windows recusou) ou o texto de outro erro. */
export async function probeFolderWrite(path: string): Promise<string> {
  return invoke<string>("probe_folder_write", { path });
}

let checkedThisSession = false;

/**
 * Uma vez por sessão: grava (e apaga) um arquivo de teste nas pastas de servidores e de backups. Se o
 * Windows recusar, avisa ANTES de o usuário esbarrar num erro estranho ao criar o servidor ou ao salvar.
 * Nunca lança: é só um aviso.
 */
export async function warnIfFoldersBlocked(): Promise<void> {
  if (checkedThisSession) return;
  checkedThisSession = true;
  try {
    const folders: string[] = [await getServersRoot()];
    try {
      const backups = await invoke<{ path: string }>("get_backups_settings");
      if (backups?.path) folders.push(backups.path);
    } catch { /* sem configuração de backup: testa só os servidores */ }

    for (const folder of folders) {
      if ((await probeFolderWrite(folder).catch(() => "")) === "denied") {
        reportAccessDenied(folder);
        return; // um aviso basta: a explicação vale para as duas pastas
      }
    }
  } catch {
    // silencioso de propósito
  }
}
