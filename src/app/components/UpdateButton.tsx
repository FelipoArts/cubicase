"use client";

import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUpdaterStore } from "@/app/updater";
import { useT } from "@/i18n";

// ============================================================
// UpdateButton
// ============================================================
// Botão do cabeçalho que só existe enquanto há uma atualização pendente.
// Diferente do UpdateBanner (que o usuário pode dispensar), este continua ali:
// se a instalação automática falha, basta clicar de novo — sem fechar e
// reabrir o app só para a mensagem voltar. Cliques repetidos são ignorados
// pelo próprio store (trava + cooldown depois de uma falha); aqui o botão
// também fica desabilitado nesses momentos para deixar isso visível.
// ============================================================

export function UpdateButton() {
  const { t } = useT();
  const phase = useUpdaterStore((s) => s.phase);
  const hasUpdate = useUpdaterStore((s) => s.update !== null);
  const version = useUpdaterStore((s) => s.version);
  const progress = useUpdaterStore((s) => s.progress);
  const cooling = useUpdaterStore((s) => s.cooling);
  const installAndRestart = useUpdaterStore((s) => s.installAndRestart);
  const retryInstall = useUpdaterStore((s) => s.retryInstall);

  if (!hasUpdate && phase !== "error") return null;

  const failed = phase === "error";
  const coolingDown = failed && cooling;
  const working = phase === "checking" || phase === "downloading" || phase === "ready";
  const disabled = working || coolingDown;

  let label = t("update.button.install");
  let title = t("update.button.installTitle", { version: version ? ` (v${version})` : "" });
  let icon = <Download className="w-4 h-4" />;
  if (phase === "checking") {
    label = t("update.button.checking");
    title = label;
    icon = <Loader2 className="w-4 h-4 animate-spin" />;
  } else if (phase === "downloading") {
    label = t("update.button.downloading", { progress });
    title = t("update.button.downloadingTitle");
    icon = <Loader2 className="w-4 h-4 animate-spin" />;
  } else if (phase === "ready") {
    label = t("update.button.restarting");
    title = label;
    icon = <Loader2 className="w-4 h-4 animate-spin" />;
  } else if (failed) {
    label = t("update.button.retry");
    title = coolingDown ? t("update.button.cooldownTitle") : t("update.button.retryTitle");
    icon = <AlertTriangle className="w-4 h-4" />;
  }

  return (
    <button
      type="button"
      onClick={() => (failed ? retryInstall() : installAndRestart())}
      disabled={disabled}
      aria-busy={working}
      title={title}
      className={cn(
        "h-9 px-3 flex items-center gap-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        failed
          ? "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
          : "bg-indigo-600 text-white hover:bg-indigo-500"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
