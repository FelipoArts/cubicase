"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, ShieldAlert, Loader2 } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useT } from "@/i18n";
import { useFirewallHelp } from "@/lib/firewall";

// ============================================================
// FirewallAllowModal
// ============================================================
// Aparece quando a conexão está passando pelo relay porque o Windows bloqueia o cubicase-link (a pessoa clicou em
// Cancelar na pergunta do Firewall). Explica o efeito e oferece o botão que desfaz o bloqueio, com UMA confirmação
// de administrador do Windows. Ver lib/firewall.ts e src-tauri/src/firewall.rs.
// ============================================================

export function FirewallAllowModal() {
  const { t } = useT();
  const { open, state, close, allow } = useFirewallHelp();
  useLockBodyScroll(open);

  const finished = state === "done";

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            role="dialog"
            aria-modal="true"
            aria-label={t("firewall.modal.title")}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-4"
          >
            <button
              type="button"
              onClick={close}
              aria-label={t("firewall.modal.close")}
              className="absolute top-5 right-5 p-1.5 rounded-xl text-theme-secondary hover:bg-theme-muted cursor-pointer"
            >
              <X className="w-4.5 h-4.5" />
            </button>

            <div className="flex items-center gap-3 pr-8">
              <div className="w-10 h-10 rounded-2xl bg-amber-100 dark:bg-amber-900/30 text-amber-600 flex items-center justify-center flex-shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-black text-theme-primary leading-tight">{t("firewall.modal.title")}</h2>
            </div>

            <p className="text-sm text-theme-secondary leading-relaxed">{t("firewall.modal.body")}</p>
            <p className="text-xs text-theme-secondary leading-relaxed">{t("firewall.modal.how")}</p>

            {state === "done" && <p className="text-sm font-semibold text-emerald-600">{t("firewall.modal.done")}</p>}
            {state === "cancelled" && <p className="text-sm font-semibold text-amber-600">{t("firewall.modal.cancelled")}</p>}
            {state === "error" && <p className="text-sm font-semibold text-red-600">{t("firewall.modal.error")}</p>}

            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={close}
                className="h-10 px-4 rounded-xl text-sm font-bold text-theme-secondary hover:bg-theme-muted cursor-pointer"
              >
                {finished ? t("firewall.modal.close") : t("firewall.modal.later")}
              </button>
              {!finished && (
                <button
                  type="button"
                  onClick={() => void allow()}
                  disabled={state === "working"}
                  className="h-10 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold flex items-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  {state === "working" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> {t("firewall.modal.working")}
                    </>
                  ) : (
                    t("firewall.modal.allow")
                  )}
                </button>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
