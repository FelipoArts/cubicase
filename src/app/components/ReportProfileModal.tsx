"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errorMessage";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useT, type TKey } from "@/i18n";
import type { ReportReason } from "@/lib/membership";

const REASONS: { id: ReportReason; labelKey: TKey }[] = [
  { id: "image", labelKey: "report.reason.image" },
  { id: "name_or_bio", labelKey: "report.reason.name_or_bio" },
  { id: "other", labelKey: "report.reason.other" },
];

const NOTE_MAX = 300;

interface Props {
  isOpen: boolean;
  /** Nome de quem está sendo denunciado (só para o texto). */
  name: string;
  onClose: () => void;
  onSubmit: (reason: ReportReason, note: string) => Promise<void>;
}

/** Janela de denúncia de um perfil: o motivo, um detalhe opcional e o envio. Fica por cima de tudo (levada ao body). */
export function ReportProfileModal({ isOpen, name, onClose, onSubmit }: Props) {
  const { t } = useT();
  const [reason, setReason] = useState<ReportReason>("image");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useLockBodyScroll(isOpen);
  // Cada abertura começa do zero
  useEffect(() => { if (isOpen) { setReason("image"); setNote(""); setStatus("idle"); setError(null); } }, [isOpen]);

  async function send() {
    setStatus("sending");
    setError(null);
    try {
      await onSubmit(reason, note);
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err) || t("report.error"));
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("report.title")}>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => status !== "sending" && onClose()} className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-5"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-rose-50 dark:bg-rose-900/30 rounded-lg flex items-center justify-center"><Flag className="text-rose-500 w-5 h-5" /></div>
              <h3 className="text-xl font-bold text-theme-primary">{t("report.title")}</h3>
            </div>

            {status === "sent" ? (
              <div className="space-y-4">
                <p className="text-sm text-theme-secondary flex items-start gap-2"><Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />{t("report.sent")}</p>
                <div className="flex justify-end"><button type="button" onClick={onClose} className="px-6 h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-semibold cursor-pointer transition-colors">{t("report.done")}</button></div>
              </div>
            ) : (
              <>
                <p className="text-sm text-theme-secondary leading-relaxed">{t("report.intro", { name })}</p>
                <div className="space-y-2" role="radiogroup" aria-label={t("report.reason.label")}>
                  {REASONS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={reason === r.id}
                      onClick={() => setReason(r.id)}
                      className={cn("w-full text-left px-4 py-2.5 rounded-xl border-2 text-sm font-semibold cursor-pointer transition-colors", reason === r.id ? "border-indigo-500 bg-theme-accent text-theme-primary" : "border-theme-card text-theme-secondary hover:border-indigo-300")}
                    >{t(r.labelKey)}</button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="report-note" className="text-[11px] font-bold text-theme-primary">{t("report.note.label")}</label>
                  <textarea
                    id="report-note"
                    value={note}
                    rows={3}
                    maxLength={NOTE_MAX}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t("report.note.placeholder")}
                    className="w-full px-3 py-2 border border-theme-card rounded-xl focus:border-indigo-500 focus:outline-none text-sm text-theme-primary bg-theme-card resize-none"
                  />
                </div>
                {error && <p className="text-xs text-rose-500" role="alert">{error}</p>}
                <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
                  <button type="button" onClick={onClose} disabled={status === "sending"} className="px-5 h-11 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold disabled:opacity-40 cursor-pointer">{t("common.cancel")}</button>
                  <button type="button" onClick={send} disabled={status === "sending"} className="px-6 h-11 bg-rose-500 text-white rounded-2xl hover:bg-rose-600 transition-colors text-sm font-semibold disabled:opacity-40 cursor-pointer">
                    {status === "sending" ? t("report.sending") : t("report.send")}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
