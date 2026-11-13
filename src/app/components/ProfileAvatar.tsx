"use client";

import { cn } from "@/lib/utils";
import { avatarOf, colorOf } from "@/lib/profileCatalog";

const SIZES = {
  sm: { box: "w-8 h-8 rounded-xl", icon: "w-4 h-4" },
  md: { box: "w-11 h-11 rounded-2xl", icon: "w-5 h-5" },
  lg: { box: "w-16 h-16 rounded-3xl", icon: "w-8 h-8" },
} as const;

interface Props {
  avatarId: string | null | undefined;
  /** Cor do perfil; sem ela usa o índigo padrão. */
  colorId?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}

/** Avatar do perfil: ícone do catálogo sobre um degradê da cor escolhida. */
export function ProfileAvatar({ avatarId, colorId, size = "md", className }: Props) {
  const { icon: Icon } = avatarOf(avatarId);
  const s = SIZES[size];
  return (
    <span aria-hidden className={cn("grid place-items-center shrink-0 text-white bg-gradient-to-br", colorOf(colorId).gradient, s.box, className)}>
      <Icon className={s.icon} />
    </span>
  );
}
