"use client";

import { useState } from "react";
import { Check, ChevronDown, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime, useT } from "@/i18n";
import { PLUS_TIERS, tierOf, tierProgress, type PlusStreakView } from "@/lib/profileCatalog";
import { TierCube } from "@/app/components/TierCube";

/**
 * O nível do Plus da própria conta: o cubo atual em destaque, o tempo seguido e, ao clicar, todos os níveis em grade
 * (cubo, nome e a condição de cada um) com a barra do que falta para o próximo.
 */
export function PlusTierPanel({ streak }: { streak: PlusStreakView }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (streak.phase === "none" || !streak.tier) return null;

  const grace = streak.phase === "grace";
  const level = tierOf(streak.tier);
  const progress = tierProgress(streak.days);
  const reachedIndex = PLUS_TIERS.findIndex((x) => x.id === streak.tier);

  return (
    <div className={cn("rounded-2xl border overflow-hidden", grace ? "border-amber-500/30 bg-amber-500/10" : "border-theme-card bg-theme-muted")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-4 px-4 py-3 text-left cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <TierCube tier={level.id} size={64} title={t(level.labelKey)} className="shrink-0 drop-shadow-sm" />
        <span className="min-w-0 flex-1 space-y-0.5" role={grace ? "alert" : "status"}>
          <span className="block text-sm font-bold text-theme-primary">
            {grace
              ? t("plustier.grace.title")
              : t("plustier.active.title", { tier: t(level.labelKey), count: streak.days })}
          </span>
          <span className="block text-[11px] text-theme-secondary">
            {grace && streak.graceEndsAt
              ? t("plustier.grace.hint", { date: formatDateTime(streak.graceEndsAt, { dateStyle: "long" }), tier: t(level.labelKey) })
              : t("plustier.active.hint")}
          </span>
          <span className="block text-[11px] font-semibold text-indigo-600">{open ? t("plustier.collapse") : t("plustier.expand")}</span>
        </span>
        <ChevronDown className={cn("w-5 h-5 text-theme-secondary shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-theme-card/60">
          {/* Quanto falta para o próximo nível */}
          <div className="space-y-1.5 pt-3">
            <p className="text-xs font-bold text-theme-primary">
              {progress.next
                ? t("plustier.next", { count: progress.daysToNext, tier: t(progress.next.labelKey) })
                : t("plustier.max")}
            </p>
            <div
              className="h-2.5 rounded-full bg-theme-card border border-theme-card overflow-hidden"
              role="progressbar"
              aria-label={t("plustier.progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.fraction * 100)}
            >
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.round(progress.fraction * 100)}%`, backgroundColor: (progress.next ?? progress.current).hex }} />
            </div>
            {progress.next && (
              <p className="flex justify-between text-[10px] text-theme-secondary">
                <span>{t(progress.current.labelKey)}</span>
                <span>{t(progress.next.labelKey)}</span>
              </p>
            )}
          </div>

          {/* Todos os níveis */}
          <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label={t("plustier.path")}>
            {PLUS_TIERS.map((lv, i) => {
              const reached = i <= reachedIndex;
              const current = lv.id === streak.tier;
              return (
                <li
                  key={lv.id}
                  className={cn(
                    "relative rounded-xl border-2 px-2 py-3 flex flex-col items-center text-center gap-1.5",
                    current ? "border-indigo-500 bg-theme-accent" : "border-theme-card bg-theme-card",
                  )}
                >
                  <span className={cn(!reached && "opacity-40 grayscale")}><TierCube tier={lv.id} size={48} effects={reached} /></span>
                  <span className="text-xs font-bold text-theme-primary">{t(lv.labelKey)}</span>
                  <span className="text-[10px] leading-tight text-theme-secondary">
                    {lv.months === 0 ? t("plustier.cond.start") : t("plustier.months", { count: lv.months })}
                  </span>
                  <span className="absolute top-1.5 right-1.5">
                    {current
                      ? <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-600">{t("plustier.current")}</span>
                      : reached
                        ? <Check className="w-3.5 h-3.5 text-emerald-500" strokeWidth={3} aria-label={t("plustier.unlocked")} />
                        : <Lock className="w-3 h-3 text-theme-secondary" aria-label={t("plustier.locked")} />}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
