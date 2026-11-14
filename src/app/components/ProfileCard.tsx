"use client";

import { useState } from "react";
import { Flag, Pencil, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { profileImageUrl } from "@/lib/profileImages";
import { useT } from "@/i18n";
import { colorOf, tierOf, tierProgress, type PlusStreakView, type PlusTierId, type UserProfile } from "@/lib/profileCatalog";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";
import { PlusBadge } from "@/app/components/PlusBadge";
import { TierCube, isCubeTier } from "@/app/components/TierCube";

export interface ProfileCardData {
  profile: UserProfile;
  plus: boolean;
  tier: PlusTierId | null;
  /** Papel no servidor, quando o cartão vem da lista de quem está conectado. */
  role?: "host" | "guest";
  /** É o cartão da própria pessoa. */
  self?: boolean;
  /** A sequência de assinatura (só se sabe a da própria conta). */
  streak?: PlusStreakView | null;
}

interface Props {
  data: ProfileCardData;
  /** Botão "Editar perfil" (só no cartão da própria pessoa). */
  onEdit?: () => void;
  /** Botão "Conhecer o Plus" (só no cartão da própria pessoa, sem Plus). */
  onDiscoverPlus?: () => void;
  /** Link "Denunciar" (só no cartão de outra pessoa, dentro de um servidor em comum). */
  onReport?: () => void;
}

/** O mini perfil: faixa na cor escolhida, avatar, nome, selo do Plus e o que se sabe do nível. */
export function ProfileCard({ data, onEdit, onDiscoverPlus, onReport }: Props) {
  const { t } = useT();
  const { profile, plus, tier, role, self, streak } = data;
  const color = colorOf(profile.nameColor);
  const level = tier ? tierOf(tier) : null;
  const days = self && streak && streak.phase === "active" ? streak.days : null;
  const progress = days !== null ? tierProgress(days) : null;
  // Se o banner não carregar (sem rede, removido pela moderação), volta ao degradê em vez de uma faixa vazia.
  const [bannerFailed, setBannerFailed] = useState<string | null>(null);
  const showBanner = !!profile.bannerHash && bannerFailed !== profile.bannerHash;

  return (
    <div className="rounded-2xl border border-theme-card bg-theme-card shadow-2xl overflow-hidden text-theme-primary">
      {/* Faixa: a imagem de banner de quem assina o Plus, ou o degradê da cor do perfil */}
      <div className={cn("relative h-20 overflow-hidden", !showBanner && `bg-gradient-to-br ${color.gradient}`)} aria-hidden>
        {showBanner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={(el) => { if (el?.complete && el.naturalWidth === 0) setBannerFailed(profile.bannerHash); }} // falhou antes de o React ligar o onError
            src={profileImageUrl(profile.bannerHash!)} alt="" draggable={false} className="w-full h-full object-cover" onError={() => setBannerFailed(profile.bannerHash)}
          />
        )}
      </div>

      <div className="px-4 pb-4">
        <div className="-mt-8 flex items-end justify-between gap-2">
          {/* relative: sem isso a faixa (também posicionada) é pintada por cima do avatar */}
          <span className="relative rounded-3xl p-1 bg-theme-card"><ProfileAvatar avatarId={profile.avatarId} colorId={profile.nameColor} imageHash={profile.avatarHash} size="lg" /></span>
          <span className="flex items-center gap-1.5 pb-1">
            {role === "host" && <span className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{t("members.host")}</span>}
            {self && <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 bg-theme-accent border border-theme-accent px-2 py-0.5 rounded-full">{t("members.you")}</span>}
          </span>
        </div>

        <h3 className="mt-2 text-lg font-bold leading-tight truncate" style={{ color: color.hex }}>{profile.displayName}</h3>
        {plus && <div className="mt-1.5"><PlusBadge tier={tier} /></div>}
        {profile.bio && <p className="mt-2 text-xs leading-relaxed text-theme-secondary break-words whitespace-pre-line">{profile.bio}</p>}

        <div className="mt-3 rounded-xl bg-theme-muted border border-theme-card px-3 py-2.5 space-y-1.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary flex items-center gap-1.5"><Sparkles className="w-3 h-3" />{t("card.plus")}</p>
          {plus && level ? (
            <div className="flex items-center gap-3">
              {/* O cubo do nível mora aqui, no bloco do Plus (a faixa de cima fica livre para o banner) */}
              {isCubeTier(level.id) && <TierCube tier={level.id} size={52} title={t(level.labelKey)} className="shrink-0 drop-shadow-sm" />}
              <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-bold">{t("card.tier", { tier: t(level.labelKey) })}</p>
              {days !== null && <p className="text-[11px] text-theme-secondary">{t("card.days", { count: days })}</p>}
              {progress?.next && (
                <div className="space-y-1">
                  <div className="h-1.5 rounded-full bg-theme-card border border-theme-card overflow-hidden" role="progressbar" aria-label={t("plustier.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
                    <div className="h-full rounded-full" style={{ width: `${Math.round(progress.fraction * 100)}%`, backgroundColor: progress.next.hex }} />
                  </div>
                  <p className="text-[10px] text-theme-secondary">{t("plustier.next", { count: progress.daysToNext, tier: t(progress.next.labelKey) })}</p>
                </div>
              )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-theme-secondary">{t("card.notPlus")}</p>
          )}
        </div>

        {self && onEdit && (
          <button type="button" onClick={onEdit} className="mt-3 w-full h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors">
            <Pencil className="w-4 h-4" />{t("card.edit")}
          </button>
        )}
        {!self && onReport && (
          <button type="button" onClick={onReport} className="mt-3 w-full text-center text-[11px] font-semibold text-theme-secondary hover:text-rose-500 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
            <Flag className="w-3 h-3" />{t("report.open")}
          </button>
        )}
        {self && !plus && onDiscoverPlus && (
          <button type="button" onClick={onDiscoverPlus} className="mt-2 w-full h-9 rounded-xl border border-theme-card hover:border-indigo-400 text-xs font-bold text-indigo-600 flex items-center justify-center gap-1.5 cursor-pointer transition-colors">
            <Sparkles className="w-3.5 h-3.5" />{t("card.discover")}
          </button>
        )}
      </div>
    </div>
  );
}
