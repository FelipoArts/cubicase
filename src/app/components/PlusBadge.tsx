"use client";

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { tierOf } from "@/lib/profileCatalog";
import { TierCube, isCubeTier } from "@/app/components/TierCube";

interface Props {
  /** Nível do badge de tempo de assinatura; sem ele, o selo "Plus" neutro. */
  tier?: string | null;
  /** Só o cubo (barras estreitas). */
  compact?: boolean;
  className?: string;
}

/** Selo do Cubicase Plus: o cubo do material do nível de tempo de assinatura, com o nome dele. */
export function PlusBadge({ tier, compact, className }: Props) {
  const { t } = useT();
  const level = tier && isCubeTier(tier) ? tierOf(tier) : null;
  const title = level ? t("plustier.title", { tier: t(level.labelKey) }) : t("members.plus");

  if (compact) {
    return (
      <span className={cn("inline-flex items-center shrink-0", className)} title={title} aria-label={title}>
        {level && isCubeTier(level.id) ? <TierCube tier={level.id} size={18} /> : <Sparkles className="w-4 h-4 text-indigo-600" />}
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full pl-1.5 pr-2.5 py-0.5 border shrink-0", !level && "border-indigo-500/40 bg-indigo-500/10 text-indigo-600", className)}
      style={level ? { color: level.hex, borderColor: `${level.hex}66`, backgroundColor: `${level.hex}1f` } : undefined}
      title={title}
      aria-label={title}
    >
      {level && isCubeTier(level.id) ? <TierCube tier={level.id} size={16} /> : <Sparkles className="w-3 h-3" />}
      Plus{level && <span className="font-semibold normal-case tracking-normal opacity-90">· {t(level.labelKey)}</span>}
    </span>
  );
}
