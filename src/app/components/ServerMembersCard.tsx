"use client";

import { useCallback, useState } from "react";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useAppStore } from "@/app/store";
import { colorOf } from "@/lib/profileCatalog";
import { reportMember, useServerMembers, type ServerMember, type ServerMembersResult } from "@/lib/membership";
import { ReportProfileModal } from "@/app/components/ReportProfileModal";
import { PlusBadge } from "@/app/components/PlusBadge";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";
import { ProfileCard } from "@/app/components/ProfileCard";
import { AnchoredPopover } from "@/app/components/AnchoredPopover";

const MAX_SHOWN = 12;

function Row({ m, open, onOpen }: { m: ServerMember; open: boolean; onOpen: (el: HTMLElement) => void }) {
  const { t } = useT();
  const name = m.profile?.displayName ?? t("servermembers.noProfile");
  const content = (
    <>
      <span className="relative shrink-0">
        {m.profile
          ? <ProfileAvatar avatarId={m.profile.avatarId} colorId={m.profile.nameColor} imageHash={m.profile.avatarHash} size="sm" className={cn(!m.online && "opacity-60 grayscale-[40%]")} />
          : <span aria-hidden className="w-8 h-8 rounded-xl grid place-items-center bg-theme-muted border border-theme-card"><Users className="w-4 h-4 text-theme-secondary" /></span>}
        {/* A bolinha verde marca quem está conectado ao servidor (o Cubicase não sabe se já entrou no jogo) */}
        {m.online && <span aria-hidden className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-theme-card" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={cn("text-sm font-bold truncate", !m.online && "opacity-70")} style={m.profile ? { color: colorOf(m.profile.nameColor).hex } : undefined}>{name}</span>
          {m.plus && <PlusBadge tier={m.tier} />}
        </span>
        <span className={cn("block text-[11px]", m.online ? "font-bold text-emerald-600 dark:text-emerald-400" : "text-theme-secondary")}>
          {m.online ? t("servermembers.connected") : t("servermembers.offline")}
        </span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        {m.role === "host" && <span className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{t("members.host")}</span>}
        {m.self && <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 bg-theme-accent border border-theme-accent px-2 py-0.5 rounded-full">{t("members.you")}</span>}
      </span>
    </>
  );
  const frame = "w-full flex items-center gap-3 min-w-0 rounded-xl border px-2 py-1.5 text-left";
  return (
    <li className="py-0.5">
      {m.profile ? (
        <button
          type="button"
          onClick={(e) => onOpen(e.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("card.open", { name })}
          className={cn(frame, "cursor-pointer transition-colors hover:border-indigo-400/60 hover:bg-theme-muted focus-visible:border-indigo-400/60 focus-visible:outline-none",
            open ? "border-indigo-400/60 bg-theme-muted" : m.online ? "border-emerald-500/25 bg-emerald-500/5" : "border-transparent")}
        >{content}</button>
      ) : (
        <div className={cn(frame, m.online ? "border-emerald-500/25 bg-emerald-500/5" : "border-transparent")}>{content}</div>
      )}
    </li>
  );
}

/**
 * Todos que adicionaram este servidor (contas), com quem está conectado em destaque e no topo. Só aparece para
 * quem também é membro e está logado. Clicar em quem tem perfil abre o mini perfil dele.
 */
export function ServerMembersCard({ shortCode, className }: { shortCode: string | null | undefined; className?: string }) {
  const loggedIn = useAppStore((s) => !!s.user);
  const result = useServerMembers(shortCode ?? null, loggedIn && !!shortCode);
  if (!result || result.members.length === 0) return null;
  return <ServerMembersView result={result} shortCode={shortCode ?? null} className={className} />;
}

/** A parte visual do cartão (sem buscar nada): recebe a lista pronta. */
export function ServerMembersView({ result, shortCode, className }: { result: ServerMembersResult; shortCode?: string | null; className?: string }) {
  const { t } = useT();
  const plusStreak = useAppStore((s) => s.plusStreak);
  const [opened, setOpened] = useState<{ id: string; el: HTMLElement } | null>(null);
  const close = useCallback(() => setOpened(null), []);
  // Denúncia do perfil aberto: a janela de denúncia fica por cima do mini perfil
  const [reporting, setReporting] = useState<{ id: string; name: string } | null>(null);

  const anonymous = result.anonymousOnline ?? 0;
  const connectedNow = result.onlineCount + anonymous;
  const shown = result.members.slice(0, MAX_SHOWN);
  const extra = result.members.length - shown.length;
  const current = opened ? result.members.find((m) => m.id === opened.id) : undefined;

  return (
    <section className={className ?? "bg-theme-card border-theme-card shadow-theme-card rounded-2xl p-5"} aria-label={t("servermembers.title")}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-bold text-theme-primary flex items-center gap-2"><Users className="w-4 h-4 text-indigo-600" />{t("servermembers.title")}</h3>
        <span className="flex items-center gap-2 text-xs text-theme-secondary tabular-nums">
          {connectedNow > 0 && <span className="inline-flex items-center gap-1 font-bold text-emerald-600 dark:text-emerald-400"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{t("servermembers.count", { count: connectedNow })}</span>}
          <span>{result.total}</span>
        </span>
      </div>
      {/* Quem joga sem conta não é membro e não tem perfil: entra só como número */}
      {anonymous > 0 && (
        <p className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-2 py-1.5 mb-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
          <Users className="w-3.5 h-3.5" />{t("servermembers.anonymous", { count: anonymous })}
        </p>
      )}
      <ul>
        {shown.map((m) => (
          <Row key={m.id} m={m} open={opened?.id === m.id} onOpen={(el) => setOpened((cur) => (cur?.id === m.id ? null : { id: m.id, el }))} />
        ))}
      </ul>
      {extra > 0 && <p className="text-xs text-theme-secondary pt-2">{t("members.more", { count: extra })}</p>}
      <p className="text-[11px] text-theme-secondary pt-2">{t("servermembers.hint")}</p>

      {opened && current?.profile && (
        <AnchoredPopover anchor={opened.el} onClose={close} label={t("card.open", { name: current.profile.displayName })}>
          <ProfileCard
            data={{
              profile: current.profile,
              plus: current.plus,
              tier: current.tier,
              role: current.role === "host" ? "host" : undefined,
              self: current.self,
              streak: current.self ? plusStreak : null,
            }}
            onReport={shortCode && !current.self ? () => { setReporting({ id: current.id, name: current.profile!.displayName }); close(); } : undefined}
          />
        </AnchoredPopover>
      )}

      <ReportProfileModal
        isOpen={!!reporting}
        name={reporting?.name ?? ""}
        onClose={() => setReporting(null)}
        onSubmit={async (reason, note) => { if (shortCode && reporting) await reportMember(shortCode, reporting.id, reason, note); }}
      />
    </section>
  );
}
