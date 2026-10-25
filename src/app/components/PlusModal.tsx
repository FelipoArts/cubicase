"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ArrowRight, BedDouble, Check, Link2, Loader2, Lock, ShieldCheck, Smartphone, Sparkles, Users, X, Globe, ExternalLink, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errorMessage";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useAppStore } from "@/app/store";
import { requireAuth } from "@/lib/auth";
import {
  getSubscriptionStatus, isSubscriptionActive, openBillingPortal, openSubscriptionCheckout,
  type SubscriptionInfo, type SubscriptionPlan,
} from "@/lib/subscription";
import { setSubscriptionInfo, usePlusUi } from "@/lib/plusUi";
import { formatDateTime, formatNumber, useT, type TKey } from "@/i18n";

// ============================================================
// Modal do Cubicase Plus
// ============================================================
// Mostra o que o Plus entrega (todos recursos que existem de fato), os planos, e — para quem já assina — o que dá
// para usar agora. Abre pelo menu ("Cubicase Plus") e pelo aviso do painel do host. Depois de abrir o pagamento,
// confere a assinatura de tempos em tempos e comemora quando o Plus é confirmado.
// ============================================================

const PANEL_URL = "https://cubicase.net/painel/";
const MONTHLY = 14.9;
const ANNUAL = 149.9;
const SAVE_PERCENT = Math.round((1 - ANNUAL / (MONTHLY * 12)) * 100);
const POLL_MS = 4000;
const POLL_MAX_MS = 10 * 60 * 1000;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Abre as Configurações do app na categoria Assinatura (onde fica o modo de espera por servidor). */
  onOpenSubscriptionSettings: () => void;
  /** Abre o editor do servidor selecionado (link e endereço personalizados). */
  onConfigureServer: () => void;
}

const BENEFITS: { id: "panel" | "wake" | "link" | "address" | "private" | "team"; icon: typeof Smartphone; accent: string; compare?: boolean }[] = [
  { id: "panel", icon: Smartphone, accent: "from-indigo-500 to-violet-600" },
  { id: "wake", icon: BedDouble, accent: "from-sky-500 to-indigo-600" },
  { id: "link", icon: Link2, accent: "from-emerald-500 to-teal-600", compare: true },
  { id: "address", icon: Globe, accent: "from-amber-500 to-orange-600", compare: true },
  { id: "private", icon: ShieldCheck, accent: "from-rose-500 to-pink-600" },
  { id: "team", icon: Users, accent: "from-fuchsia-500 to-purple-600" },
];

export function PlusModal({ isOpen, onClose, onOpenSubscriptionSettings, onConfigureServer }: Props) {
  const { t } = useT();
  const { feature } = usePlusUi();
  const user = useAppStore((s) => s.user);
  const localServers = useAppStore((s) => s.localServers);
  const selectedServer = useAppStore((s) => s.selectedServer);

  const [sub, setSub] = useState<SubscriptionInfo | null>(null);
  const [loadingSub, setLoadingSub] = useState(false);
  const [plan, setPlan] = useState<SubscriptionPlan>("annual");
  const [busy, setBusy] = useState<"checkout" | "portal" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingPayment, setWaitingPayment] = useState(false);
  const [justActivated, setJustActivated] = useState(false);

  useLockBodyScroll(isOpen);

  const refresh = useCallback(async () => {
    try {
      const info = await getSubscriptionStatus();
      setSub(info);
      setSubscriptionInfo(info); // o resto do app (botões travados do Plus) já enxerga a mudança
      return info;
    } catch {
      setSub(null);
      return null;
    }
  }, []);

  // Confere a assinatura ao abrir (e quando a pessoa entra na conta).
  useEffect(() => {
    if (!isOpen || !user) { setSub(null); return; }
    setLoadingSub(true);
    void refresh().finally(() => setLoadingSub(false));
  }, [isOpen, user, refresh]);

  const active = isSubscriptionActive(sub);

  // Depois de abrir o pagamento: confere de tempos em tempos até o Plus ser confirmado (ou até desistir).
  useEffect(() => {
    if (!isOpen || !waitingPayment) return;
    const started = Date.now();
    const id = window.setInterval(async () => {
      const info = await refresh();
      if (isSubscriptionActive(info) || Date.now() - started > POLL_MAX_MS) {
        setWaitingPayment(false);
        clearInterval(id);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [isOpen, waitingPayment, refresh]);

  // Comemora só quando vira Plus com o modal aberto (depois do pagamento), não a cada abertura de quem já era.
  const prevWaiting = useRef(false);
  useEffect(() => {
    if (prevWaiting.current && !waitingPayment && active) setJustActivated(true);
    prevWaiting.current = waitingPayment;
  }, [waitingPayment, active]);
  useEffect(() => { if (!isOpen) setJustActivated(false); }, [isOpen]);

  async function subscribe() {
    setError(null);
    if (!user) {
      setBusy("login");
      try { await requireAuth(); } catch (err) { setError(errorMessage(err) || t("plus.error.login")); } finally { setBusy(null); }
      return;
    }
    setBusy("checkout");
    try {
      await openSubscriptionCheckout(plan);
      setWaitingPayment(true);
    } catch (err) {
      setError(errorMessage(err) || t("plus.error.checkout"));
    } finally {
      setBusy(null);
    }
  }

  async function manage() {
    setError(null);
    setBusy("portal");
    try { await openBillingPortal(); } catch (err) { setError(errorMessage(err) || t("settings.sub.portalFailed")); } finally { setBusy(null); }
  }

  const brl = (n: number) => formatNumber(n, { style: "currency", currency: "BRL" });
  const wakeTotal = localServers.length;
  const wakeCount = localServers.filter((s) => s.wakeOnDemandEnabled).length;
  const hasSelected = !!selectedServer && localServers.some((s) => s.name === selectedServer);

  const plans: { id: SubscriptionPlan; title: string; price: string; note: string; badge?: string }[] = [
    { id: "annual", title: t("plus.plan.annual"), price: t("plus.plan.billedYearly", { price: brl(ANNUAL) }), note: t("plus.plan.equivalent", { price: brl(ANNUAL / 12) }), badge: t("plus.plan.best", { percent: SAVE_PERCENT }) },
    { id: "monthly", title: t("plus.plan.monthly"), price: t("plus.plan.perMonth", { price: brl(MONTHLY) }), note: "" },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Cubicase Plus">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 18 }}
            transition={{ type: "spring", duration: 0.45 }}
            className="relative w-full max-w-3xl max-h-[92vh] bg-theme-card border-theme-card rounded-[2rem] shadow-2xl z-10 flex flex-col overflow-hidden"
          >
            {/* ---------- Topo ---------- */}
            <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-700 text-white px-8 pt-7 pb-6">
              <div aria-hidden className="absolute -right-10 -top-14 w-56 h-56 rounded-full bg-white/10 blur-2xl" />
              <div aria-hidden className="absolute right-24 -bottom-16 w-44 h-44 rounded-full bg-fuchsia-400/20 blur-2xl" />
              <button type="button" onClick={onClose} aria-label={t("plus.close")} title={t("plus.close")} className="absolute right-4 top-4 p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 cursor-pointer"><X className="w-5 h-5" /></button>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest bg-white/15 px-3 py-1 rounded-full"><Sparkles className="w-3.5 h-3.5" />{t("plus.badge")}</span>
              {active ? (
                <>
                  <h2 className="mt-4 text-3xl font-bold leading-tight">{justActivated ? t("plus.active.title") + " 🎉" : t("plus.active.title")}</h2>
                  <p className="mt-2 text-white/85 max-w-xl">{t("plus.active.thanks")}</p>
                </>
              ) : (
                <>
                  <h2 className="mt-3 text-2xl sm:text-3xl font-bold leading-tight max-w-xl">{t("plus.hero.title")}</h2>
                  <p className="mt-2 text-white/85 max-w-xl">{t("plus.hero.subtitle")}</p>
                </>
              )}
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-8 py-6 space-y-7">
              {/* ---------- Já é Plus ---------- */}
              {active && sub && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-theme-accent border border-theme-accent rounded-2xl px-5 py-4">
                    <div>
                      <p className="text-sm font-bold text-theme-primary flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" />{sub.plan === "annual" ? t("plus.active.plan.annual") : t("plus.active.plan.monthly")}</p>
                      {sub.currentPeriodEnd && (
                        <p className="text-xs text-theme-secondary mt-0.5">{sub.cancelAtPeriodEnd ? t("plus.active.cancels", { date: formatDateTime(sub.currentPeriodEnd, { dateStyle: "long" }) }) : t("plus.active.renews", { date: formatDateTime(sub.currentPeriodEnd, { dateStyle: "long" }) })}</p>
                      )}
                    </div>
                    <button type="button" onClick={manage} disabled={busy !== null} className="h-10 px-4 rounded-xl bg-theme-card border border-theme-card hover:border-indigo-400 text-sm font-bold text-theme-primary disabled:opacity-50 cursor-pointer">
                      {busy === "portal" ? t("settings.sub.opening") : t("plus.active.manage")}
                    </button>
                  </div>

                  {sub.cancelAtPeriodEnd && sub.currentPeriodEnd && (
                    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-amber-800 dark:text-amber-200" role="status">
                      <AlertTriangle className="w-5 h-5 shrink-0" />
                      <p className="flex-1 min-w-48 text-sm">{t("plus.active.cancelWarn", { date: formatDateTime(sub.currentPeriodEnd, { dateStyle: "long" }) })}</p>
                      <button type="button" onClick={manage} disabled={busy !== null} className="h-10 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold disabled:opacity-50 cursor-pointer">{t("plus.active.keep")}</button>
                    </div>
                  )}

                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-theme-secondary mb-3">{t("plus.use.title")}</h3>
                    <ul className="grid sm:grid-cols-3 gap-3">
                      {[
                        { key: "panel", icon: Smartphone, title: t("plus.use.panel"), hint: t("plus.use.panelHint"), onClick: () => void openExternal(PANEL_URL), external: true },
                        { key: "wake", icon: BedDouble, title: t("plus.use.wake"), hint: wakeTotal > 0 && wakeCount > 0 ? t("plus.use.wakeHint", { count: wakeCount, total: wakeTotal }) : t("plus.use.wakeNone"), onClick: () => { onClose(); onOpenSubscriptionSettings(); }, external: false },
                        { key: "names", icon: Link2, title: t("plus.use.names"), hint: hasSelected ? t("plus.use.namesHint") : t("plus.use.namesNone"), onClick: () => { onClose(); onConfigureServer(); }, external: false, disabled: !hasSelected },
                      ].map(({ key, icon: Icon, title, hint, onClick, external, disabled }) => (
                        <li key={key}>
                          <button type="button" onClick={onClick} disabled={disabled} className="w-full h-full text-left rounded-2xl border border-theme-card bg-theme-muted hover:border-indigo-400 p-4 space-y-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                            <span className="flex items-center justify-between">
                              <span className="w-9 h-9 rounded-xl bg-theme-card border border-theme-card grid place-items-center"><Icon className="w-4 h-4 text-indigo-600" /></span>
                              {external ? <ExternalLink className="w-4 h-4 text-theme-secondary" /> : <ArrowRight className="w-4 h-4 text-theme-secondary" />}
                            </span>
                            <span className="block text-sm font-bold text-theme-primary">{title}</span>
                            <span className="block text-xs text-theme-secondary">{hint}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              {user && loadingSub && !sub && <p className="text-sm text-theme-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t("plus.active.checking")}</p>}

              {/* O pedido veio de um botão travado: diz qual recurso é e o que fazer */}
              {feature && !active && (
                <div className="flex items-start gap-3 rounded-2xl border border-indigo-500/30 bg-theme-accent px-5 py-4" role="status">
                  <span className="w-9 h-9 rounded-xl bg-indigo-600 text-white grid place-items-center shrink-0"><Lock className="w-4 h-4" /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-theme-primary">{t(`plus.feature.${feature}.title` as TKey)}</p>
                    <p className="text-sm text-theme-secondary mt-0.5">{t("plus.feature.hint")}</p>
                  </div>
                </div>
              )}

              {/* ---------- Benefícios ---------- */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-theme-secondary mb-3">{t("plus.benefits.title")}</h3>
                <ul className="grid sm:grid-cols-2 gap-3">
                  {BENEFITS.map(({ id, icon: Icon, accent, compare }, i) => (
                    <motion.li
                      key={id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 + i * 0.05 }}
                      className={cn("rounded-2xl border bg-theme-muted p-4 space-y-2.5", feature === id ? "border-indigo-500 ring-2 ring-indigo-500/30" : "border-theme-card", i === BENEFITS.length - 1 && BENEFITS.length % 2 === 1 && "sm:col-span-2")}
                    >
                      <div className="flex items-start gap-3">
                        <span className={cn("w-10 h-10 rounded-xl grid place-items-center text-white bg-gradient-to-br shrink-0", accent)}><Icon className="w-5 h-5" /></span>
                        <div className="min-w-0">
                          <p className="font-bold text-theme-primary">{t(`plus.b.${id}.title` as TKey)}</p>
                          <p className="text-sm text-theme-secondary mt-0.5 leading-relaxed">{t(`plus.b.${id}.text` as TKey)}</p>
                        </div>
                      </div>
                      {compare ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                          <span className="px-2.5 py-1 rounded-lg bg-theme-card border border-theme-card text-theme-secondary line-through decoration-theme-secondary/50">{t(`plus.b.${id}.before` as TKey)}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-indigo-600" />
                          <span className="px-2.5 py-1 rounded-lg bg-theme-accent border border-theme-accent text-indigo-700 dark:text-indigo-300 font-bold">{t(`plus.b.${id}.after` as TKey)}</span>
                        </div>
                      ) : (
                        <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-theme-accent border border-theme-accent rounded-lg px-3 py-1.5 inline-block">{t(`plus.b.${id}.example` as TKey)}</p>
                      )}
                    </motion.li>
                  ))}
                </ul>
              </div>

              {active && error && <p className="text-sm text-rose-500" role="alert">{error}</p>}
            </div>

            {/* ---------- Planos e botão: sempre à vista, sem precisar rolar até o fim ---------- */}
            {!active && !(user && loadingSub && !sub) && (
              <div className="shrink-0 border-t border-theme-card bg-theme-card px-8 py-4 space-y-3">
                <div className="grid sm:grid-cols-2 gap-2.5" role="radiogroup" aria-label={t("plus.plans.title")}>
                  {plans.map((p) => {
                    const selected = plan === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setPlan(p.id)}
                        className={cn("relative text-left rounded-xl border-2 px-4 py-2.5 cursor-pointer transition-colors", selected ? "border-indigo-500 bg-theme-accent" : "border-theme-card hover:border-indigo-300")}
                      >
                        {p.badge && <span className="absolute -top-2.5 right-3 text-[10px] font-bold uppercase tracking-wider bg-emerald-500 text-white px-2 py-0.5 rounded-full">{p.badge}</span>}
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-bold text-theme-primary text-sm">{p.title}</span>
                          <span className={cn("w-4 h-4 rounded-full border-2 grid place-items-center shrink-0", selected ? "border-indigo-600 bg-indigo-600" : "border-theme-card")}>{selected && <Check className="w-2.5 h-2.5 text-white" strokeWidth={4} />}</span>
                        </span>
                        <span className="block text-xs text-theme-primary mt-0.5 font-semibold">{p.price}{p.note && <span className="text-theme-secondary font-normal"> · {p.note}</span>}</span>
                      </button>
                    );
                  })}
                </div>

                {!user && <p className="text-xs text-theme-secondary">{t("plus.cta.loginHint")}</p>}
                {waitingPayment && (
                  <p className="flex items-center gap-2 text-xs text-indigo-700 dark:text-indigo-300 bg-theme-accent border border-theme-accent rounded-xl px-3 py-2" role="status"><Loader2 className="w-4 h-4 animate-spin shrink-0" />{t("plus.waiting")}</p>
                )}
                {error && <p className="text-sm text-rose-500" role="alert">{error}</p>}

                <button
                  type="button"
                  onClick={subscribe}
                  disabled={busy !== null}
                  className="w-full h-12 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-bold shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-wait cursor-pointer"
                >
                  {busy ? <><Loader2 className="w-5 h-5 animate-spin" />{t("plus.cta.opening")}</> : <><Sparkles className="w-5 h-5" />{user ? t("plus.cta.subscribe") : t("plus.cta.login")}</>}
                </button>
                <p className="text-[10px] text-theme-secondary leading-relaxed text-center">{t("plus.fine")}</p>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
