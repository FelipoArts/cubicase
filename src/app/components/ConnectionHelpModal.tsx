"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Download, Copy, Check, X, LifeBuoy, ExternalLink } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { getLocale, useT } from "@/i18n";
import { tutorialUrl } from "@/lib/help";
import { useAppStore } from "@/app/store";
import { RADMIN_DOWNLOAD_URL, radminJoinAddress, useConnectionHelp } from "@/lib/connectionHelp";

// ============================================================
// ConnectionHelpModal
// ============================================================
// Plano B para quando a conexão normal não funciona: guia, em linguagem simples, o uso do Radmin VPN
// (grátis, sem abrir portas). Mostra o endereço do Radmin deste computador pronto para copiar —
// é o que o amigo digita no Minecraft. Aparece sozinho numa falha de conexão (uma vez a cada 10
// min) e sempre pode ser aberta pelo botão "Não consegue conectar?".
// ============================================================

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-indigo-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{n}</div>
      <div className="space-y-1.5 min-w-0">
        <p className="text-sm font-bold text-theme-primary">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function ConnectionHelpModal() {
  const { t } = useT();
  const { open, reason, close } = useConnectionHelp();
  const port = useAppStore((s) => s.minecraftPort);
  const [radminIp, setRadminIp] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useLockBodyScroll(open);

  // Procura o IP do Radmin enquanto a janela está aberta (aparece sozinho quando o usuário conecta).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = () => {
      invoke<string | null>("get_radmin_address")
        .then((ip) => { if (!cancelled) setRadminIp(ip ?? null); })
        .catch(() => { if (!cancelled) setRadminIp(null); });
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [open]);

  const address = radminIp ? radminJoinAddress(radminIp, port) : null;

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* área de transferência indisponível: o endereço continua visível para copiar à mão */ }
  };

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

            <div className="space-y-5 border-t border-theme-card pt-5">
              <Step n={1} title={t("connhelp.step1.title")}>
                <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.step1.desc")}</p>
                <button
                  type="button"
                  onClick={() => void openExternal(RADMIN_DOWNLOAD_URL).catch(() => {})}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-bold transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  {t("connhelp.step1.button")}
                </button>
              </Step>

              <Step n={2} title={t("connhelp.step2.title")}>
                <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.step2.desc")}</p>
                <p className="text-xs text-theme-secondary leading-relaxed">
                  <span className="font-bold text-theme-primary">{t("connhelp.step2b.title")}.</span> {t("connhelp.step2b.desc")}
                </p>
              </Step>

              <Step n={3} title={t("connhelp.step3.title")}>
                {address ? (
                  <>
                    <p className="text-xs text-theme-secondary">{t("connhelp.step3.found")}</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 min-w-0 truncate px-3 h-10 flex items-center rounded-xl bg-theme-muted border border-theme-card text-sm font-bold text-theme-primary select-all">{address}</code>
                      <button
                        type="button"
                        onClick={copy}
                        className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-xl border border-theme-card hover:bg-theme-muted text-sm font-bold text-theme-primary transition-colors cursor-pointer shrink-0"
                      >
                        {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                        {copied ? t("connhelp.step3.copied") : t("connhelp.step3.copy")}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.step3.notFound")}</p>
                )}
              </Step>

              <Step n={4} title={t("connhelp.step4.title")}>
                <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.step4.desc")}</p>
              </Step>
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
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
