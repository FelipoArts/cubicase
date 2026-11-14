// ============================================================
// Catálogo visual do perfil (Fase 1: só itens grátis)
// ============================================================
// O Worker só conhece os ids (api/src/profile.ts) e rejeita qualquer id fora da
// lista; o visual de cada um mora aqui. Se um id novo entrar, entra nos dois lados.
// Ícones genéricos de propósito: nada que seja marca da Mojang.
// ============================================================

import { Flame, Heart, Leaf, Moon, Pickaxe, Star, Sword, Box, type LucideIcon } from "lucide-react";
import type { TKey } from "@/i18n";

export interface UserProfile {
  displayName: string;
  avatarId: string;
  nameColor: string | null;
  /** A frase "sobre você" (até BIO_MAX caracteres), ou null. */
  bio: string | null;
  /** Foto de perfil enviada (hash do conteúdo; ver profileImageUrl). Só existe para quem assina o Plus. */
  avatarHash: string | null;
  /** Imagem de banner enviada. Mesma regra da foto. */
  bannerHash: string | null;
}

/**
 * O perfil da PRÓPRIA conta como deve aparecer: as imagens enviadas só valem enquanto o Plus está ativo (sem ele ficam
 * guardadas, e voltam ao reassinar). Para os perfis dos outros o Worker já entrega sem as imagens quando não há Plus.
 */
export function ownProfileView(profile: UserProfile, plusActive: boolean): UserProfile {
  return plusActive ? profile : { ...profile, avatarHash: null, bannerHash: null };
}

/** Níveis do badge de tempo de assinatura do Plus (a regra e os limites moram no Worker: api/src/plus-tier.ts). */
export type PlusTierId = "wood" | "stone" | "iron" | "gold" | "redstone" | "diamond" | "emerald" | "netherite";

/** `months` é só para exibir o caminho até cada nível; quem decide o nível é o Worker (api/src/plus-tier.ts). */
export const PLUS_TIERS: { id: PlusTierId; hex: string; months: number; labelKey: TKey }[] = [
  { id: "wood", hex: "#a16207", months: 0, labelKey: "plustier.wood" },
  { id: "stone", hex: "#78716c", months: 1, labelKey: "plustier.stone" },
  { id: "iron", hex: "#64748b", months: 3, labelKey: "plustier.iron" },
  { id: "gold", hex: "#d97706", months: 6, labelKey: "plustier.gold" },
  { id: "redstone", hex: "#dc2626", months: 12, labelKey: "plustier.redstone" },
  { id: "diamond", hex: "#0891b2", months: 18, labelKey: "plustier.diamond" },
  { id: "emerald", hex: "#059669", months: 24, labelKey: "plustier.emerald" },
  { id: "netherite", hex: "#6d28d9", months: 36, labelKey: "plustier.netherite" },
];

export function tierOf(id: string | null | undefined) {
  return PLUS_TIERS.find((t) => t.id === id) ?? PLUS_TIERS[0];
}

/** Um "mês" de assinatura para os níveis: 30 dias (igual ao Worker). */
export const DAYS_PER_MONTH = 30;

export interface TierProgress {
  /** Nível que o tempo contínuo já alcançou. */
  current: (typeof PLUS_TIERS)[number];
  /** Próximo nível, ou null no último. */
  next: (typeof PLUS_TIERS)[number] | null;
  /** Dias que faltam para o próximo nível (0 no último). */
  daysToNext: number;
  /** Quanto do caminho entre o nível atual e o próximo já foi percorrido (0 a 1; 1 no último). */
  fraction: number;
}

/** Onde o tempo contínuo de assinatura (em dias) está no caminho dos níveis. */
export function tierProgress(days: number): TierProgress {
  const d = Math.max(0, Number.isFinite(days) ? days : 0);
  let idx = 0;
  PLUS_TIERS.forEach((lv, i) => { if (d >= lv.months * DAYS_PER_MONTH) idx = i; });
  const current = PLUS_TIERS[idx];
  const next = PLUS_TIERS[idx + 1] ?? null;
  if (!next) return { current, next: null, daysToNext: 0, fraction: 1 };
  const from = current.months * DAYS_PER_MONTH;
  const to = next.months * DAYS_PER_MONTH;
  return { current, next, daysToNext: Math.ceil(to - d), fraction: Math.min(1, Math.max(0, (d - from) / (to - from))) };
}

/** A sequência de assinatura da própria conta (só o dono vê): nível ativo, ou a janela de 7 dias para não perdê-lo. */
export interface PlusStreakView {
  phase: "active" | "grace" | "none";
  tier: PlusTierId | null;
  days: number;
  graceEndsAt: string | null;
}

export const BIO_MAX = 160;
/** Quantas linhas a bio pode ter. */
export const BIO_MAX_LINES = 3;

/** Arruma a bio como o Worker: espaços repetidos viram um, cada linha é aparada e linhas em branco somem. */
export function normalizeBio(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}
export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 20;
export const DEFAULT_AVATAR_ID = "cube";
export const DEFAULT_COLOR_ID = "indigo";

export const AVATARS: { id: string; icon: LucideIcon; labelKey: TKey }[] = [
  { id: "cube", icon: Box, labelKey: "profile.avatar.cube" },
  { id: "pickaxe", icon: Pickaxe, labelKey: "profile.avatar.pickaxe" },
  { id: "sword", icon: Sword, labelKey: "profile.avatar.sword" },
  { id: "heart", icon: Heart, labelKey: "profile.avatar.heart" },
  { id: "flame", icon: Flame, labelKey: "profile.avatar.flame" },
  { id: "leaf", icon: Leaf, labelKey: "profile.avatar.leaf" },
  { id: "star", icon: Star, labelKey: "profile.avatar.star" },
  { id: "moon", icon: Moon, labelKey: "profile.avatar.moon" },
];

/** `hex` pinta o nome; `gradient` pinta o fundo do avatar. */
export const COLORS: { id: string; hex: string; gradient: string; labelKey: TKey }[] = [
  { id: "indigo", hex: "#6366f1", gradient: "from-indigo-500 to-violet-600", labelKey: "profile.color.indigo" },
  { id: "emerald", hex: "#10b981", gradient: "from-emerald-500 to-teal-600", labelKey: "profile.color.emerald" },
  { id: "amber", hex: "#f59e0b", gradient: "from-amber-500 to-orange-600", labelKey: "profile.color.amber" },
  { id: "rose", hex: "#f43f5e", gradient: "from-rose-500 to-pink-600", labelKey: "profile.color.rose" },
  { id: "sky", hex: "#0ea5e9", gradient: "from-sky-500 to-blue-600", labelKey: "profile.color.sky" },
  { id: "violet", hex: "#8b5cf6", gradient: "from-violet-500 to-fuchsia-600", labelKey: "profile.color.violet" },
];

export function avatarOf(id: string | null | undefined) {
  return AVATARS.find((a) => a.id === id) ?? AVATARS[0];
}

export function colorOf(id: string | null | undefined) {
  return COLORS.find((c) => c.id === id) ?? COLORS[0];
}
