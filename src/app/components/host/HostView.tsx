"use client";

import { motion } from "framer-motion";
import { Settings, Play, Copy, Check, ShieldCheck, Activity, FolderOpen, X, Loader2, AlertTriangle, Database, ChevronDown, Globe, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

import { invoke } from "@tauri-apps/api/core";

import { PerformancePanel } from "./PerformancePanel";

import { isPrimaryDisabled, isStopAction } from "@/lib/hosting";
import { listAllServers, getJavaVersion } from "@/lib/server";

import { inviteLinkUrl } from "@/lib/inviteLink";

import { pathLabelKey } from "@/lib/networkTransport";

import { ConsolePanel } from "./ConsolePanel";
import { ServerManagePanel } from "./ServerManagePanel";

import { PlayersPanel } from "./PlayersPanel";
import { ServerList } from "./ServerList";

import { t as tn } from "@/i18n";
import { useHostController, type HostViewProps } from "./useHostController";
import { HostModals } from "./HostModals";
import { meshAddressLabel } from "@/lib/meshAddress";

// ============================================================
// HostView
// ============================================================
// Painel principal do host (layout atual). Toda a lógica vive em useHostController; os modais em HostModals.
// Recebe estados e callbacks do page.tsx para preservar estado ao alternar entre abas Host/Guest.
// ============================================================

export type { HostViewProps };

export function HostView(props: HostViewProps) {
  const c = useHostController(props);
  const {
    t,
    rich,
    serverDir,
    selectedServer,
    setSelectedServer,
    serverStatus,
    onlinePlayers,
    lastCrashInfo,
    importedServerPaths,
    runningServerName,
    wakeOnDemandServerInfo,
    isImporting,
    showCrashDetail,
    setShowCrashDetail,
    setShowImportModpack,
    autoOpenModsFor,
    setAutoOpenModsFor,
    setShowImportPack,
    setShowRegenerateCode,
    idleShutdownWarning,
    preparing,
    networkPath,
    handleCancelIdleShutdown,
    handleStartHosting,
    handleStopHosting,
    handleResumeStandby,
    handleRetryNetwork,
    handleSendMCCommand,
    handleSelectDir,
    copiedText,
    copyToClipboard,
    handleDeleteServer,
    handleImportServer,
    serverInfo,
    displayShortCode,
    headline,
    sessionActive,
    retryInSecs,
    friendsOnline,
    friendsHint,
    inviteSlug,
    serverTypeLabel,
    netIp,
    hosting,
    logs,
    mcLogs,
    localServers,
    serverInstallProgress,
    isDeletingServer,
    serverConfigPort,
    resourceSample,
    onSetLogs,
    onSetMcLogs,
    onSetLocalServers,
    onSetShowCreateServer,
    onSetShowConfigModal,
    onSetConfigServerDir,
    onOpenSubscribe
  } = c;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Painel Principal (2 colunas) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Minecraft Server Control Card */}
          <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
            {/* Duas faixas fixas: informações do servidor em cima; embaixo, o status à
                esquerda e as ações à direita. Sem depender da largura da janela, nunca
                sobra um vão nem o título é espremido pelos controles. */}
            <div className="space-y-5">
              <div className="min-w-0">
                <span className="inline-block whitespace-nowrap text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
                  Minecraft Server {serverTypeLabel}
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <h2 className="text-3xl font-bold text-theme-primary truncate">
                    {selectedServer ? selectedServer : t("host.noServerSelected")}
                  </h2>
                  {selectedServer && (
                    <button
                      type="button"
                      onClick={() => {
                        const sv = localServers.find(s => s.name === selectedServer);
                        if (sv) { onSetConfigServerDir(sv.path); onSetShowConfigModal(true); }
                      }}
                      className="p-1.5 hover:bg-theme-muted rounded-lg transition-all duration-300 text-theme-secondary hover:text-indigo-600 hover:rotate-45 flex-shrink-0 cursor-pointer"
                      title={t("serverSettings.button")}
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-theme-secondary mt-1">
                  {selectedServer
                    ? `${t("serverList.version", { version: serverInfo?.version || t("serverList.versionNotFound") })}${serverInfo?.forgeVersion ? ` • ${serverTypeLabel}: ${serverInfo.forgeVersion}` : ""}`
                    : t("host.selectPrompt")}
                </p>

                {/* Código de convite permanente */}
                {selectedServer && displayShortCode && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-theme-accent border border-theme-accent rounded-xl whitespace-nowrap">
                      <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">{t("host.code")}</span>
                      <span className="font-mono font-bold text-indigo-700 dark:text-indigo-300 text-sm tracking-wider whitespace-nowrap">
                        CF-{displayShortCode}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(`CF-${displayShortCode}`)}
                      className="p-1.5 bg-indigo-100 dark:bg-indigo-800/40 text-indigo-600 dark:text-indigo-300 rounded-lg hover:bg-indigo-200 dark:hover:bg-indigo-700/50 transition-all active:scale-95 cursor-pointer"
                      title={t("host.copyCode")}
                    >
                      {copiedText === `CF-${displayShortCode}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRegenerateCode(true)}
                      disabled={serverStatus !== "offline"}
                      className="p-1.5 bg-theme-muted text-theme-secondary rounded-lg hover:bg-theme-card hover:text-indigo-600 transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      title={serverStatus !== "offline" ? t("host.regen.tooltipRunning") : t("host.regen.tooltip")}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {/* Link de convite (play.cubicase.net/<slug>) — grátis com o código como
                    padrão, personalizável com Cubicase Plus no modal de configuração. */}
                {selectedServer && inviteSlug && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-xs text-theme-secondary font-mono truncate">
                      play.cubicase.net/{inviteSlug}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(inviteLinkUrl(inviteSlug))}
                      className="p-1 text-theme-secondary hover:text-indigo-600 transition-all active:scale-95 cursor-pointer flex-shrink-0"
                      title={t("host.copyInvite")}
                    >
                      {copiedText === inviteLinkUrl(inviteSlug) ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                )}
              </div>

              {selectedServer && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 pt-5 border-t border-theme-card">
                  <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-theme-muted border border-theme-card rounded-xl text-xs font-bold text-theme-secondary whitespace-nowrap">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      serverStatus === "online" ? "bg-emerald-500 animate-pulse" :
                      serverStatus === "starting" ? "bg-amber-500 animate-bounce" :
                      serverStatus === "stopping" ? "bg-orange-500 animate-pulse" :
                      serverStatus === "crashed" ? "bg-rose-500" : "bg-slate-400"
                    )} />
                    <span className="uppercase tracking-wider">
                      {headline === "preparing" ? t("host.status.preparing") :
                       headline === "connecting" ? t("host.status.connecting") :
                       headline === "onlineFriends" ? t("host.status.friends") :
                       headline === "localOnlyChoice" || headline === "localOnlyFailed" ? t("host.status.localOnly") :
                       serverStatus === "online" ? t("host.status.online") :
                       serverStatus === "starting" ? t("host.status.starting") :
                       serverStatus === "stopping" ? t("host.status.stopping") :
                       serverStatus === "crashed" ? t("host.status.crashed") : t("host.status.offline")}
                    </span>
                  </div>

                  {wakeOnDemandServerInfo?.wakeOnDemandEnabled && serverStatus === "offline" && (
                    hosting.wakePaused ? (
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-xl text-xs font-bold text-amber-700 dark:text-amber-300 whitespace-nowrap" title={t("host.standby.pausedTitle")}>
                        <div className="w-2 h-2 rounded-full bg-amber-500" />
                        <span className="uppercase tracking-wider">{t("host.standby.paused")}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-xl text-xs font-bold text-indigo-600 dark:text-indigo-300 whitespace-nowrap">
                        <div className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
                        <span className="uppercase tracking-wider">{t("host.standby")}</span>
                      </div>
                    )
                  )}

                  {/* Indicador leve de saúde: RAM/CPU real da máquina, atualizado a
                      cada ~15s (ver src-tauri thread de amostragem + mc-resource-sample).
                      Sem histórico/gráfico — só o valor mais recente, pra dar uma noção
                      contínua sem virar um dashboard. */}
                  {serverStatus === "online" && resourceSample?.totalRamMb && resourceSample.availableRamMb !== undefined && (
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 bg-theme-muted border border-theme-card rounded-xl text-xs font-bold text-theme-secondary whitespace-nowrap"
                      title={t("host.resourceTitle")}
                    >
                      <Activity className="w-3.5 h-3.5" />
                      <span>
                        RAM {Math.round(((resourceSample.totalRamMb - resourceSample.availableRamMb) / resourceSample.totalRamMb) * 100)}%
                        {" · "}
                        CPU {Math.round(resourceSample.cpuUsagePercent ?? 0)}%
                      </span>
                    </div>
                  )}
                  </div>

                  <div className="flex items-center gap-3">
                  {/* "Só neste computador": o caminho avançado, sem rede. Fica discreto
                      ao lado do botão principal e só aparece quando há o que iniciar. */}
                  {(headline === "idle" || headline === "crashed") && (
                    <button
                      type="button"
                      onClick={() => handleStartHosting({ localOnly: true })}
                      className="h-12 px-4 rounded-xl text-xs font-bold whitespace-nowrap text-theme-secondary border border-theme-card hover:text-indigo-600 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all active:scale-95 cursor-pointer"
                      title={t("host.startLocalOnly.hint")}
                    >
                      {t("host.startLocalOnly")}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={isStopAction(headline) ? handleStopHosting : () => handleStartHosting()}
                    disabled={isPrimaryDisabled(headline)}
                    className={cn(
                      "h-12 px-6 rounded-xl font-bold flex items-center gap-2 whitespace-nowrap transition-all active:scale-95 shadow-md disabled:opacity-50 cursor-pointer",
                      headline === "starting"
                        ? "bg-amber-500 hover:bg-amber-600 text-white shadow-theme-shadow"
                        : isStopAction(headline)
                          ? "bg-rose-500 hover:bg-rose-600 text-white shadow-theme-shadow"
                          : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-theme-shadow"
                    )}
                    title={headline === "starting" ? t("host.cancelStart") : undefined}
                  >
                    {headline === "preparing" || headline === "starting" ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> {t("host.starting")}</>
                    ) : headline === "stopping" ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> {t("host.stopping")}</>
                    ) : isStopAction(headline) ? (
                      <><X className="w-4 h-4" /> {t("host.stopServer")}</>
                    ) : (
                      <><Play className="w-4 h-4 fill-current" /> {t("host.startServer")}</>
                    )}
                  </button>
                  </div>
                </div>
              )}
            </div>

            {idleShutdownWarning !== null && (
              <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl text-sm flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
                  <span>{rich("host.idle.warning", { seconds: <strong>{idleShutdownWarning}s</strong> })}</span>
                </div>
                <button
                  type="button"
                  onClick={handleCancelIdleShutdown}
                  className="px-4 h-10 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex-shrink-0 cursor-pointer transition-colors"
                >
                  {t("host.idle.keepOn")}
                </button>
              </div>
            )}

            {serverStatus === "crashed" && (
              <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-2xl text-sm">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    {lastCrashInfo ? (
                      <>
                        <span className="font-bold">{lastCrashInfo.title}.</span> {lastCrashInfo.message}
                      </>
                    ) : (
                      <>
                        <span className="font-bold">{t("host.crash.unexpected")}</span> {t("host.crash.hint")}
                      </>
                    )}

                    {lastCrashInfo?.detail && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setShowCrashDetail((v) => !v)}
                          className="flex items-center gap-1 text-xs font-bold text-rose-700 dark:text-rose-300 hover:underline cursor-pointer"
                        >
                          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showCrashDetail && "rotate-180")} />
                          {showCrashDetail ? t("host.crash.hideDetail") : t("host.crash.showDetail")}
                        </button>
                        {showCrashDetail && (
                          <pre className="mt-2 p-3 bg-black/10 dark:bg-black/30 rounded-xl text-[10px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar">
                            {lastCrashInfo.detail}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Parou à mão com o modo de espera ligado: deixa EXPLÍCITO por que ninguém
                consegue acordar o servidor e como reativar. */}
            {wakeOnDemandServerInfo?.wakeOnDemandEnabled && hosting.wakePaused && !sessionActive && serverStatus === "offline" && (
              <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-center justify-between gap-4 text-sm">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">{t("host.standby.banner.title")}</span> {t("host.standby.banner.body")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleResumeStandby}
                  className="flex-shrink-0 h-10 px-5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all text-xs font-bold flex items-center gap-2 cursor-pointer shadow-md shadow-theme-shadow whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> {t("host.standby.resume")}
                </button>
              </div>
            )}

            {/* Servidor de pé, mas os amigos ainda não conseguem entrar: a rede falhou
                ou caiu. O Minecraft NÃO é derrubado — só avisamos e oferecemos retomar. */}
            {sessionActive && headline === "localOnlyFailed" && (
              <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-center justify-between gap-4 text-sm">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">
                      {hosting.localOnlyReason === "networkDropped" ? t("host.local.dropped.title") : t("host.local.failed.title")}
                    </span>{" "}
                    {hosting.netRetrying ? t("host.local.retrying")
                      : hosting.netGaveUp ? t("host.local.gaveUp")
                      : retryInSecs !== null ? t("host.local.retryIn", { seconds: retryInSecs })
                      : t("host.local.failed.body")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRetryNetwork}
                  disabled={hosting.netRetrying}
                  className="flex-shrink-0 h-10 px-5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all text-xs font-bold flex items-center gap-2 disabled:opacity-50 cursor-pointer shadow-md shadow-theme-shadow"
                >
                  {hosting.netRetrying ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("host.starting")}</>
                  ) : (
                    <><RefreshCw className="w-3.5 h-3.5" /> {t("host.local.retry")}</>
                  )}
                </button>
              </div>
            )}

            {/* Iniciado de propósito só neste computador. */}
            {sessionActive && headline === "localOnlyChoice" && (
              <div className="p-4 bg-theme-muted border border-theme-card text-theme-secondary rounded-2xl flex items-center justify-between gap-4 text-sm">
                <div className="flex items-start gap-3">
                  <Globe className="w-5 h-5 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-theme-primary">{t("host.local.choice.title")}</span> {t("host.local.choice.body")}
                  </div>
                </div>
                {serverInfo?.shortCode && (
                  <button
                    type="button"
                    onClick={handleRetryNetwork}
                    className="flex-shrink-0 h-10 px-5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all text-xs font-bold flex items-center gap-2 cursor-pointer shadow-md shadow-theme-shadow"
                  >
                    <Globe className="w-3.5 h-3.5" /> {t("host.local.open")}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Amigos: convite + estado da conexão. A rede mesh é um detalhe
              técnico — só aparece (colapsada) para diagnóstico. */}
          <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
            <div>
              <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
                {t("host.friends.badge")}
              </span>
              <h2 className="text-3xl font-bold text-theme-primary mt-2">{t("host.friends.title")}</h2>
              <p className="text-theme-secondary mt-1">{t("host.friends.subtitle")}</p>
            </div>

            {preparing && serverInstallProgress && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold text-indigo-600 uppercase tracking-wider">
                  <span>{serverInstallProgress.status}</span>
                  <span>{serverInstallProgress.percent}%</span>
                </div>
                <div className="w-full h-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${serverInstallProgress.percent}%` }}
                    className="h-full bg-indigo-600"
                  />
                </div>
              </div>
            )}

            {friendsOnline && displayShortCode ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-6 bg-theme-accent border border-theme-accent rounded-2xl flex flex-col md:flex-row items-center justify-between gap-4"
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-xl flex items-center justify-center shadow-theme-shadow">
                    <ShieldCheck className="text-indigo-600 w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-indigo-900 dark:text-indigo-200">{t("host.friends.onlineTitle")}</p>
                    <p className="text-xs text-indigo-600 dark:text-indigo-400">{t("host.net.share")}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="bg-white dark:bg-slate-800 px-4 py-2 rounded-xl font-mono font-bold text-indigo-600 dark:text-indigo-300 text-sm shadow-theme-shadow border border-theme-accent">
                    CF-{displayShortCode}
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(`CF-${displayShortCode}`)}
                    className="p-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-theme-shadow active:scale-95 cursor-pointer"
                    title={t("host.copyCodeShort")}
                  >
                    {copiedText === `CF-${displayShortCode}` ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </motion.div>
            ) : (
              <div className="p-5 bg-theme-muted border border-theme-card rounded-2xl flex items-center gap-4 text-sm text-theme-secondary">
                <Globe className="w-5 h-5 flex-shrink-0 text-slate-400" />
                <span>{friendsHint[headline]}</span>
              </div>
            )}

            {/* Detalhes técnicos da rede (diagnóstico) — fora do caminho do usuário comum. */}
            <details className="group">
              <summary className="cursor-pointer select-none text-xs font-bold text-theme-secondary uppercase tracking-wider hover:text-theme-primary">
                {t("host.tech.summary")}
              </summary>
              <div className="grid grid-cols-3 gap-4 mt-4">
                <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
                  <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">{t("host.net.redirect")}</p>
                  <p className="text-sm font-bold text-theme-primary mt-1">127.0.0.1:{serverConfigPort}</p>
                </div>
                <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
                  <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">{t("host.net.meshAddress")}</p>
                  <p className="text-sm font-bold text-theme-primary mt-1">{meshAddressLabel(hosting.ip ?? netIp, networkPath, t) || t("host.net.inactive")}</p>
                </div>
                <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
                  <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">{t("host.net.interface")}</p>
                  <p className={cn("text-sm font-bold mt-1", hosting.net === "online" ? "text-emerald-600" : "text-theme-secondary")}>
                    {hosting.net === "online" ? t("host.net.active") : t("host.net.disconnected")}
                  </p>
                </div>
              </div>
              {hosting.netError && (
                <p className="mt-3 text-[11px] font-mono text-theme-secondary break-words">{hosting.netError}</p>
              )}
            </details>
          </div>

          {/* Gerenciamento de Mods e Mundo */}
          {selectedServer && serverInfo && (
            <ServerManagePanel
              key={`manage-${serverInfo.path}`}
              serverDir={serverInfo.path}
              serverName={serverInfo.name}
              serverType={serverInfo.serverType}
              serverStatus={serverStatus}
              mcVersion={serverInfo.version}
              serverInfo={serverInfo}
              onServerUpgraded={async () => {
                // A versão/loader/jar mudaram no cubicase-meta.json: relê a lista e avisa a API Central (melhor esforço).
                try {
                  const servers = await listAllServers(importedServerPaths);
                  onSetLocalServers(servers);
                  const updated = servers.find((s) => s.path === serverInfo.path);
                  if (updated?.shortCode) {
                    await invoke("sync_register_server", {
                      name: updated.name,
                      version: updated.version || "1.20.1",
                      serverType: updated.serverType || "vanilla",
                      description: updated.description || "",
                      shortCode: updated.shortCode,
                      owner: null,
                      forgeVersion: updated.forgeVersion ?? null,
                      modLoaderVersion: updated.modLoaderVersion ?? null,
                      serverDir: updated.path,
                    });
                  }
                } catch (err) {
                  console.warn("Falha ao atualizar a lista/API depois da atualização de versão:", err);
                }
              }}
              autoOpenModBrowser={autoOpenModsFor === serverInfo.name}
              onAutoOpenHandled={() => setAutoOpenModsFor(null)}
            />
          )}

          {/* Whitelist, operadores e banimentos */}
          {selectedServer && serverInfo && (
            <PlayersPanel
              key={`players-${serverInfo.path}`}
              serverDir={serverInfo.path}
              serverStatus={serverStatus}
              onlinePlayers={onlinePlayers}
              onSendCommand={handleSendMCCommand}
            />
          )}

          {/* Desempenho: TPS, memória, CPU e "por que está travando?" (só do servidor que está rodando) */}
          {selectedServer && serverInfo && runningServerName === selectedServer && (
            <PerformancePanel
              serverDir={serverInfo.path}
              serverStatus={serverStatus}
              onOpenConfig={() => { onSetConfigServerDir(serverInfo.path); onSetShowConfigModal(true); }}
            />
          )}

          {/* Console */}
          <ConsolePanel
            mcLogs={mcLogs}
            networkLogs={logs}
            serverStatus={serverStatus}
            onSendCommand={handleSendMCCommand}
            onClearLogs={(tab) => {
              if (tab === "minecraft") onSetMcLogs([]);
              else onSetLogs([]);
            }}
          />
        </div>

        {/* Sidebar (1 coluna) */}
        <div className="space-y-6">
          <ServerList
            servers={localServers}
            selectedServer={selectedServer}
            serverStatus={serverStatus}
            onSelect={setSelectedServer}
            onCreate={() => onSetShowCreateServer(true)}
            onImport={handleImportServer}
            onImportModpack={() => setShowImportModpack(true)}
            onImportPack={() => setShowImportPack(true)}
            onDelete={handleDeleteServer}
            onConfig={(path) => { onSetConfigServerDir(path); onSetShowConfigModal(true); }}
            isDeleting={isDeletingServer}
            isImporting={isImporting}
          />

          {/* Parâmetros Globais */}
          <div className="bg-theme-card p-6 rounded-[2rem] border-theme-card shadow-theme-card">
            <h3 className="font-bold text-theme-primary mb-4 flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-400" /> {t("host.params.title")}
            </h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-theme-secondary">{t("host.params.dir")}</span>
                <button
                  type="button"
                  onClick={handleSelectDir}
                  className="p-2 bg-theme-muted hover:bg-theme-card rounded-lg border border-theme-card transition-colors cursor-pointer"
                  title={t("host.params.pickDir")}
                >
                  <FolderOpen className="w-4 h-4 text-indigo-600" />
                </button>
              </div>
              <p className="text-[10px] text-theme-secondary font-mono truncate bg-theme-muted p-2 rounded-lg border border-theme-card" title={serverDir || ""}>
                {serverDir || t("config.loading")}
              </p>

              <div className="flex justify-between items-end mt-4">
                <span className="text-sm text-theme-secondary">{t("host.params.port")}</span>
                <span className="text-sm font-bold font-mono text-theme-primary">{serverConfigPort}</span>
              </div>

              <div className="flex justify-between items-end mt-4">
                <span className="text-sm text-theme-secondary">Java Runtime</span>
                <span className="text-sm font-bold text-indigo-600">
                  {selectedServer
                    ? `JRE ${getJavaVersion(serverInfo?.version || "1.20.1")}`
                    : "JRE 17 / 21"}
                </span>
              </div>
            </div>
          </div>

          {/* Cubicase Plus */}
          <div className="bg-indigo-600 p-6 rounded-[2rem] text-white shadow-theme-xl">
            <h3 className="font-bold text-white mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4" /> Cubicase Plus
            </h3>
            <p className="text-indigo-100 text-sm leading-relaxed mb-4">
              {t("host.plus.desc")}
            </p>
            <button
              type="button"
              onClick={onOpenSubscribe}
              className="w-full py-3 bg-white text-indigo-600 rounded-2xl font-bold text-sm hover:bg-indigo-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              {t("host.plus.subscribe")}
            </button>
          </div>
        </div>
      </div>

      <HostModals c={c} />
    </>
  );
}
