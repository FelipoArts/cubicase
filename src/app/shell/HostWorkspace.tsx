"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle, BedDouble, Check, ChevronDown, Copy, FolderOpen, Gauge, Globe, LayoutDashboard, Loader2, Package, Play, Plus, RefreshCw, Settings, Users, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isPrimaryDisabled, isStopAction } from "@/lib/hosting";
import { PlayersPanel } from "@/app/components/host/PlayersPanel";
import { PerformancePanel } from "@/app/components/host/PerformancePanel";
import { ServerManagePanel } from "@/app/components/host/ServerManagePanel";
import type { HostController } from "@/app/components/host/useHostController";
import { ServerAvatar } from "@/app/components/ServerAvatar";
import { Dock } from "./Dock";
import { GlobalActions } from "./GlobalActions";
import { OverviewTab } from "./tabs/OverviewTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { MiniButton } from "./ui";

// Área de trabalho do host na nova interface: barra do servidor (sempre à vista), faixa de avisos, abas e o console.
// Usa o mesmo controlador da tela atual (useHostController), então liga, desliga e avisa exatamente igual.

type Tab = "overview" | "players" | "world" | "mods" | "performance" | "settings";

const PLUGIN_TYPES = ["paper", "spigot", "purpur", "bukkit"];
const MOD_TYPES = ["forge", "neoforge", "fabric", ...PLUGIN_TYPES];

const BANNER_CLS = {
  info: "bg-theme-accent border-theme-accent text-indigo-700 dark:text-indigo-300",
  warn: "bg-theme-warning border-theme-warning text-amber-800 dark:text-amber-200",
  bad: "bg-theme-danger border-theme-danger text-rose-800 dark:text-rose-200",
  neutral: "bg-theme-muted border-theme-card text-theme-secondary",
};

function Banner({ kind, icon, children, action }: { kind: keyof typeof BANNER_CLS; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn("rounded-2xl border px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm", BANNER_CLS[kind])} role="status">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function HostWorkspace({ c }: { c: HostController }) {
  const { t, rich } = c;
  const {
    selectedServer, serverInfo, serverTypeLabel, displayShortCode, headline, serverStatus, hosting, sessionActive, retryInSecs,
    friendsHint, preparing, serverInstallProgress, idleShutdownWarning, lastCrashInfo, showCrashDetail, setShowCrashDetail,
    wakeOnDemandServerInfo, copiedText, copyToClipboard,
  } = c;
  const [tab, setTab] = useState<Tab>("overview");

  if (!selectedServer || !serverInfo) {
    return (
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex justify-end px-6 pt-4"><GlobalActions /></div>
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-3xl mx-auto px-6 py-12 space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold">{c.localServers.length === 0 ? t("nui.welcome.title") : t("nui.pick.title")}</h1>
              <p className="text-sm text-theme-secondary">{c.localServers.length === 0 ? t("nui.welcome.subtitle") : t("host.selectPrompt")}</p>
            </div>
            <div className="grid gap-3">
              {[
                { icon: Plus, title: t("nui.welcome.create"), text: t("nui.welcome.createHint"), primary: true, onClick: () => c.onSetShowCreateServer(true) },
                { icon: FolderOpen, title: t("serverList.import"), text: t("nui.welcome.importHint"), primary: false, onClick: () => c.handleImportServer() },
                { icon: Package, title: t("serverList.importModpack"), text: t("nui.welcome.modpackHint"), primary: false, onClick: () => c.setShowImportModpack(true) },
              ].map(({ icon: Icon, title, text, primary, onClick }) => (
                <button
                  key={title}
                  type="button"
                  onClick={onClick}
                  className={cn("w-full text-left flex items-center gap-4 rounded-2xl border p-5 cursor-pointer", primary ? "bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700" : "bg-theme-card border-theme-card hover:border-indigo-400")}
                >
                  <span className={cn("w-11 h-11 rounded-xl grid place-items-center shrink-0", primary ? "bg-white/15" : "bg-theme-muted")}><Icon className="w-5 h-5" /></span>
                  <span className="min-w-0">
                    <span className="block font-bold">{title}</span>
                    <span className={cn("block text-sm mt-0.5", primary ? "text-white/80" : "text-theme-secondary")}>{text}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const modsCapable = MOD_TYPES.includes(serverInfo.serverType);
  const isPlugin = PLUGIN_TYPES.includes(serverInfo.serverType);
  const tabs: { id: Tab; label: string; icon: typeof Users; badge?: number }[] = [
    { id: "overview", label: t("nui.tab.overview"), icon: LayoutDashboard },
    { id: "players", label: t("nui.tab.players"), icon: Users, badge: serverStatus === "online" ? c.onlinePlayers.length : undefined },
    { id: "world", label: t("nui.tab.world"), icon: Globe },
    ...(modsCapable ? [{ id: "mods" as const, label: isPlugin ? "Plugins" : "Mods", icon: Package }] : []),
    { id: "performance", label: t("nui.tab.performance"), icon: Gauge },
    { id: "settings", label: t("nui.tab.settings"), icon: Settings },
  ];
  const active: Tab = tabs.some((x) => x.id === tab) ? tab : "overview";

  const statusLabel =
    headline === "preparing" ? t("host.status.preparing")
    : headline === "connecting" ? t("host.status.connecting")
    : headline === "onlineFriends" ? t("host.status.friends")
    : headline === "localOnlyChoice" || headline === "localOnlyFailed" ? t("host.status.localOnly")
    : serverStatus === "online" ? t("host.status.online")
    : serverStatus === "starting" ? t("host.status.starting")
    : serverStatus === "stopping" ? t("host.status.stopping")
    : serverStatus === "crashed" ? t("host.status.crashed")
    : t("host.status.offline");
  const tone: "good" | "warn" | "bad" | "idle" =
    headline === "onlineFriends" ? "good"
    : serverStatus === "crashed" ? "bad"
    : headline === "idle" || serverStatus === "offline" ? "idle"
    : "warn";
  const pillCls =
    tone === "good" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
    : tone === "bad" ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
    : tone === "idle" ? "bg-theme-muted text-theme-secondary border-theme-card"
    : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
  const dotCls = tone === "good" ? "bg-emerald-500" : tone === "bad" ? "bg-rose-500" : tone === "idle" ? "bg-slate-400" : "bg-amber-500 animate-pulse";

  const code = displayShortCode ? `CF-${displayShortCode}` : null;
  const stopAction = isStopAction(headline);
  const busy = headline === "preparing" || headline === "starting" || headline === "stopping";

  // ---------- faixa de avisos (só aparece quando há algo a dizer) ----------
  const banners: React.ReactNode[] = [];
  if (preparing && serverInstallProgress) {
    banners.push(
      <Banner key="install" kind="info" icon={<Loader2 className="w-4 h-4 animate-spin" />}>
        <div className="flex justify-between text-xs font-bold uppercase tracking-wider"><span>{serverInstallProgress.status}</span><span>{serverInstallProgress.percent}%</span></div>
        <div className="mt-2 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
          <motion.div initial={{ width: 0 }} animate={{ width: `${serverInstallProgress.percent}%` }} className="h-full bg-indigo-600" />
        </div>
      </Banner>,
    );
  } else if (headline === "preparing" || headline === "starting" || headline === "connecting") {
    banners.push(
      <Banner key="progress" kind="info" icon={<Loader2 className="w-4 h-4 animate-spin" />}>
        <p className="font-bold">{statusLabel}</p>
        <p className="text-xs opacity-90 mt-0.5">{friendsHint[headline]}</p>
      </Banner>,
    );
  }

  if (idleShutdownWarning !== null) {
    banners.push(
      <Banner key="idle" kind="warn" icon={<AlertTriangle className="w-4 h-4" />} action={<MiniButton tone="primary" onClick={c.handleCancelIdleShutdown}>{t("host.idle.keepOn")}</MiniButton>}>
        {rich("host.idle.warning", { seconds: <strong>{idleShutdownWarning}s</strong> })}
      </Banner>,
    );
  }

  if (serverStatus === "crashed") {
    banners.push(
      <Banner key="crash" kind="bad" icon={<AlertTriangle className="w-4 h-4" />}>
        {lastCrashInfo ? (<><span className="font-bold">{lastCrashInfo.title}.</span> {lastCrashInfo.message}</>) : (<><span className="font-bold">{t("host.crash.unexpected")}</span> {t("host.crash.hint")}</>)}
        {lastCrashInfo?.detail && (
          <div className="mt-2">
            <button type="button" onClick={() => setShowCrashDetail((v: boolean) => !v)} className="flex items-center gap-1 text-xs font-bold hover:underline cursor-pointer">
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showCrashDetail && "rotate-180")} />
              {showCrashDetail ? t("host.crash.hideDetail") : t("host.crash.showDetail")}
            </button>
            {showCrashDetail && <pre className="mt-2 p-3 bg-black/10 dark:bg-black/30 rounded-xl text-[10px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar">{lastCrashInfo.detail}</pre>}
          </div>
        )}
      </Banner>,
    );
  }

  if (wakeOnDemandServerInfo?.wakeOnDemandEnabled && hosting.wakePaused && !sessionActive && serverStatus === "offline") {
    banners.push(
      <Banner key="standby" kind="warn" icon={<BedDouble className="w-4 h-4" />} action={<MiniButton tone="primary" onClick={c.handleResumeStandby}><RefreshCw className="w-3.5 h-3.5" />{t("host.standby.resume")}</MiniButton>}>
        <span className="font-bold">{t("host.standby.banner.title")}</span> {t("host.standby.banner.body")}
      </Banner>,
    );
  }

  if (sessionActive && headline === "localOnlyFailed") {
    banners.push(
      <Banner
        key="local-failed"
        kind="warn"
        icon={<AlertTriangle className="w-4 h-4" />}
        action={
          <MiniButton tone="primary" onClick={c.handleRetryNetwork} disabled={hosting.netRetrying}>
            {hosting.netRetrying ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("host.starting")}</> : <><RefreshCw className="w-3.5 h-3.5" />{t("host.local.retry")}</>}
          </MiniButton>
        }
      >
        <span className="font-bold">{hosting.localOnlyReason === "networkDropped" ? t("host.local.dropped.title") : t("host.local.failed.title")}</span>{" "}
        {hosting.netRetrying ? t("host.local.retrying") : hosting.netGaveUp ? t("host.local.gaveUp") : retryInSecs !== null ? t("host.local.retryIn", { seconds: retryInSecs }) : t("host.local.failed.body")}
      </Banner>,
    );
  }

  if (sessionActive && headline === "localOnlyChoice") {
    banners.push(
      <Banner
        key="local-choice"
        kind="neutral"
        icon={<Globe className="w-4 h-4" />}
        action={serverInfo.shortCode ? <MiniButton tone="primary" onClick={c.handleRetryNetwork}><Globe className="w-3.5 h-3.5" />{t("host.local.open")}</MiniButton> : undefined}
      >
        <span className="font-bold text-theme-primary">{t("host.local.choice.title")}</span> {t("host.local.choice.body")}
      </Banner>,
    );
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {/* Barra do servidor: sempre visível */}
      <header className="shrink-0 bg-theme-card/90 backdrop-blur border-b border-theme-card">
        <div className="px-6 pt-4 pb-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="min-w-[15rem] flex-1 flex items-center gap-3">
            <ServerAvatar path={serverInfo.path} name={selectedServer} size="sm" />
            <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold truncate max-w-full">{selectedServer}</h1>
              <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold whitespace-nowrap", pillCls)}>
                <span className={cn("w-1.5 h-1.5 rounded-full", dotCls)} />{statusLabel}
              </span>
              {wakeOnDemandServerInfo?.wakeOnDemandEnabled && serverStatus === "offline" && (
                <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-theme-accent border border-theme-accent text-indigo-600" title={hosting.wakePaused ? t("host.standby.pausedTitle") : undefined}>
                  {hosting.wakePaused ? t("host.standby.paused") : t("host.standby")}
                </span>
              )}
            </div>
            <p className="text-xs text-theme-secondary mt-0.5 truncate">
              {serverTypeLabel} · {t("serverList.version", { version: serverInfo.version || t("serverList.versionNotFound") })}{serverInfo.forgeVersion ? ` · ${serverInfo.forgeVersion}` : ""}
            </p>
            </div>
          </div>

          {code && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => copyToClipboard(code)}
                title={t("host.copyCode")}
                className="group flex items-center gap-2 px-3 py-2 rounded-xl bg-theme-muted border border-theme-card hover:border-indigo-400 cursor-pointer"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{t("host.code")}</span>
                <span className="font-mono text-sm font-bold">{code}</span>
                {copiedText === code ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-theme-secondary group-hover:text-indigo-600" />}
              </button>
              <button
                type="button"
                onClick={() => c.setShowRegenerateCode(true)}
                disabled={serverStatus !== "offline"}
                title={serverStatus !== "offline" ? t("host.regen.tooltipRunning") : t("host.regen.tooltip")}
                aria-label={t("host.regen.tooltip")}
                className="p-2.5 rounded-xl border border-theme-card bg-theme-muted text-theme-secondary hover:text-indigo-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              ><RefreshCw className="w-3.5 h-3.5" /></button>
            </div>
          )}

          <div className="flex items-center gap-2">
            {(headline === "idle" || headline === "crashed") && (
              <button
                type="button"
                onClick={() => c.handleStartHosting({ localOnly: true })}
                title={t("host.startLocalOnly.hint")}
                className="px-3 py-2.5 rounded-xl text-xs font-bold text-theme-secondary border border-theme-card hover:text-indigo-600 hover:border-indigo-400 cursor-pointer whitespace-nowrap"
              >{t("host.startLocalOnly")}</button>
            )}
            <button
              type="button"
              onClick={stopAction ? c.handleStopHosting : () => c.handleStartHosting()}
              disabled={isPrimaryDisabled(headline)}
              title={headline === "starting" ? t("host.cancelStart") : undefined}
              className={cn(
                "inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white shadow-sm cursor-pointer disabled:opacity-60 disabled:cursor-wait whitespace-nowrap",
                headline === "starting" ? "bg-amber-500 hover:bg-amber-600" : stopAction ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700",
              )}
            >
              {headline === "preparing" || headline === "starting" ? <><Loader2 className="w-4 h-4 animate-spin" />{t("host.starting")}</>
                : headline === "stopping" ? <><Loader2 className="w-4 h-4 animate-spin" />{t("host.stopping")}</>
                : stopAction ? <><X className="w-4 h-4" />{t("host.stopServer")}</>
                : <><Play className="w-4 h-4 fill-current" />{t("host.startServer")}</>}
            </button>
            {!busy && <span className="sr-only" aria-live="polite">{statusLabel}</span>}
            <GlobalActions />
          </div>
        </div>

        <nav className="px-4 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t("nui.tabs.aria")}>
          {tabs.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={active === id ? "page" : undefined}
              className={cn("flex items-center gap-2 px-3.5 py-2.5 text-sm font-bold border-b-2 whitespace-nowrap cursor-pointer", active === id ? "border-indigo-600 text-indigo-600" : "border-transparent text-theme-secondary hover:text-theme-primary")}
            >
              <Icon className="w-4 h-4" />{label}
              {badge !== undefined && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-theme-muted border border-theme-card">{badge}</span>}
            </button>
          ))}
        </nav>
      </header>

      {/* Conteúdo da aba (só ele rola) */}
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
          {banners.length > 0 && <div className="space-y-3">{banners}</div>}

          {active === "overview" && <OverviewTab c={c} onGoTo={setTab} />}
          {active === "players" && (
            <PlayersPanel key={`players-${serverInfo.path}`} serverDir={serverInfo.path} serverStatus={serverStatus} onlinePlayers={c.onlinePlayers} onSendCommand={c.handleSendMCCommand} />
          )}
          {active === "world" && (
            <ServerManagePanel
              key={`world-${serverInfo.path}`}
              section="mundo"
              serverDir={serverInfo.path}
              serverName={serverInfo.name}
              serverType={serverInfo.serverType}
              serverStatus={serverStatus}
              mcVersion={serverInfo.version}
              serverInfo={serverInfo}
              onServerUpgraded={() => c.handleServerUpgraded(serverInfo.path)}
            />
          )}
          {active === "mods" && (
            <ServerManagePanel
              key={`mods-${serverInfo.path}`}
              section="mods"
              serverDir={serverInfo.path}
              serverName={serverInfo.name}
              serverType={serverInfo.serverType}
              serverStatus={serverStatus}
              mcVersion={serverInfo.version}
              serverInfo={serverInfo}
              onServerUpgraded={() => c.handleServerUpgraded(serverInfo.path)}
              autoOpenModBrowser={c.autoOpenModsFor === serverInfo.name}
              onAutoOpenHandled={() => c.setAutoOpenModsFor(null)}
            />
          )}
          {active === "performance" && (
            c.runningServerName === selectedServer
              ? <PerformancePanel serverDir={serverInfo.path} serverStatus={serverStatus} onOpenConfig={() => setTab("settings")} />
              : <p className="text-sm text-theme-secondary text-center py-12">{t("nui.performance.offline")}</p>
          )}
          {active === "settings" && <SettingsTab c={c} />}
        </div>
      </main>

      <Dock
        mcLogs={c.mcLogs}
        networkLogs={c.logs}
        serverStatus={serverStatus}
        onSendCommand={c.handleSendMCCommand}
        onClearLogs={(which) => { if (which === "minecraft") c.onSetMcLogs([]); else c.onSetLogs([]); }}
      />
    </div>
  );
}
