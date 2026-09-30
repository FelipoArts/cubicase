"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HelpCircle, X, ExternalLink, Send, CheckCircle2, Loader2, BookOpen } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { getLocale, useT, type TKey } from "@/i18n";
import { tutorialUrl } from "@/lib/help";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
  describeOs,
  loadSavedEmail,
  saveEmail,
  sendFeedback,
  validateFeedback,
  type FeedbackCategory,
  type FeedbackField,
} from "@/lib/feedback";

// ============================================================
// HelpCenter
// ============================================================
// Janela aberta pelo botão "?" do cabeçalho. Em destaque, o formulário de
// relato (bug, problema, sugestão) — vai por e-mail para o mantenedor, com o
// e-mail informado como Reply-To. Ao lado, atalhos para o tutorial do site.
// ============================================================

const GUIDES = [
  ["criar-servidor", "help.guide.criar-servidor"],
  ["convidar-amigos", "help.guide.convidar-amigos"],
  ["entrar-servidor", "help.guide.entrar-servidor"],
  ["preparar-jogar", "help.guide.preparar-jogar"],
  ["mods-plugins", "help.guide.mods-plugins"],
  ["mundo-backups", "help.guide.mundo-backups"],
  ["problemas-conexao", "help.guide.problemas-conexao"],
  ["crashes", "help.guide.crashes"],
  ["faq", "help.guide.faq"],
] as const satisfies ReadonlyArray<readonly [string, TKey]>;

const TYPE_KEYS: Record<FeedbackCategory, TKey> = {
  bug: "help.type.bug",
  problem: "help.type.problem",
  suggestion: "help.type.suggestion",
  other: "help.type.other",
};

const INPUT_CLASS =
  "w-full px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm text-theme-primary bg-transparent disabled:opacity-60";

interface HelpCenterProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HelpCenter({ isOpen, onClose }: HelpCenterProps) {
  const { t } = useT();
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState(loadSavedEmail);
  const [includeTech, setIncludeTech] = useState(true);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<FeedbackField | null>(null);
  const [appVersion, setAppVersion] = useState("");
  // Trava síncrona: `sending` só vira true na próxima renderização, então dois
  // cliques muito rápidos ainda passariam. O ref fecha essa brecha.
  const submitting = useRef(false);

  useLockBodyScroll(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const errorFor = (field: FeedbackField | null): string => {
    switch (field) {
      case "category":
        return t("help.err.category");
      case "subject":
        return t("help.err.subject", { min: FEEDBACK_LIMITS.subjectMin, max: FEEDBACK_LIMITS.subjectMax });
      case "message":
        return t("help.err.message", { min: FEEDBACK_LIMITS.messageMin, max: FEEDBACK_LIMITS.messageMax });
      case "email":
        return t("help.err.email");
      default:
        return t("help.err.generic");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;

    const draft = { category, subject, message, email };
    const invalid = validateFeedback(draft);
    if (invalid) {
      setBadField(invalid);
      setError(errorFor(invalid));
      return;
    }

    submitting.current = true;
    setSending(true);
    setError(null);
    setBadField(null);
    try {
      const result = await sendFeedback(draft, includeTech ? { appVersion, os: describeOs() } : {});
      if (result.ok) {
        saveEmail(email);
        setSentTo(email.trim());
        setSubject("");
        setMessage("");
        return;
      }
      switch (result.reason) {
        case "validation":
          setBadField(result.field);
          setError(errorFor(result.field));
          break;
        case "rate":
          setError(t("help.err.rate"));
          break;
        case "unavailable":
          setError(t("help.err.unavailable"));
          break;
        case "network":
          setError(t("help.err.network"));
          break;
        default:
          setError(t("help.err.generic"));
      }
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  const openGuide = (id?: string) => {
    openExternal(tutorialUrl(getLocale(), id)).catch(() => {});
  };

  const fieldClass = (field: FeedbackField) => `${INPUT_CLASS} ${badField === field ? "!border-rose-500" : ""}`;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !sending && onClose()}
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            role="dialog"
            aria-modal="true"
            aria-label={t("help.title")}
            className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-theme-card rounded-[2rem] border-theme-card shadow-2xl z-10"
          >
            <div className="flex items-start justify-between gap-4 p-8 pb-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center shrink-0">
                  <HelpCircle className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-theme-primary">{t("help.title")}</h3>
                  <p className="text-sm text-theme-secondary">{t("help.subtitle")}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                title={t("help.close")}
                className="w-9 h-9 flex items-center justify-center rounded-xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors cursor-pointer disabled:opacity-40"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            <div className="grid md:grid-cols-[1fr_15rem] gap-6 p-8 pt-4">
              {/* Formulário: bloco principal */}
              <section className="space-y-4">
                <div>
                  <h4 className="text-base font-bold text-theme-primary">{t("help.form.title")}</h4>
                  <p className="text-xs text-theme-secondary">{t("help.form.hint")}</p>
                </div>

                {sentTo ? (
                  <div className="rounded-2xl border border-theme-card p-6 text-center space-y-3">
                    <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
                    <div className="text-base font-bold text-theme-primary">{t("help.sent.title")}</div>
                    <p className="text-sm text-theme-secondary">{t("help.sent.body", { email: sentTo })}</p>
                    <button
                      type="button"
                      onClick={() => setSentTo(null)}
                      className="px-5 h-10 rounded-2xl text-sm font-semibold text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors cursor-pointer"
                    >
                      {t("help.sent.another")}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide" htmlFor="help-type">
                        {t("help.form.type")}
                      </label>
                      <select
                        id="help-type"
                        value={category}
                        onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
                        disabled={sending}
                        className={`${fieldClass("category")} h-11 bg-theme-card`}
                      >
                        {FEEDBACK_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {t(TYPE_KEYS[c])}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide" htmlFor="help-subject">
                        {t("help.form.subject")}
                      </label>
                      <input
                        id="help-subject"
                        type="text"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        maxLength={FEEDBACK_LIMITS.subjectMax}
                        placeholder={t("help.form.subjectPlaceholder")}
                        disabled={sending}
                        className={`${fieldClass("subject")} h-11`}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide" htmlFor="help-message">
                        {t("help.form.message")}
                      </label>
                      <textarea
                        id="help-message"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        maxLength={FEEDBACK_LIMITS.messageMax}
                        rows={6}
                        placeholder={t("help.form.messagePlaceholder")}
                        disabled={sending}
                        className={`${fieldClass("message")} py-3 resize-y min-h-[8rem]`}
                      />
                      <div className="text-[11px] text-theme-secondary text-right">
                        {message.length}/{FEEDBACK_LIMITS.messageMax}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide" htmlFor="help-email">
                        {t("help.form.email")}
                      </label>
                      <input
                        id="help-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        maxLength={FEEDBACK_LIMITS.emailMax}
                        placeholder={t("help.form.emailPlaceholder")}
                        autoComplete="email"
                        disabled={sending}
                        className={`${fieldClass("email")} h-11`}
                      />
                      <p className="text-[11px] text-theme-secondary">{t("help.form.emailHint")}</p>
                    </div>

                    <label className="flex items-start gap-2.5 text-xs text-theme-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeTech}
                        onChange={(e) => setIncludeTech(e.target.checked)}
                        disabled={sending}
                        className="mt-0.5 accent-indigo-600"
                      />
                      <span>{t("help.form.tech")}</span>
                    </label>

                    {error && (
                      <div role="alert" className="text-sm rounded-2xl border border-rose-300 bg-rose-50 dark:bg-rose-900/20 dark:border-rose-800 text-rose-700 dark:text-rose-300 px-4 py-3">
                        {error}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={sending}
                      className="w-full h-12 rounded-2xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {sending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" /> {t("help.form.sending")}
                        </>
                      ) : (
                        <>
                          <Send className="w-4 h-4" /> {t("help.form.submit")}
                        </>
                      )}
                    </button>
                  </form>
                )}
              </section>

              {/* Guias rápidos */}
              <aside className="space-y-3 md:border-l md:border-theme-card md:pl-6">
                <div>
                  <h4 className="text-base font-bold text-theme-primary flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-indigo-500" /> {t("help.guides.title")}
                  </h4>
                  <p className="text-xs text-theme-secondary">{t("help.guides.hint")}</p>
                </div>
                <ul className="space-y-1">
                  {GUIDES.map(([id, key]) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => openGuide(id)}
                        className="w-full text-left text-sm px-3 py-2 rounded-xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors cursor-pointer"
                      >
                        {t(key)}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => openGuide()}
                  className="w-full h-10 rounded-2xl border border-theme-card text-sm font-semibold text-theme-primary hover:bg-theme-muted transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  {t("help.guides.all")} <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </aside>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
