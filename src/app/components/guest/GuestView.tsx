"use client";

import { GuestServerAvatar } from "@/app/components/GuestServerAvatar";
import { motion } from "framer-motion";
import { Plus, X, Server, Globe, WifiOff, Clock, Users, Trash2, Loader2, AlertTriangle, Zap, Copy, Check, RefreshCw, Play, LifeBuoy } from "lucide-react";
import { cn } from "@/lib/utils";

import { useConnectionHelp } from "@/lib/connectionHelp";


import { useGuestController, PLAYABLE_SERVER_TYPES, type GuestViewProps } from "./useGuestController";
import { GuestModals } from "./GuestModals";

// ============================================================
// GuestView
// ============================================================
// Biblioteca pessoal de servidores conhecidos (layout atual). A lógica vive em useGuestController.
// ============================================================

export type { GuestViewProps };

export function GuestView(props: GuestViewProps) {
  const c = useGuestController(props);
  const {
    t,
    rich,
    locale,
    knownServers,
    connectedShortCode,
    addressFor,
    setShowAddModal,
    isRefreshing,
    lastRefreshTime,
    isOfflineMode,
    copied,
    wakingShortCode,
    wakeError,
    now,
    prepModalFor,
    prepStates,
    serverKindLabel,
    handlePrepareAndPlay,
    refreshAllServers,
    handleWakeServer,
    isServerStale,
    handleConnect,
    handleDisconnect,
    handleRemoveServer,
    copyToClipboard,
    formatLastSeen,
    formatUptime,
    getDisplayStatus,
    isConnecting,
    isOnline,
    renderOwnPlayButton
  } = c;

  return (
    <div className="space-y-6">
      {/* Cabeçalho da Biblioteca */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold text-theme-primary flex items-center gap-3">
            <Globe className="w-7 h-7 text-indigo-600" />
            {t("guest.title")}
          </h2>
          <p className="text-theme-secondary text-sm">
            {knownServers.length === 0
              ? t("guest.emptyPrompt")
              : t("guest.count", { count: knownServers.length })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Indicador de modo offline */}
          {isOfflineMode && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-xl text-[10px] font-bold text-amber-600 dark:text-amber-400">
              <WifiOff className="w-3 h-3" />
              {t("guest.status.offline")}
            </div>
          )}

          {/* Última atualização */}
          {lastRefreshTime && (
            <span className="text-[10px] text-theme-secondary font-mono">
              {lastRefreshTime.toLocaleTimeString(locale)}
            </span>
          )}

          {/* Botão atualizar */}
          <button
            type="button"
            onClick={() => refreshAllServers()}
            disabled={isRefreshing}
            className="p-2 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors disabled:opacity-50 cursor-pointer"
            title={t("guest.refresh")}
          >
            <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
          </button>

          {/* Botão adicionar servidor */}
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="h-11 px-5 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-all text-sm font-bold flex items-center gap-2 shadow-md shadow-theme-shadow active:scale-95 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t("guest.addServer")}
          </button>
        </div>
      </div>

      {/* Aviso de modo offline */}
      {isOfflineMode && knownServers.length > 0 && (
        <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-center gap-3 text-xs">
          <WifiOff className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span>
            {t("guest.offlineBanner")}
          </span>
        </div>
      )}

      {/* Lista de Servidores */}
      {knownServers.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-theme-card rounded-[2rem] border-theme-card shadow-theme-card p-16 text-center space-y-6"
        >
          <div className="w-20 h-20 bg-indigo-100 dark:bg-indigo-900/30 rounded-[2rem] flex items-center justify-center mx-auto">
            <Globe className="w-10 h-10 text-indigo-600" />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-theme-primary">{t("guest.empty.title")}</h3>
            <p className="text-theme-secondary text-sm max-w-md mx-auto leading-relaxed">
              {t("guest.empty.body")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="h-12 px-8 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-all text-sm font-bold flex items-center gap-2 mx-auto shadow-md shadow-theme-shadow active:scale-95 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t("guest.empty.button")}
          </button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {knownServers.map((server, index) => {
            const stale = isServerStale(server, now);
            const mcOnline = server.minecraftStatus === "online";
            const isThisConnected = connectedShortCode === server.shortCode;
            const display = getDisplayStatus(server);
            const isFullyOnline = server.status === "online" && server.minecraftStatus === "online";
            return (
            <motion.div
              key={server.shortCode}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                "rounded-[2rem] border shadow-theme-card overflow-hidden transition-all duration-300 hover:shadow-lg",
                isThisConnected
                  ? "bg-emerald-50/70 dark:bg-emerald-950/20 border-emerald-400 dark:border-emerald-600 ring-2 ring-emerald-400/30"
                  : "bg-theme-card border-theme-card hover:border-indigo-200 dark:hover:border-indigo-800"
              )}
            >
              {/* Topo do card */}
              <div className="p-5 space-y-3">
                {/* Badges */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {/* Status indicator */}
                    <div className={cn(
                      "w-2.5 h-2.5 rounded-full",
                      stale ? "bg-slate-400" : display.color,
                      !stale && isFullyOnline && "animate-pulse"
                    )} />
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      stale ? "text-theme-secondary" : display.textClass
                    )} title={
                      stale ? t("guest.status.staleTitle") :
                      display.labelKey === "guest.status.noMesh" ? t("guest.status.noMeshTitle") :
                      undefined
                    }>
                      {/* Status desatualizado: não sabemos mais se ainda é verdade, então
                          não afirmamos online/offline — só que não está confirmado. */}
                      {stale ? t("guest.status.unconfirmed") : display.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {/* Badge "Meu Servidor" */}
                    {server.isOwnServer && (
                      <span className="text-[9px] font-bold text-indigo-600 uppercase tracking-wider bg-indigo-100 dark:bg-indigo-900/30 px-2 py-0.5 rounded-full">
                        {t("guest.badge.own")}
                      </span>
                    )}
                    {/* Badge de tipo com cor */}
                    <span className={cn(
                      "text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full",
                      server.serverType === "forge" ? "text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30" :
                      server.serverType === "neoforge" ? "text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/30" :
                      server.serverType === "fabric" ? "text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/30" :
                      server.serverType === "paper" ? "text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/30" :
                      "text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/30"
                    )}>
                      {server.serverType}
                    </span>
                  </div>
                </div>

                {/* Nome e descrição */}
                <div className="flex items-center gap-3 min-w-0">
                  <GuestServerAvatar server={server} />
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold text-theme-primary truncate">
                      {server.name}
                    </h3>
                    {server.description && (
                      <p className="text-xs text-theme-secondary mt-0.5 line-clamp-2">
                        {server.description}
                      </p>
                    )}
                  </div>
                </div>

                {/* Metadados */}
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-theme-secondary">
                  <span className="flex items-center gap-1">
                    <Server className="w-3 h-3" />
                    {serverKindLabel(server.serverType)} {server.version}
                  </span>
                  {server.currentPlayers !== undefined && server.minecraftStatus === "online" && (
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {t("guest.players", { current: server.currentPlayers, max: server.maxPlayers })}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {mcOnline && !stale
                      ? t("guest.onlineFor", { time: formatUptime(server.onlineSince) })
                      : formatLastSeen(server.lastSeenOnline, now)}
                  </span>
                </div>

                {(() => {
                  // Endereço de conexão: o app tuneliza a porta local para o servidor
                  // via mesh, então isso resolve pro loopback (127.0.0.1) do próprio
                  // convidado — só passa a rotear de fato depois de clicar em
                  // "Conectar" (ver connectAddressFor em src/lib/connectAddress.ts).
                  const connectAddress = addressFor(server);
                  return isThisConnected ? (
                  // Conectado: em vez de uma div separada abaixo da lista, as informações
                  // de conexão ficam centralizadas dentro do próprio card (que já mudou
                  // de cor para indicar o estado). Preparar o launcher (loader + mods +
                  // abrir o Minecraft) é sempre uma ação explícita à parte — ver botão
                  // "Preparar e Jogar" nas ações do card, nunca dispara sozinho ao conectar.
                  <div className="flex flex-col items-center text-center gap-2.5 py-1">
                    <div className="w-11 h-11 bg-emerald-100 dark:bg-emerald-900/40 rounded-2xl flex items-center justify-center">
                      <Zap className="w-5 h-5 text-emerald-600 fill-current" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
                        {isOnline ? t("guest.connected") : t("guest.connecting")}
                      </h4>
                      <p className="text-[11px] text-theme-secondary mt-0.5 leading-relaxed">
                        {rich("guest.connectAt", { address: <strong className="text-theme-primary font-mono">{connectAddress}</strong> })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(connectAddress)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                    >
                      {copied === connectAddress ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied === connectAddress ? t("guest.copied") : t("guest.copyAddress")}
                    </button>
                  </div>
                  ) : (
                  <div className="flex items-center gap-2 bg-theme-muted rounded-xl px-3 py-2 border border-theme-card">
                    <Globe className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    <span className="font-mono font-bold text-theme-primary text-xs flex-1 truncate">
                      {connectAddress}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(connectAddress)}
                      className="p-1.5 hover:bg-theme-card rounded-lg text-indigo-600 hover:text-indigo-800 dark:hover:text-indigo-400 transition-colors cursor-pointer shrink-0"
                      title={t("guest.copyAddressTitle")}
                    >
                      {copied === connectAddress ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  );
                })()}
              </div>

              {/* Ações do card */}
              <div className="px-5 pb-5 pt-0 flex items-center gap-2">
                {!isThisConnected && !stale && server.status === "online" && !server.isOwnServer && (
                  <button
                    type="button"
                    onClick={() => useConnectionHelp.getState().showForServer({ shortCode: server.shortCode, name: server.name })}
                    title={t("connhelp.openTitle")}
                    aria-label={t("connhelp.open")}
                    className="h-10 w-10 shrink-0 rounded-xl border border-theme-card hover:bg-theme-muted text-theme-secondary hover:text-indigo-500 flex items-center justify-center transition-colors cursor-pointer"
                  >
                    <LifeBuoy className="w-4 h-4" />
                  </button>
                )}
                {isThisConnected ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleDisconnect()}
                      className="h-10 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/30"
                    >
                      <X className="w-3.5 h-3.5" /> {t("guest.disconnect")}
                    </button>
                    {PLAYABLE_SERVER_TYPES.has(server.serverType) && (
                      <button
                        type="button"
                        onClick={() => handlePrepareAndPlay(server)}
                        disabled={prepModalFor === server.shortCode && prepStates[server.shortCode]?.phase !== "error" && prepStates[server.shortCode]?.phase !== "done"}
                        className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-theme-shadow"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" /> {t("guest.prepareAndPlay")}
                      </button>
                    )}
                  </>
                ) : stale ? (
                  // Não conseguimos confirmar o status recentemente com a API Central —
                  // melhor não afirmar "Online" nem "Offline" (nenhuma das duas seria confiável)
                  // e impedir uma tentativa de conexão baseada em dado potencialmente obsoleto.
                  <div className="flex-1 h-10 rounded-xl bg-theme-muted border border-theme-card flex items-center justify-center gap-1.5 text-[10px] font-bold text-theme-secondary">
                    <WifiOff className="w-3 h-3" />
                    {t("guest.status.stale")}
                  </div>
                ) : server.status === "online" ? (
                  server.isOwnServer ? (
                    // Servidor do próprio host: não conecta na própria mesh, mas
                    // já está rodando localmente — oferece "Jogar" em vez de "Conectar".
                    renderOwnPlayButton(server)
                  ) : PLAYABLE_SERVER_TYPES.has(server.serverType) ? (
                    // Um clique conecta e já prepara + abre o Minecraft com o perfil certo
                    // selecionado (ver useEffect que dispara handleOpenLauncher assim que o
                    // túnel sobe). Para Fabric/Forge/NeoForge isso inclui instalar o mod
                    // loader certo, numa instância isolada, se ainda não estiver instalado.
                    <button
                      type="button"
                      onClick={() => handleConnect(server)}
                      disabled={isConnecting}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-theme-shadow"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" /> {t("guest.connect")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleConnect(server)}
                      disabled={isConnecting}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-theme-shadow"
                    >
                      <Zap className="w-3.5 h-3.5 fill-current" /> {t("guest.connect")}
                    </button>
                  )
                ) : server.minecraftStatus === "sleeping" ? (
                  server.isOwnServer ? (
                    <div className="flex-1 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-500">
                      <Zap className="w-3 h-3 text-indigo-400" />
                      {display.label}
                    </div>
                  ) : wakingShortCode === server.shortCode ? (
                    <div className="flex-1 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t("guest.wake.waking")}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleWakeServer(server)}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-theme-shadow"
                    >
                      <Zap className="w-3.5 h-3.5 fill-current" /> {t("guest.wake.button")}
                    </button>
                  )
                ) : server.minecraftStatus === "online" ? (
                  server.isOwnServer ? (
                    // Servidor do próprio host, mesh desligada: joga igual, direto
                    // em 127.0.0.1 — não precisa da mesh pra acessar o próprio processo.
                    renderOwnPlayButton(server)
                  ) : (
                    // Minecraft de pé, mas sem a rede mesh do CubeForge: não dá pra conectar
                    // por aqui — só via IP local (LAN) ou outra VPN que o host esteja usando.
                    <div
                      className="flex-1 h-10 rounded-xl bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-sky-600 dark:text-sky-400"
                      title={t("guest.noMeshTitle")}
                    >
                      <Server className="w-3 h-3" />
                      {t("guest.noMesh")}
                    </div>
                  )
                ) : server.minecraftStatus === "crashed" ? (
                  <div className="flex-1 h-10 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-rose-500">
                    <AlertTriangle className="w-3 h-3" />
                    {t("guest.status.crashed")}
                  </div>
                ) : (
                  <div className="flex-1 h-10 rounded-xl bg-theme-muted border border-theme-card flex items-center justify-center gap-1.5 text-[10px] font-bold text-theme-secondary">
                    <WifiOff className="w-3 h-3" />
                    {t("guest.status.offline")}
                  </div>
                )}

                {/* Botão copiar código */}
                <button
                  type="button"
                  onClick={() => copyToClipboard(`CF-${server.shortCode}`)}
                  className="p-2.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
                  title={t("guest.copyCode")}
                >
                  {copied === `CF-${server.shortCode}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>

                {/* Botão remover */}
                <button
                  type="button"
                  onClick={() => handleRemoveServer(server.shortCode)}
                  className="p-2.5 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl text-theme-secondary hover:text-rose-500 transition-colors cursor-pointer"
                  title={t("guest.remove")}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {wakeError?.shortCode === server.shortCode && (
                <p className="px-5 pb-4 -mt-2 text-[10px] text-rose-500">{wakeError.message}</p>
              )}
            </motion.div>
            );
          })}
        </div>
      )}

      <GuestModals c={c} />
    </div>
  );
}
