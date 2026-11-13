"use client";

import { Sparkles, Users } from "lucide-react";
import { useT } from "@/i18n";
import { colorOf } from "@/lib/profileCatalog";
import { useRoster, type RosterMember } from "@/lib/roster";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";

const MAX_SHOWN = 10;

function Row({ m }: { m: RosterMember }) {
  const { t } = useT();
  const name = m.profile?.displayName ?? t("members.guest");
  return (
    <li className="py-2.5 flex items-center gap-3 min-w-0">
      {m.profile
        ? <ProfileAvatar avatarId={m.profile.avatarId} colorId={m.profile.nameColor} size="sm" />
        : <span aria-hidden className="w-8 h-8 rounded-xl grid place-items-center shrink-0 bg-theme-muted border border-theme-card"><Users className="w-4 h-4 text-theme-secondary" /></span>}
      <span
        className="text-sm font-bold truncate"
        style={m.profile ? { color: colorOf(m.profile.nameColor).hex } : undefined}
      >{name}</span>
      {m.plus && (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-600 text-white shrink-0" title={t("members.plus")}>
          <Sparkles className="w-3 h-3" />Plus
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {m.role === "host" && <span className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{t("members.host")}</span>}
        {m.self && <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 bg-theme-accent border border-theme-accent px-2 py-0.5 rounded-full">{t("members.you")}</span>}
      </span>
    </li>
  );
}

/**
 * Quem está conectado ao servidor (host e convidados), com o perfil de quem entrou com a conta do Cubicase.
 * `active` liga a consulta (só enquanto a conexão P2P está de pé). Sem membros ainda, não mostra nada.
 */
export function MembersCard({ active, className }: { active: boolean; className?: string }) {
  const { t } = useT();
  const members = useRoster(active);
  if (!active || !members || members.length === 0) return null;

  const shown = members.slice(0, MAX_SHOWN);
  const extra = members.length - shown.length;
  return (
    <section className={className ?? "bg-theme-card border-theme-card shadow-theme-card rounded-2xl p-5"} aria-label={t("members.title")}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-bold text-theme-primary flex items-center gap-2"><Users className="w-4 h-4 text-indigo-600" />{t("members.title")}</h3>
        <span className="text-xs text-theme-secondary tabular-nums">{members.length}</span>
      </div>
      <ul className="divide-y divide-[var(--card-border)]">
        {shown.map((m) => <Row key={`${m.role}:${m.id}`} m={m} />)}
      </ul>
      {extra > 0 && <p className="text-xs text-theme-secondary pt-2">{t("members.more", { count: extra })}</p>}
      <p className="text-[11px] text-theme-secondary pt-2">{t("members.hint")}</p>
    </section>
  );
}
