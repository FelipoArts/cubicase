"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { avatarOf, colorOf } from "@/lib/profileCatalog";
import { profileImageUrl } from "@/lib/profileImages";

const SIZES = {
  sm: { box: "w-8 h-8 rounded-xl", icon: "w-4 h-4" },
  md: { box: "w-11 h-11 rounded-2xl", icon: "w-5 h-5" },
  lg: { box: "w-16 h-16 rounded-3xl", icon: "w-8 h-8" },
} as const;

interface Props {
  avatarId: string | null | undefined;
  /** Cor do perfil; sem ela usa o índigo padrão. */
  colorId?: string | null;
  /** Foto enviada (só de quem assina o Plus): quando há, ela substitui o ícone. */
  imageHash?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}

/** Avatar do perfil: a foto enviada, ou o ícone do catálogo sobre um degradê da cor escolhida. */
export function ProfileAvatar({ avatarId, colorId, imageHash, size = "md", className }: Props) {
  const { icon: Icon } = avatarOf(avatarId);
  const s = SIZES[size];
  // Se a foto não carregar (sem rede, removida pela moderação), volta ao ícone em vez de mostrar um quadro quebrado.
  const [failed, setFailed] = useState<string | null>(null);

  if (imageHash && failed !== imageHash) {
    return (
      // block: um span é "em linha" e ignora largura e altura; sem isto a foto crescia até o tamanho original da imagem
      <span aria-hidden className={cn("block shrink-0 overflow-hidden bg-theme-muted", s.box, className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={(el) => { if (el?.complete && el.naturalWidth === 0) setFailed(imageHash); }} // falhou antes de o React ligar o onError
          src={profileImageUrl(imageHash)} alt="" draggable={false} className="block w-full h-full object-cover" onError={() => setFailed(imageHash)}
        />
      </span>
    );
  }
  return (
    <span aria-hidden className={cn("grid place-items-center shrink-0 text-white bg-gradient-to-br", colorOf(colorId).gradient, s.box, className)}>
      <Icon className={s.icon} />
    </span>
  );
}
