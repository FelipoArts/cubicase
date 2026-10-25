"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Check, Clock, Copy, Gamepad2, Globe, LifeBuoy, Loader2, PanelLeftClose, PanelLeftOpen, Pin, Play, Plus, RefreshCw,
  Search, Server, Trash2, Users, WifiOff, X, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/app/store";
import { useServerIcon } from "@/lib/serverIcon";
import { useGuestServerIcon } from "@/lib/guestServerIcon";
import { useConnectionHelp } from "@/lib/connectionHelp";
import type { KnownServer } from "@/app/store";
import { PLAYABLE_SERVER_TYPES, useGuestController, type GuestViewProps } from "@/app/components/guest/useGuestController";
import { GuestModals } from "@/app/components/guest/GuestModals";
import { useT } from "@/i18n";
import { GlobalActions } from "./GlobalActions";
import { ResizeHandle, usePanel } from "./panels";
import { inputCls, MiniButton, Notice } from "./ui";
import { usePinnedServers } from "./usePinned";

// Convidado na nova interface: lista dos servidores dos amigos à esquerda (status e fixados à vista) e, à direita, os
// detalhes e o próximo passo do servidor escolhido. Toda a lógica vem do mesmo controlador da tela atual.

const LIST_PANEL = { key: "guest-list", def: 320, min: 240, max: 480, collapsedWidth: 0 };

const COLORS = ["from-emerald-500 to-teal-600", "from-orange-500 to-rose-600", "from-sky-500 to-indigo-600", "from-fuchsia-500 to-purple-600", "from-amber-500 to-yellow-600", "from-indigo-500 to-violet-600"];
const colorFor = (key: string) => COLORS[[...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % COLORS.length];

function Icon({ s, size }: { s: KnownServer; size: "sm" | "lg" }) {
  // Servidor do próprio usuário: usa a imagem local. Os de amigos usam a que o host enviou para a central.
  const guestIcon = useGuestServerIcon(s.shortCode);
  const localPath = useAppStore((st) => (s.isOwnServer ? st.localServers.find((l) => l.shortCode === s.shortCode)?.path : undefined));
  const icon = useServerIcon(localPath) ?? guestIcon;
  return (
    <span aria-hidden className={cn("shrink-0 grid place-items-center font-black text-white bg-gradient-to-br overflow-hidden", colorFor(s.shortCode), size === "sm" ? "w-10 h-10 text-sm rounded-xl" : "w-16 h-16 text-2xl rounded-2xl")}>
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="w-full h-full object-cover" />
      ) : (
        s.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-theme-muted border border-theme-card rounded-xl px-3.5 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{label}</p>
      <p className="text-sm font-bold mt-0.5 break-words">{value}</p>
    </div>
  );
}

export function GuestWorkspace(props: GuestViewProps) {
  const { t } = useT();
  const g = useGuestController(props);
  const panel = usePanel(LIST_PANEL);
  const { pinned, toggle: togglePin, forget } = usePinnedServers();
  const [selected, setSelected] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false); // só em telas estreitas: lista OU detalhes
  const [query, setQuery] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const list = g.knownServers;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = list.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q));
    return [...hit.filter((s) => pinned.has(s.shortCode)), ...hit.filter((s) => !pinned.has(s.shortCode))];
  }, [list, query, pinned]);
  const pinnedCount = filtered.filter((s) => pinned.has(s.shortCode)).length;
  const server = list.find((s) => s.shortCode === selected) ?? list[0] ?? null;
  const select = (code: string) => { setSelected(code); setShowDetail(true); setConfirmRemove(null); };

  function remove(code: string) {
    g.handleRemoveServer(code);
    forget(code);
    setConfirmRemove(null);
    if (selected === code) setSelected(null);
  }

  /** Estado e o único próximo passo do servidor (mesma lógica do cartão da tela atual). */
  const renderAction = (s: KnownServer) => {
    const stale = g.isServerStale(s, g.now);
    const connected = g.connectedShortCode === s.shortCode;
    const display = g.getDisplayStatus(s);
    const big = "px-5 py-2.5 text-sm";
    if (connected) {
      return (
        <>
          <MiniButton tone="danger" className={big} onClick={() => g.handleDisconnect()}><X className="w-4 h-4" />{t("guest.disconnect")}</MiniButton>
          {PLAYABLE_SERVER_TYPES.has(s.serverType) && (
            <MiniButton
              tone="primary"
              className={big}
              onClick={() => g.handlePrepareAndPlay(s)}
              disabled={g.prepModalFor === s.shortCode && g.prepStates[s.shortCode]?.phase !== "error" && g.prepStates[s.shortCode]?.phase !== "done"}
            ><Play className="w-4 h-4 fill-current" />{t("guest.prepareAndPlay")}</MiniButton>
          )}
        </>
      );
    }
    if (stale) return <MiniButton disabled className={big}><WifiOff className="w-4 h-4" />{t("guest.status.stale")}</MiniButton>;
    if (s.status === "online") {
      if (s.isOwnServer) return <>{g.renderOwnPlayButton(s)}</>;
      return (
        <MiniButton tone="primary" className={big} disabled={g.isConnecting} onClick={() => g.handleConnect(s)}>
          {PLAYABLE_SERVER_TYPES.has(s.serverType) ? <Play className="w-4 h-4 fill-current" /> : <Zap className="w-4 h-4 fill-current" />}{t("guest.connect")}
        </MiniButton>
      );
    }
    if (s.minecraftStatus === "sleeping") {
      if (s.isOwnServer) return <MiniButton disabled className={big}><Zap className="w-4 h-4" />{display.label}</MiniButton>;
      if (g.wakingShortCode === s.shortCode) return <MiniButton disabled className={big}><Loader2 className="w-4 h-4 animate-spin" />{t("guest.wake.waking")}</MiniButton>;
      return <MiniButton tone="primary" className={big} onClick={() => g.handleWakeServer(s)}><Zap className="w-4 h-4 fill-current" />{t("guest.wake.button")}</MiniButton>;
    }
    if (s.minecraftStatus === "online") {
      if (s.isOwnServer) return <>{g.renderOwnPlayButton(s)}</>;
      return <MiniButton disabled className={big} title={t("guest.noMeshTitle")}><Server className="w-4 h-4" />{t("guest.noMesh")}</MiniButton>;
    }
    if (s.minecraftStatus === "crashed") return <MiniButton disabled className={big}><AlertTriangle className="w-4 h-4" />{t("guest.status.crashed")}</MiniButton>;
    return <MiniButton disabled className={big}><WifiOff className="w-4 h-4" />{t("guest.status.offline")}</MiniButton>;
  };

  const rowStatus = (s: KnownServer) => {
    const stale = g.isServerStale(s, g.now);
    const d = g.getDisplayStatus(s);
    return { stale, label: stale ? t("guest.status.unconfirmed") : d.label, dot: stale ? "bg-slate-400" : d.color };
  };

  return (
    <div className="flex-1 min-w-0 flex min-h-0">
      {/* ---------- Lista ---------- */}
      <section
        style={{ ["--list-w" as string]: `${panel.width}px` }}
        className={cn("relative w-full md:w-[var(--list-w)] shrink-0 bg-theme-card/50 flex-col min-h-0", panel.collapsed ? "md:overflow-hidden md:border-r-0" : "border-r border-theme-card", !panel.dragging && "md:transition-[width] md:duration-200", showDetail ? "hidden md:flex" : "flex")}
      >
        <div className="hidden md:block"><ResizeHandle panel={panel} label={t("nui.guest.resize")} /></div>
        <div className="p-4 space-y-3 border-b border-theme-card">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-base font-bold truncate">{t("nui.guest.title")}</h1>
            <div className="flex gap-1.5 shrink-0">
              <MiniButton title={t("guest.refresh")} aria-label={t("guest.refresh")} onClick={() => g.refreshAllServers()} disabled={g.isRefreshing}><RefreshCw className={cn("w-3.5 h-3.5", g.isRefreshing && "animate-spin")} /></MiniButton>
              <MiniButton className="hidden md:inline-flex" onClick={panel.toggle} title={t("nui.guest.collapse")} aria-label={t("nui.guest.collapse")}><PanelLeftClose className="w-3.5 h-3.5" /></MiniButton>
            </div>
          </div>
          <MiniButton tone="primary" onClick={() => g.setShowAddModal(true)} className="w-full justify-center py-2"><Plus className="w-3.5 h-3.5" />{t("guest.addServer")}</MiniButton>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-theme-secondary" />
            <input className={`${inputCls} pl-9 py-1.5`} placeholder={t("nui.guest.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>

        <ul className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          {filtered.map((s, idx) => {
            const st = rowStatus(s);
            const isPinned = pinned.has(s.shortCode);
            const active = server?.shortCode === s.shortCode;
            const asking = confirmRemove === s.shortCode;
            return (
              <li key={s.shortCode}>
                {pinnedCount > 0 && idx === 0 && <p className="px-2.5 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-theme-secondary">{t("nui.guest.pinned")}</p>}
                {pinnedCount > 0 && idx === pinnedCount && <p className="px-2.5 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-theme-secondary">{t("nui.guest.all")}</p>}
                <div className={cn("group/row relative flex items-center rounded-xl border", active ? "bg-theme-accent border-theme-accent" : "border-transparent hover:bg-theme-muted")}>
                  <button type="button" onClick={() => select(s.shortCode)} className="min-w-0 flex-1 flex items-center gap-3 pl-2.5 py-2.5 text-left cursor-pointer">
                    <Icon s={s} size="sm" />
                    <span className="min-w-0 flex-1">
                      {asking ? (
                        <span className="block text-sm font-bold text-rose-600 dark:text-rose-400">{t("nui.guest.removeAsk")}</span>
                      ) : (
                        <>
                          <span className="text-sm font-bold truncate block">{s.name}</span>
                          <span className="flex items-center gap-1.5 text-[11px] text-theme-secondary mt-0.5">
                            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", st.dot)} />
                            <span className="truncate">{st.label}{!st.stale && s.minecraftStatus === "online" ? ` · ${s.currentPlayers}/${s.maxPlayers}` : ""}</span>
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                  <div className="flex items-center gap-0.5 pr-1.5 shrink-0">
                    {asking ? (
                      <>
                        <button type="button" onClick={() => remove(s.shortCode)} title={t("nui.guest.removeConfirm")} aria-label={t("nui.guest.removeConfirm")} className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-500/10 cursor-pointer"><Check className="w-4 h-4" /></button>
                        <button type="button" onClick={() => setConfirmRemove(null)} title={t("common.cancel")} aria-label={t("common.cancel")} className="p-1.5 rounded-lg text-theme-secondary hover:bg-theme-muted cursor-pointer"><X className="w-4 h-4" /></button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => togglePin(s.shortCode)}
                          title={isPinned ? t("nui.guest.unpin") : t("nui.guest.pin")}
                          aria-label={isPinned ? t("nui.guest.unpin") : t("nui.guest.pin")}
                          aria-pressed={isPinned}
                          className={cn("p-1.5 rounded-lg cursor-pointer hover:bg-theme-muted focus-visible:opacity-100", isPinned ? "text-indigo-600 opacity-100" : "text-theme-secondary opacity-0 group-hover/row:opacity-100")}
                        ><Pin className={cn("w-4 h-4", isPinned && "fill-current")} /></button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(s.shortCode)}
                          title={t("guest.remove")}
                          aria-label={t("guest.remove")}
                          className="p-1.5 rounded-lg text-theme-secondary hover:text-rose-500 hover:bg-rose-500/10 cursor-pointer opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                        ><Trash2 className="w-4 h-4" /></button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {list.length > 0 && filtered.length === 0 && <li className="text-xs text-theme-secondary text-center py-8">{t("nui.guest.noMatch")}</li>}
          {list.length === 0 && <li className="text-xs text-theme-secondary text-center py-10 px-4">{t("guest.emptyPrompt")}</li>}
        </ul>
      </section>

      {/* ---------- Detalhes ---------- */}
      <section className={cn("relative flex-1 min-w-0 min-h-0 overflow-y-auto custom-scrollbar", showDetail ? "block" : "hidden md:block")}>
        {panel.collapsed && (
          <button type="button" onClick={panel.toggle} title={t("nui.guest.expand")} aria-label={t("nui.guest.expand")} className="hidden md:inline-flex absolute left-3 top-3 z-10 p-2 rounded-xl bg-theme-card border border-theme-card shadow-theme-card text-theme-secondary hover:text-indigo-600 cursor-pointer"><PanelLeftOpen className="w-4 h-4" /></button>
        )}
        <div className="absolute right-4 top-3 z-10"><GlobalActions /></div>

        {g.isOfflineMode && list.length > 0 && (
          <div className="px-6 pt-14">
            <Notice tone="warning"><span className="flex items-center gap-2"><WifiOff className="w-4 h-4 shrink-0" />{t("guest.offlineBanner")}</span></Notice>
          </div>
        )}

        {!server ? (
          <div className="h-full grid place-items-center p-10">
            <div className="text-center space-y-3 max-w-sm">
              <Gamepad2 className="w-8 h-8 mx-auto text-indigo-600" />
              <p className="text-lg font-bold">{t("guest.empty.title")}</p>
              <p className="text-sm text-theme-secondary">{t("guest.empty.body")}</p>
              <MiniButton tone="primary" onClick={() => g.setShowAddModal(true)}><Plus className="w-3.5 h-3.5" />{t("guest.empty.button")}</MiniButton>
            </div>
          </div>
        ) : (() => {
          const s = server;
          const connected = g.connectedShortCode === s.shortCode;
          const mcOnline = s.minecraftStatus === "online";
          const stale = g.isServerStale(s, g.now);
          const st = rowStatus(s);
          const address = g.addressFor(s);
          return (
            <div className="max-w-3xl mx-auto px-6 pt-14 pb-6 space-y-5">
              <button type="button" onClick={() => setShowDetail(false)} className="md:hidden inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 cursor-pointer"><ArrowLeft className="w-3.5 h-3.5" />{t("nui.guest.back")}</button>

              <div className="flex flex-wrap items-center gap-4">
                <Icon s={s} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-xl font-bold truncate">{s.name}</h2>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-theme-card bg-theme-muted text-[11px] font-bold">
                      <span className={cn("w-1.5 h-1.5 rounded-full", st.dot)} />{st.label}
                    </span>
                    {s.isOwnServer && <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider bg-theme-accent border border-theme-accent px-2 py-1 rounded-full">{t("guest.badge.own")}</span>}
                  </div>
                  <p className="text-sm text-theme-secondary mt-0.5">{g.serverKindLabel(s.serverType)} {s.version}</p>
                  {s.description && <p className="text-xs text-theme-secondary mt-1 italic line-clamp-2">{s.description}</p>}
                </div>
              </div>

              <div className={cn("rounded-2xl border p-5 space-y-4", connected ? "border-emerald-500/40 bg-emerald-500/5" : "border-theme-card bg-theme-card shadow-theme-card")}>
                {connected && (
                  <div className="space-y-1.5">
                    <p className="text-base font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-2"><Zap className="w-5 h-5 fill-current" />{g.isOnline ? t("guest.connected") : t("guest.connecting")}</p>
                    <p className="text-sm text-theme-secondary">{g.rich("guest.connectAt", { address: <strong className="text-theme-primary font-mono">{address}</strong> })}</p>
                  </div>
                )}
                {!connected && (
                  <div className="flex items-center gap-2 bg-theme-muted rounded-xl px-3 py-2 border border-theme-card">
                    <Globe className="w-4 h-4 text-indigo-500 shrink-0" />
                    <span className="font-mono font-bold text-xs flex-1 truncate">{address}</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {renderAction(s)}
                  <MiniButton onClick={() => g.copyToClipboard(address)} title={t("guest.copyAddressTitle")}>
                    {g.copied === address ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{g.copied === address ? t("guest.copied") : t("guest.copyAddress")}
                  </MiniButton>
                  {!connected && !stale && s.status === "online" && !s.isOwnServer && (
                    <MiniButton onClick={() => useConnectionHelp.getState().showForServer({ shortCode: s.shortCode, name: s.name })} title={t("connhelp.openTitle")} aria-label={t("connhelp.open")}><LifeBuoy className="w-3.5 h-3.5" />{t("connhelp.open")}</MiniButton>
                  )}
                </div>
                {g.wakeError?.shortCode === s.shortCode && <p className="text-xs text-rose-500">{g.wakeError.message}</p>}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Fact label={t("nui.guest.fact.players")} value={mcOnline && !stale ? `${s.currentPlayers}/${s.maxPlayers}` : "—"} />
                <Fact label={t("nui.guest.fact.version")} value={s.version || "—"} />
                <Fact label={t("nui.guest.fact.type")} value={g.serverKindLabel(s.serverType)} />
                <Fact label={t("nui.guest.fact.seen")} value={mcOnline && !stale ? t("guest.onlineFor", { time: g.formatUptime(s.onlineSince) }) : g.formatLastSeen(s.lastSeenOnline, g.now)} />
              </div>

              <div className="bg-theme-card border-theme-card shadow-theme-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider flex items-center gap-1.5"><Clock className="w-3 h-3" />{t("nui.guest.code")}</p>
                  <p className="font-mono font-bold mt-0.5">CF-{s.shortCode}</p>
                </div>
                <MiniButton onClick={() => g.copyToClipboard(`CF-${s.shortCode}`)} title={t("guest.copyCode")}>
                  {g.copied === `CF-${s.shortCode}` ? <Check className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}{t("guest.copyCode")}
                </MiniButton>
              </div>
            </div>
          );
        })()}
      </section>

      <GuestModals c={g} />
    </div>
  );
}
