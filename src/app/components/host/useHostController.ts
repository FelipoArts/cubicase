"use client";

import { useState, useRef, useEffect } from "react";

import { open } from "@tauri-apps/plugin-dialog";
import { documentDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { remove } from "@tauri-apps/plugin-fs";
import { useAppStore, type ServerStatus } from "@/app/store";

import { pushDiagnostic } from "@/app/diagnostics";
import { hostingHeadline, type HostingHeadline, isGuestActiveError, isHostingActive, secondsUntilRetry, type HostingStatus } from "@/lib/hosting";
import { listLocalServers, listAllServers, installMinecraftServer, installForgeServer, installFabricServer, installPaperServer, importExistingServer, scanExternalServer, startServerOrchestrated, updateStoredShortCode, type ServerInfo, type ServerInstallProgress } from "@/lib/server";
import type { ResourceSnapshot } from "@/lib/resourceDiagnostics";
import { getServerSlug, defaultSlugFor } from "@/lib/inviteLink";
import { carryCustomNamesToNewCode } from "@/lib/codeRotation";

import { installModpack, type ParsedModpack } from "@/lib/modpackImport";

import { loaderForServerType } from "@/lib/modrinth";
import { reconcilePendingMods } from "@/lib/pendingMods";

import { useT, t as tn } from "@/i18n";

// ============================================================
// useHostController
// ============================================================
// Toda a lógica do painel do host (hospedagem, servidores locais, criar/importar/excluir, convite...) sem nenhuma
// marcação. A tela atual (HostView) e a nova interface usam o mesmo controlador, então o comportamento é um só.
// ============================================================

export interface HostViewProps {
  netStatus: "offline" | "connecting" | "online";
  // Papel de quem é dono da conexão de rede ativa nesta instalação (só existe
  // UMA por vez — ver active_network_mode no Rust). Sem isso, se a conexão
  // ativa fosse do modo Convidado, este painel mostrava "Parar Rede Mesh"
  // como se fosse a rede DELE, quando na verdade era a do convidado.
  netMode: "host" | "guest" | null;
  netIp: string | null;
  /** Status único da hospedagem (servidor + rede) vindo do backend. */
  hosting: HostingStatus;
  logs: string[];
  mcLogs: string[];
  localServers: ServerInfo[];
  showCreateServer: boolean;
  showSettings: boolean;
  showConfigModal: boolean;
  configServerDir: string | null;
  serverInstallProgress: ServerInstallProgress | null;
  isDeletingServer: string | null;
  deleteConfirmServer: string | null;
  totalSystemRamGb: number;
  serverConfigPort: number;
  shortCode: string;
  resourceSample: ResourceSnapshot | null;

  // Callbacks
  onSetLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  onSetMcLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  onSetLocalServers: (servers: ServerInfo[]) => void;
  onSetShowCreateServer: (v: boolean) => void;
  onSetShowSettings: (v: boolean) => void;
  onSetShowConfigModal: (v: boolean) => void;
  onSetConfigServerDir: (v: string | null) => void;
  onSetServerInstallProgress: (p: ServerInstallProgress | null) => void;
  onSetIsDeletingServer: (v: string | null) => void;
  onSetDeleteConfirmServer: (v: string | null) => void;
  onSetTotalSystemRamGb: (v: number) => void;
  onSetServerConfigPort: (v: number) => void;
  /** Abre as Configurações do app direto na aba "Assinatura" (card Cubicase Plus abaixo). */
  onOpenSubscribe: () => void;
}

export function useHostController({
  netStatus,
  netMode,
  netIp,
  hosting,
  logs,
  mcLogs,
  localServers,
  showCreateServer,
  showSettings,
  showConfigModal,
  configServerDir,
  serverInstallProgress,
  isDeletingServer,
  deleteConfirmServer,
  totalSystemRamGb,
  serverConfigPort,
  shortCode,
  resourceSample,
  onSetLogs,
  onSetMcLogs,
  onSetLocalServers,
  onSetShowCreateServer,
  onSetShowSettings,
  onSetShowConfigModal,
  onSetConfigServerDir,
  onSetServerInstallProgress,
  onSetIsDeletingServer,
  onSetDeleteConfirmServer,
  onSetTotalSystemRamGb,
  onSetServerConfigPort,
  onOpenSubscribe,
}: HostViewProps) {
  const { t, rich } = useT();
  // A conexão de rede ativa (se houver) pertence ao modo Convidado, não a este
  // painel — mostrar "Parar Rede Mesh" aqui seria afirmar que é a rede DESTE
  // host, quando na verdade é a do convidado que está de pé.
  const guestOwnsNetwork = netStatus !== "offline" && netMode === "guest";
  const hostNetOnline = netStatus === "online" && netMode === "host";

  // --- Store ---
  const {
    serverDir,
    setServerDir,
    minecraftPort,
    setMinecraftPort,
    selectedServer,
    setSelectedServer,
    setRunningServer,
    serverStatus,
    setServerStatus,
    onlinePlayers,
    lastCrashInfo,
    importedServerPaths,
    addImportedServerPath,
    removeImportedServerPath,
  } = useAppStore();

  // Espelho de localServers na store (ver comentário em page.tsx: "para o
  // GuestView") — usado só pro badge de wake-on-demand abaixo, pra refletir
  // instantaneamente o toggle feito na aba Assinatura sem depender do próximo
  // refresh da lista local (que é a fonte de verdade normal desta view, via
  // prop `localServers`).
  const runningServerName = useAppStore((s) => s.runningServer);
  const wakeOnDemandServerInfo = useAppStore((s) => s.localServers.find((sv) => sv.name === selectedServer));

  // --- Estado ---
  const [isImporting, setIsImporting] = useState(false);
  const [showCrashDetail, setShowCrashDetail] = useState(false);
  const [showImportModpack, setShowImportModpack] = useState(false);
  // Servidor recém-criado com suporte a mods/plugins: abre o navegador de mods antes da primeira partida.
  const [autoOpenModsFor, setAutoOpenModsFor] = useState<string | null>(null);
  const [showImportPack, setShowImportPack] = useState(false);
  const [showRegenerateCode, setShowRegenerateCode] = useState(false);
  const [idleShutdownWarning, setIdleShutdownWarning] = useState<number | null>(null);
  // Preparação feita aqui antes do start_hosting (instalar Java etc.) e a folga
  // até o primeiro "hosting-status" chegar — ver handleStartHosting.
  const [preparing, setPreparing] = useState(false);
  const [confirmLeaveGuest, setConfirmLeaveGuest] = useState(false);
  // Mods de modpack que o Cubicase não conseguiu baixar (ver lib/pendingMods.ts): avisa antes de iniciar.
  const [pendingModsWarning, setPendingModsWarning] = useState<{ count: number; opts: { localOnly?: boolean; leaveGuest?: boolean } } | null>(null);
  const [pendingLocalOnly, setPendingLocalOnly] = useState(false);
  // Relógio para a contagem "nova tentativa em Ns" (só roda quando há uma agendada).
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Refs para evitar closure stale
  const selectedServerRef = useRef<string | null>(null);
  const localServersRef = useRef<ServerInfo[]>([]);
  const serverShortCodeRef = useRef<string>("");

  // Sincronizar refs
  useEffect(() => { selectedServerRef.current = selectedServer; }, [selectedServer]);
  useEffect(() => { localServersRef.current = localServers; }, [localServers]);

  // Folga entre o retorno do start_hosting e o primeiro status chegar. Guardado
  // numa ref para ser cancelado: um timer de um início anterior não pode soltar
  // o botão no meio da preparação de um início posterior.
  const preparingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPreparingTimer = () => {
    if (preparingTimerRef.current) {
      clearTimeout(preparingTimerRef.current);
      preparingTimerRef.current = null;
    }
  };
  useEffect(() => clearPreparingTimer, []);

  // O status da hospedagem chegou: a "preparação" acabou. Só a FASE conta — um
  // `hosting.error` pode ser de uma tentativa ANTERIOR ainda no estado do React e
  // soltaria o botão no mesmo render em que se clica Iniciar. Falha ao subir o
  // Minecraft (fase idle + erro) é coberta pelo timer de folga.
  useEffect(() => {
    if (preparing && isHostingActive(hosting.phase)) {
      clearPreparingTimer();
      setPreparing(false);
    }
  }, [preparing, hosting.phase]);

  useEffect(() => {
    if (hosting.netRetryAtMs == null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hosting.netRetryAtMs]);

  // Aviso de desligamento por inatividade (wake-on-demand) — emitido pelo Rust
  // um tick (60s) antes de desligar de verdade (ver idle-shutdown-warning em
  // lib.rs). "Manter ligado" reseta o contador no Rust; aqui só fecha o aviso.
  useEffect(() => {
    const unlisten = listen<{ secondsRemaining: number }>("idle-shutdown-warning", (event) => {
      setIdleShutdownWarning(event.payload.secondsRemaining);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const networkPath = useAppStore((s) => s.networkPath);

  // A API não confirmou o dono do código antigo e o app emitiu um código novo
  // (ver ensure_server_ownership no Rust): reflete na lista e avisa o usuário.
  useEffect(() => {
    const unlisten = listen<{ serverDir: string; oldCode: string; newCode: string }>("server-code-rotated", (event) => {
      const { serverDir, newCode } = event.payload;
      onSetLocalServers(localServers.map((s) => (s.path === serverDir ? { ...s, shortCode: newCode } : s)));
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("host.codeRotated.title"), message: tn("host.codeRotated.message", { code: newCode }) });
      // Link de convite / endereço personalizados (Plus) iam parar de funcionar: leva junto.
      void carryCustomNamesToNewCode(event.payload.oldCode, newCode).then((r) => {
        if (!r.hadCustomNames) return;
        pushDiagnostic(r.failed
          ? { level: "warning", source: tn("diag.source.server"), title: tn("host.codeRotated.customFailed.title"), message: tn("host.codeRotated.customFailed.message") }
          : { level: "info", source: tn("diag.source.server"), title: tn("host.codeRotated.customMoved.title"), message: tn("host.codeRotated.customMoved.message") });
      });
    });
    return () => { unlisten.then((f) => f()); };
  }, [localServers, onSetLocalServers]);

  const handleCancelIdleShutdown = async () => {
    setIdleShutdownWarning(null);
    try {
      await invoke("cancel_idle_shutdown");
    } catch (err) {
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("host.err.cancelShutdown"), message: String(err) });
    }
  };

  // Contagem local só visual (o desligamento de verdade é decidido pelo
  // Rust); some sozinho ao chegar em 0 ou se um jogador aparecer nesse meio
  // tempo (o Rust também vai zerar o próprio contador no próximo tick).
  useEffect(() => {
    if (idleShutdownWarning === null) return;
    if (onlinePlayers.length > 0) { setIdleShutdownWarning(null); return; }
    if (idleShutdownWarning <= 0) { setIdleShutdownWarning(null); return; }
    const timer = setTimeout(() => setIdleShutdownWarning((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [idleShutdownWarning, onlinePlayers.length]);

  // --- Efeitos ---

  // Inicializar diretório padrão
  useEffect(() => {
    (async () => {
      if (!serverDir) {
        const docs = await documentDir();
        setServerDir(`${docs}\\CubicaseServers`);
      }
    })();
  }, [serverDir, setServerDir]);

  // Carregar servidores (locais + importados) e RAM total
  useEffect(() => {
    (async () => {
      try {
        // 1. Servidores padrão (pasta CubicaseServers)
        const defaultServers = await listLocalServers();

        // 2. Servidores importados (paths salvos no store)
        const importedResults: ServerInfo[] = [];
        const validImportedPaths: string[] = [];
        for (const path of importedServerPaths) {
          try {
            const scanned = await scanExternalServer(path);
            if (scanned) {
              importedResults.push(scanned);
              validImportedPaths.push(path);
            }
          } catch (err) {
            console.warn(`Erro ao escanear servidor importado em ${path}:`, err);
            // Erro de leitura (permissão, disco ocupado...) NÃO prova que a pasta sumiu: mantém na lista.
            // Só some quando a pasta realmente não existe mais (o scan devolve null).
            validImportedPaths.push(path);
          }
        }

        // Limpar paths de servidores importados que não existem mais (ex: deletados manualmente)
        if (validImportedPaths.length !== importedServerPaths.length) {
          const toRemove = importedServerPaths.filter(p => !validImportedPaths.includes(p));
          for (const p of toRemove) {
            removeImportedServerPath(p);
          }
        }

        // 3. Merge: servidores importados não duplicam os padrão
        const allServerPaths = new Set(defaultServers.map(s => s.path.toLowerCase()));
        for (const imp of importedResults) {
          if (!allServerPaths.has(imp.path.toLowerCase())) {
            defaultServers.push(imp);
            allServerPaths.add(imp.path.toLowerCase());
          }
        }

        onSetLocalServers(defaultServers);

        // 4. Se o servidor selecionado não existe mais, resetar seleção
        if (selectedServer && !defaultServers.some(s => s.name === selectedServer)) {
          setSelectedServer(null);
        }
        const totalBytes = await invoke<number>("get_total_memory");
        const totalGb = Math.round(totalBytes / (1024 * 1024 * 1024));
        onSetTotalSystemRamGb(totalGb);
      } catch (err) {
        console.error("Erro ao carregar dados iniciais:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recarregar servidores se a pasta mudar
  useEffect(() => {
    if (!serverDir) return;
    (async () => {
      try {
        const servers = await listLocalServers();
        onSetLocalServers(servers);
      } catch (err) {
        console.error("Erro ao atualizar servidores:", err);
      }
    })();
  }, [serverDir]);

  // Ler porta real do server.properties
  useEffect(() => {
    if (!selectedServer) return;
    const serverInfo = localServers.find(s => s.name === selectedServer);
    if (!serverInfo) return;
    (async () => {
      try {
        const props = await invoke<Record<string, string>>('read_server_properties', { serverDir: serverInfo.path });
        onSetServerConfigPort(Number(props['server-port'] ?? 25565));
      } catch {
        onSetServerConfigPort(25565);
      }
    })();
  }, [selectedServer, localServers]);

  // --- Handlers ---

  // --- Hospedagem unificada ---
  // Um único botão liga o Minecraft e a rede mesh juntos (start_hosting no
  // backend, ver src-tauri/src/hosting.rs). A rede é detalhe de implementação:
  // só aparece para o usuário quando FALHA — e aí o servidor segue de pé só
  // neste computador, com um aviso claro e um botão para tentar de novo.

  const handleStartHosting = async (opts: { localOnly?: boolean; leaveGuest?: boolean; skipPendingCheck?: boolean } = {}) => {
    const currentSelectedServer = selectedServerRef.current || selectedServer;
    const currentLocalServers = localServersRef.current.length > 0 ? localServersRef.current : localServers;

    if (!currentSelectedServer) {
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("host.err.noServer.title"), message: tn("host.err.noServer.message") });
      return;
    }
    const info = currentLocalServers.find(s => s.name === currentSelectedServer);
    if (!info) {
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("host.err.notFound.title"), message: tn("host.err.notFound.message") });
      return;
    }

    // Mods do modpack que ficaram bloqueados em todas as fontes: avisa antes de iniciar (não impede).
    if (!opts.skipPendingCheck) {
      const pending = await reconcilePendingMods(info.path).catch(() => []);
      if (pending.length > 0) {
        setPendingModsWarning({ count: pending.length, opts: { localOnly: opts.localOnly, leaveGuest: opts.leaveGuest } });
        return;
      }
    }

    // Convidado de outro servidor: só existe UMA rede por instalação. Pergunta
    // ANTES de baixar Java/preparar qualquer coisa, e nunca derruba a conexão
    // do convidado sem o usuário confirmar.
    if (guestOwnsNetwork && !opts.leaveGuest) {
      setPendingLocalOnly(!!opts.localOnly);
      setConfirmLeaveGuest(true);
      return;
    }

    clearPreparingTimer();
    setPreparing(true);
    try {
      setRunningServer(info.name);
      onSetLogs([]);
      onSetMcLogs([]);
      onSetMcLogs(prev => [...prev, tn("app.mc.preparing", { name: info.name })]);
      if (!info.shortCode && !opts.localOnly) {
        onSetMcLogs(prev => [...prev, tn("host.log.noCodeLocalOnly")]);
      }

      await startServerOrchestrated(
        info,
        {
          onLog: (line) => onSetMcLogs(prev => [...prev, `[Cubicase] ${line}`]),
          onInstallProgress: onSetServerInstallProgress,
        },
        opts,
      );
      // `preparing` só cai quando o status da hospedagem chega (efeito abaixo) —
      // sem isso o botão piscaria "Iniciar" entre o retorno do comando e o evento.
      preparingTimerRef.current = setTimeout(() => setPreparing(false), 4000);
    } catch (err) {
      onSetServerInstallProgress(null);
      clearPreparingTimer();
      setPreparing(false);
      if (isGuestActiveError(err)) {
        // Corrida: o convidado conectou entre o clique e o start.
        setPendingLocalOnly(!!opts.localOnly);
        setConfirmLeaveGuest(true);
        return;
      }
      console.error(err);
      setServerStatus("offline");
      onSetMcLogs(prev => [...prev, tn("host.mc.startFailed", { error: String(err) })]);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("host.err.startServer"), message: String(err) });
    }
  };

  const handleStopHosting = async () => {
    try {
      onSetMcLogs(prev => [...prev, tn("host.mc.stopping")]);
      await invoke("stop_hosting");
      // Com o modo de espera (Plus) ligado, parar à mão PAUSA a espera: avisa na
      // hora, senão o usuário fica sem entender por que ninguém consegue acordar
      // o servidor depois.
      if (wakeOnDemandServerInfo?.wakeOnDemandEnabled) {
        pushDiagnostic({ level: "info", source: tn("diag.source.server"), title: tn("host.standby.pausedToast.title"), message: tn("host.standby.pausedToast.message") });
      }
    } catch (err) {
      console.error(err);
      onSetMcLogs(prev => [...prev, tn("host.mc.stopFailed", { error: String(err) })]);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("host.err.stopServer"), message: String(err) });
      // Um comando que falha (IPC, panic no backend) não pode deixar o status
      // preso em "stopping" — consulta o estado real em vez de chutar "offline"
      // (o servidor pode muito bem ainda estar rodando).
      try {
        const status = await invoke<{ minecraftStatus: ServerStatus }>("get_system_status");
        setServerStatus(status.minecraftStatus);
      } catch (statusErr) {
        console.error("Falha ao verificar estado real do servidor após erro no stop:", statusErr);
        setServerStatus("offline");
      }
    }
  };

  // "Voltar à espera": reativa o wake-on-demand depois de uma parada manual.
  const handleResumeStandby = async () => {
    try {
      await invoke("resume_wake_standby");
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("host.err.resumeStandby"), message: String(err) });
    }
  };

  // "Tentar de novo" / "Abrir para amigos": retoma a rede sem reiniciar o Minecraft.
  const handleRetryNetwork = async () => {
    try {
      await invoke("retry_hosting_network");
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.network"), title: tn("host.err.retryNetwork"), message: String(err) });
    }
  };

  const handleSendMCCommand = async (command: string) => {
    try {
      onSetMcLogs(prev => [...prev, `> ${command}`]);
      await invoke("send_minecraft_command", { command });
    } catch (err) {
      console.error(err);
      onSetMcLogs(prev => [...prev, tn("host.mc.commandFailed", { error: String(err) })]);
    }
  };

  const handleSelectDir = async () => {
    const selected = await open({
      directory: true,
      recursive: true,
      multiple: false,
      defaultPath: serverDir || undefined,
    });
    if (selected) setServerDir(selected as string);
  };

  // Guarda o TEXTO copiado (não um booleano solto) pra só o botão que copiou
  // aquele conteúdo específico mostrar o ícone de check — com um booleano
  // único, clicar em "Copiar link" também "marcava" o botão de copiar o
  // código CF-XXXXXX (e vice-versa), mesmo os dois copiando coisas diferentes.
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText((current) => (current === text ? null : current)), 2000);
  };

  const handleCreateServer = async (name: string, version: string, ram: number, serverType?: "vanilla" | "forge" | "neoforge" | "fabric" | "paper", extraVersion?: string, seed?: string) => {
    if (localServers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      pushDiagnostic({ level: "warning", source: tn("diag.source.install"), title: tn("host.err.nameInUse.title"), message: tn("host.err.nameInUse.message", { name }) });
      return;
    }
    try {
      if ((serverType === "forge" || serverType === "neoforge") && extraVersion) {
        onSetServerInstallProgress({ status: tn("host.install.starting", { loader: "Forge" }), percent: 5 });
        await installForgeServer(name, version, extraVersion, serverType, ram, seed, (p: ServerInstallProgress) => onSetServerInstallProgress(p));
      } else if (serverType === "fabric" && extraVersion) {
        onSetServerInstallProgress({ status: tn("host.install.starting", { loader: "Fabric" }), percent: 5 });
        await installFabricServer(name, version, extraVersion, ram, seed, (p: ServerInstallProgress) => onSetServerInstallProgress(p));
      } else if (serverType === "paper" && extraVersion) {
        onSetServerInstallProgress({ status: tn("host.install.starting", { loader: "Paper" }), percent: 5 });
        await installPaperServer(name, version, Number(extraVersion), ram, seed, (p: ServerInstallProgress) => onSetServerInstallProgress(p));
      } else {
        onSetServerInstallProgress({ status: tn("host.install.mojang"), percent: 5 });
        await installMinecraftServer(name, version, ram, seed, (p) => onSetServerInstallProgress(p));
      }
      const servers = await listLocalServers();
      onSetLocalServers(servers);
      setSelectedServer(name);
      // Mods de geração de terreno, por exemplo, precisam estar instalados ANTES da primeira
      // partida para o mundo já nascer com eles — então oferecemos os mods logo ao criar.
      if (serverType && loaderForServerType(serverType)) setAutoOpenModsFor(name);
      onSetShowCreateServer(false);
      onSetServerInstallProgress(null);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.install"), title: tn("host.err.createServer"), message: String(err) });
      onSetServerInstallProgress(null);
    }
  };

  const handleImportModpack = async (name: string, parsed: ParsedModpack, ram: number) => {
    if (localServers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      pushDiagnostic({ level: "warning", source: tn("diag.source.install"), title: tn("host.err.nameInUse.title"), message: tn("host.err.nameInUse.message", { name }) });
      return;
    }
    try {
      onSetServerInstallProgress({ status: tn("host.install.modpack"), percent: 2 });
      await installModpack(name, parsed, ram, (p) => onSetServerInstallProgress(p));
      const servers = await listLocalServers();
      onSetLocalServers(servers);
      setSelectedServer(name);
      setShowImportModpack(false);
      onSetServerInstallProgress(null);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.install"), title: tn("host.err.importModpack"), message: String(err) });
      onSetServerInstallProgress(null);
    }
  };

  const handleDeleteServer = async (serverName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (serverStatus !== "offline" && serverStatus !== "crashed" && selectedServer === serverName) {
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("serverList.running.title"), message: tn("host.err.deleteRunning") });
      return;
    }
    onSetDeleteConfirmServer(serverName);
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmServer) return;
    try {
      onSetIsDeletingServer(deleteConfirmServer);
      const serverInfo = localServers.find(s => s.name === deleteConfirmServer);
      if (!serverInfo) throw new Error(tn("host.err.notFound.title"));

      // Verificar se é um servidor importado (fora da pasta padrão)
      const docsDir = await documentDir();
      const defaultPath = `${docsDir}\\CubicaseServers\\${deleteConfirmServer}`;
      const isImported = serverInfo.path.toLowerCase() !== defaultPath.toLowerCase();

      if (isImported) {
        // Servidor importado: remover da lista de importados (não deleta arquivos)
        onSetLogs(prev => [...prev, `[INFO] Removendo servidor importado "${deleteConfirmServer}" da lista.`]);
        removeImportedServerPath(serverInfo.path);
      } else {
        // Servidor padrão: deletar a pasta permanentemente
        await remove(serverInfo.path, { recursive: true });
        onSetLogs(prev => [...prev, tn("host.log.deleted", { name: deleteConfirmServer })]);
      }

      // Remover também da API Central: sem isso o servidor deletado localmente
      // continuava aparecendo como existente (e potencialmente "online") para os convidados.
      if (serverInfo.shortCode) {
        try {
          await invoke("sync_delete_server", { shortCode: serverInfo.shortCode });
          onSetLogs(prev => [...prev, tn("host.log.removedCentral")]);
        } catch (err) {
          console.warn("Falha ao remover servidor da API Central:", err);
          onSetLogs(prev => [...prev, tn("host.log.removeCentralFailed")]);
        }
      }

      if (selectedServer === deleteConfirmServer) setSelectedServer(null);
      const servers = await listLocalServers();
      onSetLocalServers(servers);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("host.err.deleteServer"), message: String(err) });
    } finally {
      onSetIsDeletingServer(null);
      onSetDeleteConfirmServer(null);
    }
  };

  const handleImportServer = async () => {
    try {
      setIsImporting(true);
      const selected = await open({
        directory: true,
        recursive: true, // libera o conteúdo da pasta para o app ler/gravar (escopo do plugin fs)
        multiple: false,
        title: "Selecione a pasta do servidor Minecraft",
      });
      if (!selected) { setIsImporting(false); return; }

      const folderPath = selected as string;

      // Verificar se já não está na lista (pela path)
      const alreadyExists = localServers.some(s => s.path.toLowerCase() === folderPath.toLowerCase());
      if (alreadyExists) {
        pushDiagnostic({ level: "warning", source: tn("diag.source.install"), title: tn("host.err.alreadyImported.title"), message: tn("host.err.alreadyImported.message") });
        setIsImporting(false);
        return;
      }

      onSetLogs(prev => [...prev, `[INFO] Importando servidor de: ${folderPath}`]);
      const imported = await importExistingServer(folderPath);
      addImportedServerPath(folderPath);

      // Merge com servidores locais e reordenar
      const allServers = [...localServers, imported];
      onSetLocalServers(allServers);
      setSelectedServer(imported.name);
      onSetLogs(prev => [...prev, tn("host.log.imported", { name: imported.name, version: imported.version || tn("host.unknownVersion") })]);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.install"), title: tn("host.err.importServer"), message: String(err) });
    } finally {
      setIsImporting(false);
    }
  };

  const handleSaveSettings = (port: number) => {
    setMinecraftPort(port);
    onSetShowSettings(false);
  };

  // Invalida o código atual na API Central e gera um novo (ex.: o código
  // vazou publicamente). Derruba, de propósito, qualquer sessão de rede presa
  // ao código antigo — inclusive a própria, se este servidor estiver
  // hospedando agora — por isso o botão fica desabilitado enquanto online
  // (ver condição no JSX abaixo), evitando o susto de cair a própria sessão
  // sem querer no meio do jogo.
  const handleRegenerateCode = async () => {
    const info = selectedServer ? localServers.find(s => s.name === selectedServer) : null;
    if (!info?.shortCode) return;
    try {
      const result = await invoke<{ shortCode: string }>("regenerate_server_code", { shortCode: info.shortCode });
      await updateStoredShortCode(info.path, result.shortCode);
      onSetLocalServers(localServers.map(s => s.name === info.name ? { ...s, shortCode: result.shortCode } : s));
      pushDiagnostic({ level: "info", source: tn("diag.source.server"), title: tn("host.regen.done.title"), message: tn("host.regen.done.message", { code: result.shortCode }) });
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("host.err.regen"), message: String(err) });
    }
  };

  // --- Render ---

  const serverInfo = selectedServer ? localServers.find(s => s.name === selectedServer) : null;
  const displayShortCode = serverInfo?.shortCode || serverShortCodeRef.current || shortCode;

  // Status único mostrado ao usuário (nunca "mesh"): ver src/lib/hosting.ts.
  const headline = hostingHeadline({ status: hosting, preparing, mcStatus: serverStatus, hostNetOnline });
  const sessionActive = isHostingActive(hosting.phase);
  const retryInSecs = secondsUntilRetry(hosting, nowMs);
  const friendsOnline = headline === "onlineFriends";
  const friendsHint: Record<HostingHeadline, string> = {
    idle: t("host.friends.hint.idle"),
    crashed: t("host.friends.hint.idle"),
    preparing: t("host.friends.hint.starting"),
    starting: t("host.friends.hint.starting"),
    connecting: t("host.friends.hint.connecting"),
    onlineFriends: "",
    localOnlyChoice: t("host.friends.hint.local"),
    localOnlyFailed: t("host.friends.hint.local"),
    stopping: t("host.friends.hint.idle"),
  };

  // Link de convite (play.cubicase.net/<slug>) — todo servidor já tem um de
  // graça (o próprio código em minúsculas, ver defaultSlugFor); só busca na
  // API Central se existe um personalizado (Cubicase Plus, editável no modal
  // de configuração do servidor — ver ServerConfigModal). Enquanto a busca
  // não volta, mostra o padrão direto: nunca precisa de tela de carregando.
  //
  // Também refaz a busca quando showConfigModal muda (abre OU fecha) — é
  // assim que um slug salvo/removido dentro do ServerConfigModal aparece
  // aqui na hora, sem precisar de F5: o modal não avisa este componente
  // diretamente, então reagir ao fechamento é o gatilho mais simples pra
  // buscar de novo o valor que acabou de ser salvo na API Central.
  const [customInviteSlug, setCustomInviteSlug] = useState<string | null>(null);
  useEffect(() => {
    setCustomInviteSlug(null);
    if (!displayShortCode) return;
    let cancelled = false;
    getServerSlug(displayShortCode).then((slug) => { if (!cancelled) setCustomInviteSlug(slug); });
    return () => { cancelled = true; };
  }, [displayShortCode, showConfigModal]);
  const inviteSlug = customInviteSlug ?? (displayShortCode ? defaultSlugFor(displayShortCode) : null);

  const serverTypeLabels: Record<string, string> = {
    vanilla: "Vanilla",
    forge: "Forge",
    neoforge: "NeoForge",
    fabric: "Fabric",
    paper: "Paper",
  };
  const serverTypeLabel = serverTypeLabels[serverInfo?.serverType ?? "vanilla"] ?? "Vanilla";

  // A versão/loader/jar mudaram no cubicase-meta.json (atualização de versão): relê a lista e avisa a API Central
  // (melhor esforço). Usado pela nova interface; a tela atual faz o mesmo inline.
  const handleServerUpgraded = async (serverPath: string) => {
    try {
      const servers = await listAllServers(importedServerPaths);
      onSetLocalServers(servers);
      const updated = servers.find((s) => s.path === serverPath);
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
  };

  // Servidor renomeado pelo editor de configurações (modal ou aba). `oldPath` = pasta antes do rename. A pasta física já
  // mudou de lugar; aqui o app atualiza lista, seleção, histórico do console e a API Central.
  const handleServerRenamed = async (oldPath: string, { name: newName, path: newPath, backupsMigrationFailed }: { name: string; path: string; backupsMigrationFailed: boolean }) => {
        const oldServerInfo = localServers.find((s) => s.path === oldPath);
        const oldName = oldServerInfo?.name;

        // A pasta física já mudou de lugar (renameServer já rodou) —
        // atualiza a prop que o próprio modal usa antes de qualquer
        // outra coisa, senão a próxima ação nele (ex: salvar
        // propriedades) tentaria ler/escrever num caminho que não
        // existe mais.
        if (configServerDir === oldPath) onSetConfigServerDir(newPath);

        // Atualiza a lista local NA HORA (sem esperar o listAllServers
        // no fim) — só pra não deixar o campo de nome do modal piscar
        // vazio no instante entre o rename e o refresh completo mais
        // abaixo (que ainda roda, pra pegar qualquer outra mudança).
        if (oldServerInfo) {
          onSetLocalServers(
            localServers.map((s) => (s.path === oldPath ? { ...s, name: newName, path: newPath } : s))
          );
        }

        const store = useAppStore.getState();
        if (oldName && oldName !== newName) {
          // Console (histórico de log) segue o servidor pro nome novo
          // em vez de ficar órfão com o nome antigo (mesma preocupação
          // do achado de pré-lançamento sobre logs vazando entre
          // servidores de mesmo nome — aqui é o oposto: preservar, não
          // vazar).
          store.renameMcLogs(oldName, newName);
          if (selectedServer === oldName) setSelectedServer(newName);
          if (store.runningServer === oldName) setRunningServer(newName);
        }

        if (backupsMigrationFailed) {
          pushDiagnostic({
            level: "warning",
            source: tn("diag.source.server"),
            title: tn("config.name.title"),
            message: tn("config.name.backupsMigrationWarning", { oldName: oldName ?? "", newName }),
          });
        }

        // Sincroniza com a API Central, se este servidor já tiver sido
        // registrado lá — usa sync_register_server (não só
        // sync_update_server) de propósito: além de atualizar o nome
        // lá (idempotente por shortCode desde a correção do Worker),
        // também refaz `active_short_code`/`active_server_dir` no
        // AppState do Rust com o caminho NOVO. Sem isso, se a rede
        // mesh deste host continuasse de pé com o Minecraft só parado
        // (são ciclos de vida independentes — nada impede renomear
        // nesse estado), "GET /mods" pra um convidado continuaria
        // servindo a pasta antiga (ou falhando) até o próximo registro
        // manual — o que podia nunca acontecer de novo na mesma sessão,
        // já que o registro normal é deduplicado por shortCode.
        // Best-effort: se falhar, o rename local já valeu mesmo assim.
        if (oldServerInfo?.shortCode) {
          try {
            await invoke("sync_register_server", {
              name: newName,
              version: oldServerInfo.version || "1.20.1",
              serverType: oldServerInfo.serverType || "vanilla",
              description: oldServerInfo.description || "",
              shortCode: oldServerInfo.shortCode,
              owner: null,
              forgeVersion: oldServerInfo.forgeVersion ?? null,
              modLoaderVersion: oldServerInfo.modLoaderVersion ?? null,
              serverDir: newPath,
            });
          } catch (err) {
            console.warn("Falha ao sincronizar nome com a API Central:", err);
          }
        }

        const servers = await listAllServers(importedServerPaths);
        onSetLocalServers(servers);
  };

  // Propriedades salvas: relê a lista de servidores.
  const handleConfigSaved = async () => {
    const servers = await listLocalServers();
    onSetLocalServers(servers);
  };

  return {
    handleServerRenamed,
    handleConfigSaved,
    handleServerUpgraded,
    t,
    rich,
    guestOwnsNetwork,
    hostNetOnline,
    serverDir,
    setServerDir,
    minecraftPort,
    setMinecraftPort,
    selectedServer,
    setSelectedServer,
    setRunningServer,
    serverStatus,
    setServerStatus,
    onlinePlayers,
    lastCrashInfo,
    importedServerPaths,
    addImportedServerPath,
    removeImportedServerPath,
    runningServerName,
    wakeOnDemandServerInfo,
    isImporting,
    setIsImporting,
    showCrashDetail,
    setShowCrashDetail,
    showImportModpack,
    setShowImportModpack,
    autoOpenModsFor,
    setAutoOpenModsFor,
    showImportPack,
    setShowImportPack,
    showRegenerateCode,
    setShowRegenerateCode,
    idleShutdownWarning,
    setIdleShutdownWarning,
    preparing,
    setPreparing,
    confirmLeaveGuest,
    setConfirmLeaveGuest,
    pendingModsWarning,
    setPendingModsWarning,
    pendingLocalOnly,
    setPendingLocalOnly,
    nowMs,
    setNowMs,
    selectedServerRef,
    localServersRef,
    serverShortCodeRef,
    preparingTimerRef,
    clearPreparingTimer,
    networkPath,
    handleCancelIdleShutdown,
    handleStartHosting,
    handleStopHosting,
    handleResumeStandby,
    handleRetryNetwork,
    handleSendMCCommand,
    handleSelectDir,
    copiedText,
    setCopiedText,
    copyToClipboard,
    handleCreateServer,
    handleImportModpack,
    handleDeleteServer,
    handleConfirmDelete,
    handleImportServer,
    handleSaveSettings,
    handleRegenerateCode,
    serverInfo,
    displayShortCode,
    headline,
    sessionActive,
    retryInSecs,
    friendsOnline,
    friendsHint,
    customInviteSlug,
    setCustomInviteSlug,
    inviteSlug,
    serverTypeLabels,
    serverTypeLabel,
    netStatus,
    netMode,
    netIp,
    hosting,
    logs,
    mcLogs,
    localServers,
    showCreateServer,
    showSettings,
    showConfigModal,
    configServerDir,
    serverInstallProgress,
    isDeletingServer,
    deleteConfirmServer,
    totalSystemRamGb,
    serverConfigPort,
    shortCode,
    resourceSample,
    onSetLogs,
    onSetMcLogs,
    onSetLocalServers,
    onSetShowCreateServer,
    onSetShowSettings,
    onSetShowConfigModal,
    onSetConfigServerDir,
    onSetServerInstallProgress,
    onSetIsDeletingServer,
    onSetDeleteConfirmServer,
    onSetTotalSystemRamGb,
    onSetServerConfigPort,
    onOpenSubscribe,
  };
}

export type HostController = ReturnType<typeof useHostController>;
