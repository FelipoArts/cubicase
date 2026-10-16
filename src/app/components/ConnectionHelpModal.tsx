"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { X, LifeBuoy, ExternalLink } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { cn } from "@/lib/utils";
import { getLocale, useT } from "@/i18n";
import { tutorialUrl } from "@/lib/help";
import { useConnectionHelp } from "@/lib/connectionHelp";
import { GuestGuide, HostGuide } from "@/app/components/RadminGuides";

// ============================================================
// ConnectionHelpModal
// ============================================================
// Plano B para quando a conexão normal não funciona: guia, em linguagem simples, o uso do Radmin VPN (grátis, sem
// abrir portas), com os passos marcados sozinhos conforme ficam prontos (ver RadminGuides.tsx). Abre sozinha numa
// falha de conexão (uma vez a cada 10 min) e sempre pode ser aberta pela Central de Ajuda ou pelo botão de boia
// no cartão de um servidor.
// ============================================================

function HelpBody({ defaultTab, onUseRadmin }: { defaultTab: "host" | "guest"; onUseRadmin: (shortCode: string) => void }) {
  const { t } = useT();
  const { reason, close } = useConnectionHelp();
  const [tab, setTab] = useState(defaultTab);

  return (
    <>
      <div className="space-y-2 pr-8">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-5 h-5 text-indigo-500" />
          </div>
          <h3 className="text-xl font-bold text-theme-primary">{t("connhelp.title")}</h3>
        </div>
        <p className="text-sm text-theme-secondary leading-relaxed">{t(`connhelp.why.${reason}`)}</p>
        <p className="text-sm text-theme-secondary leading-relaxed">{t("connhelp.intro")}</p>
      </div>

      <div className="flex bg-theme-muted p-1 rounded-2xl border border-theme-card" role="tablist">
        {(["host", "guest"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer",
              tab === id ? "bg-indigo-600 text-white shadow-sm" : "text-theme-secondary hover:text-theme-primary",
            )}
          >
            {t(id === "host" ? "connhelp.tab.host" : "connhelp.tab.guest")}
          </button>
        ))}
      </div>

      <div className="border-t border-theme-card pt-5">
        {tab === "host" ? (
          <HostGuide />
        ) : (
          <GuestGuide
            onPlay={(shortCode) => {
              close();
              onUseRadmin(shortCode);
            }}
          />
        )}
      </div>

      <p className="text-xs text-theme-secondary leading-relaxed border-t border-theme-card pt-4">{t("connhelp.keep")}</p>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => void openExternal(tutorialUrl(getLocale(), "problemas-conexao")).catch(() => {})}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-500 hover:underline cursor-pointer"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          {t("connhelp.tutorial")}
        </button>
        <button
          type="button"
          onClick={close}
          className="h-10 px-5 rounded-xl border border-theme-card hover:bg-theme-muted text-sm font-bold text-theme-primary transition-colors cursor-pointer"
        >
          {t("connhelp.close")}
        </button>
      </div>
    </>
  );
}

export function ConnectionHelpModal({ onUseRadmin }: { onUseRadmin: (shortCode: string) => void }) {
  const { t } = useT();
  const { open, target, close } = useConnectionHelp();

  useLockBodyScroll(open);

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
            aria-label={t("connhelp.title")}
            className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-5"
          >
            <button
              type="button"
              onClick={close}
              aria-label={t("connhelp.close")}
              className="absolute top-5 right-5 p-1.5 rounded-xl text-theme-secondary hover:bg-theme-muted cursor-pointer"
            >
              <X className="w-4.5 h-4.5" />
            </button>
            {/* A aba inicial segue o contexto (com servidor escolhido = quem entra); remonta a cada abertura. */}
            <HelpBody key={target?.shortCode ?? "host"} defaultTab={target ? "guest" : "host"} onUseRadmin={onUseRadmin} />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
