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
