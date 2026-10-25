"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { useT } from "@/i18n";
import { dismissBackup, useBackupState } from "@/lib/backupState";
import { formatBytes } from "@/lib/modSync";
import { cn } from "@/lib/utils";

// Aviso fixo enquanto o backup do mundo roda (pode levar minutos em mundos grandes) e por alguns segundos depois,
// com o resultado. Fica no centro de baixo para não cobrir os avisos comuns, que aparecem no canto direito.
export function BackupIndicator() {
  const { t } = useT();
  const b = useBackupState();
  const visible = b.phase !== "idle";
  const running = b.phase === "running";
  const failed = b.phase === "failed";

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[90] w-[min(92vw,26rem)] pointer-events-none">
      <AnimatePresence>
        {visible && (
          <motion.div
            key="backup"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, transition: { duration: 0.15 } }}
            className={cn(
              "pointer-events-auto rounded-2xl border shadow-lg backdrop-blur-xl p-4 flex items-start gap-3",
              failed ? "bg-theme-danger border-theme-danger" : "bg-theme-card border-theme-card",
            )}
          >
            {running && <Loader2 className="w-5 h-5 mt-0.5 shrink-0 text-indigo-500 animate-spin" />}
            {b.phase === "done" && <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-emerald-500" />}
            {failed && <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-rose-500" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-theme-primary">
                {running ? t("backupUi.running.title", { name: b.serverName }) : failed ? t("backupUi.failed.title") : t("backupUi.done.title")}
              </p>
              {running && (
                <>
                  <p className="text-xs text-theme-secondary mt-1">{t("backupUi.running.hint")}</p>
                  {b.source === "remote" && <p className="text-xs text-theme-secondary mt-1">{t("backupUi.running.remote")}</p>}
                  <div className="mt-3 h-1.5 rounded-full bg-theme-muted overflow-hidden">
                    <motion.div
                      className="h-full w-1/3 rounded-full bg-indigo-500"
                      animate={{ x: ["-100%", "300%"] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                    />
                  </div>
                </>
              )}
              {b.phase === "done" && (
                <p className="text-xs text-theme-secondary mt-1 break-all">
                  {b.fileName} {b.sizeBytes != null && `(${formatBytes(b.sizeBytes)})`}
                </p>
              )}
              {failed && <p className="text-xs text-theme-secondary mt-1 break-words">{b.error}</p>}
            </div>
            {!running && (
              <button type="button" onClick={dismissBackup} aria-label={t("plus.close")} className="p-1 rounded-lg text-theme-secondary hover:text-theme-primary cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
