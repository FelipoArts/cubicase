"use client";

import { ArrowRight, BedDouble, Globe, Link2, Loader2, ShieldCheck, Smartphone, Sparkles, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime, useT, type TKey } from "@/i18n";
import { tierOf, type PlusStreakView } from "@/lib/profileCatalog";
import { TierCube, isCubeTier } from "@/app/components/TierCube";
import type { SubscriptionInfo } from "@/lib/subscription";

// ============================================================
// Cartões do Cubicase Plus em Configurações → Conta
// ============================================================
// PlusAccountCard: quem assina (plano, renovação, nível, benefícios e os botões de gerenciar e ver os benefícios).
// PlusUpsellCard: quem ainda não assina (um convite no mesmo estilo, com a mesma decoração).
// ============================================================

const SPARKLE = "M0,-9 L2.6,-2.6 L9,0 L2.6,2.6 L0,9 L-2.6,2.6 L-9,0 L-2.6,-2.6Z";

/** Brilhos que surgem e somem em volta do cartão (a animação vem do globals.css e respeita "menos movimento"). */
function Sparkles3({ className }: { className?: string }) {
  const stars: { x: number; y: number; s: number; delay: number; fill: string }[] = [
    { x: 14, y: 12, s: 0.9, delay: 0, fill: "#c4b5fd" },
    { x: 84, y: 22, s: 0.6, delay: 1.1, fill: "#f0abfc" },
    { x: 58, y: 8, s: 0.45, delay: 2, fill: "#ffffff" },
    { x: 92, y: 70, s: 0.75, delay: 0.6, fill: "#a5b4fc" },
    { x: 30, y: 88, s: 0.5, delay: 1.6, fill: "#e9d5ff" },
  ];
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      {stars.map((st, i) => (
        <svg key={i} viewBox="-10 -10 20 20" className="absolute w-5 h-5 overflow-visible" style={{ left: `${st.x}%`, top: `${st.y}%` }}>
          <path className="cube-spark" d={SPARKLE} fill={st.fill} style={{ transform: `scale(${st.s})`, animationDelay: `${st.delay}s`, animationDuration: `${2.6 + (i % 3) * 0.5}s` }} />
        </svg>
      ))}
    </div>
  );
}

/** As luzes de fundo (círculos desfocados) que dão profundidade ao cartão. */
function Glows() {
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute -right-12 -top-14 h-48 w-48 rounded-full bg-violet-500/30 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -left-12 -bottom-16 h-44 w-44 rounded-full bg-indigo-500/25 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute right-1/3 -bottom-20 h-36 w-36 rounded-full bg-fuchsia-500/15 blur-3xl" />
    </>
  );
}

const PERKS: { id: string; icon: LucideIcon; labelKey: TKey }[] = [
  { id: "panel", icon: Smartphone, labelKey: "plusCard.perk.panel" },
  { id: "wake", icon: BedDouble, labelKey: "plusCard.perk.wake" },
  { id: "link", icon: Link2, labelKey: "plusCard.perk.link" },
  { id: "address", icon: Globe, labelKey: "plusCard.perk.address" },
  { id: "private", icon: ShieldCheck, labelKey: "plusCard.perk.private" },
  { id: "team", icon: Users, labelKey: "plusCard.perk.team" },
];

function PerkChips({ className }: { className?: string }) {
  const { t } = useT();
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {PERKS.map(({ id, icon: Icon, labelKey }) => (
        <li key={id} className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/25 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-theme-primary">
          <Icon className="w-3 h-3 text-violet-500 dark:text-violet-300" aria-hidden />{t(labelKey)}
        </li>
      ))}
    </ul>
  );
}

interface AccountProps {
  subscription: SubscriptionInfo;
  /** A sequência de assinatura da conta (nível e dias seguidos); sem ela o cartão mostra só o plano. */
  streak: PlusStreakView | null;
  busy: boolean;
  onManage: () => void;
  onSeeBenefits?: () => void;
}

/** O cartão de quem assina o Plus. */
export function PlusAccountCard({ subscription, streak, busy, onManage, onSeeBenefits }: AccountProps) {
  const { t } = useT();
  const cancels = subscription.cancelAtPeriodEnd;
  const end = subscription.currentPeriodEnd ? formatDateTime(subscription.currentPeriodEnd, { dateStyle: "long" }) : null;
  const level = streak?.phase === "active" && streak.tier ? tierOf(streak.tier) : null;

  return (
    <section className="group/plus relative overflow-hidden rounded-2xl border border-violet-500/30 bg-gradient-to-br from-indigo-600/20 via-violet-600/15 to-fuchsia-600/10 p-5 shadow-lg shadow-violet-950/10 transition-colors hover:border-violet-400/50">
      <Glows />
      <Sparkles3 />

      <div className="relative z-10 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl grid place-items-center bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-violet-900/30"><Sparkles className="w-5 h-5" /></span>
            <h4 className="text-base font-bold text-theme-primary">{t("settings.sub.title")}</h4>
          </div>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold", cancels ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}>
            <span aria-hidden className={cn("w-1.5 h-1.5 rounded-full", cancels ? "bg-amber-500" : "bg-emerald-500")} />
            {t(cancels ? "plusCard.status.ending" : "plusCard.status.active")}
          </span>
        </div>

        <div className="flex items-center gap-4">
          {level && isCubeTier(level.id)
            ? <TierCube tier={level.id} size={68} title={t(level.labelKey)} className="shrink-0 drop-shadow-md" />
            : <span aria-hidden className="w-14 h-14 rounded-2xl shrink-0 grid place-items-center bg-gradient-to-br from-indigo-500/30 to-violet-600/30 border border-violet-500/30"><Sparkles className="w-7 h-7 text-violet-500 dark:text-violet-300" /></span>}
          <div className="min-w-0 space-y-0.5">
            <p className="text-lg font-bold leading-tight text-theme-primary">{t(subscription.plan === "annual" ? "plusCard.plan.annual" : "plusCard.plan.monthly")}</p>
            {end && <p className="text-xs text-theme-secondary">{t(cancels ? "plusCard.cancels" : "plusCard.renews", { date: end })}</p>}
            {level && streak && <p className="text-xs font-semibold" style={{ color: level.hex }}>{t("plustier.active.title", { tier: t(level.labelKey), count: streak.days })}</p>}
          </div>
        </div>

        <PerkChips />

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={onManage}
            disabled={busy}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl border border-violet-500/30 bg-theme-card text-theme-primary font-semibold text-xs transition-colors hover:border-violet-400/80 hover:bg-theme-muted disabled:opacity-50 cursor-pointer"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{busy ? t("settings.sub.opening") : t("settings.sub.manage")}
          </button>
          {onSeeBenefits && (
            <button
              type="button"
              onClick={onSeeBenefits}
              className="group/see inline-flex items-center gap-1.5 h-10 px-4 rounded-xl border border-transparent text-indigo-600 dark:text-violet-300 font-semibold text-xs transition-colors hover:border-violet-400/70 hover:bg-violet-500/10 cursor-pointer"
            >
              {t("settings.sub.seePlus")}<ArrowRight className="w-3.5 h-3.5 transition-transform group-hover/see:translate-x-0.5" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** O convite para quem ainda não assina: o cartão inteiro é o botão. */
export function PlusUpsellCard({ loading, onOpen }: { loading: boolean; onOpen: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/cta relative w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 p-5 text-left text-white shadow-lg shadow-violet-900/25 transition-all hover:border-white/50 hover:shadow-xl hover:shadow-violet-900/35 focus-visible:outline-none focus-visible:border-white/70 cursor-pointer"
    >
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-white/15 blur-2xl" />
      <div aria-hidden className="pointer-events-none absolute -left-8 -bottom-14 h-40 w-40 rounded-full bg-fuchsia-300/20 blur-2xl" />
      <Sparkles3 />
      <span className="relative z-10 flex items-center justify-between gap-3">
        <span className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl grid place-items-center bg-white/15 backdrop-blur-sm"><Sparkles className="w-5 h-5" /></span>
          <span>
            <span className="block text-base font-bold">{t("plus.settings.cta")}</span>
            <span className="block text-xs text-white/85">{loading ? t("settings.sub.checking") : t("plus.settings.ctaHint")}</span>
          </span>
        </span>
        <ArrowRight className="w-5 h-5 shrink-0 transition-transform group-hover/cta:translate-x-1" aria-hidden />
      </span>
    </button>
  );
}
