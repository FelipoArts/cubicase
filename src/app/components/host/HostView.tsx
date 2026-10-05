"use client";

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Settings,
  Play,
  Copy,
  Check,
  ShieldCheck,
  Activity,
  FolderOpen,
  X,
  Loader2,
  AlertTriangle,
  Database,
  ChevronDown,
  Globe,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { documentDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { remove } from "@tauri-apps/plugin-fs";
import { useAppStore, type ServerStatus } from "@/app/store";
import { pushDiagnostic } from "@/app/diagnostics";
import {
  hostingHeadline,
  type HostingHeadline,
  isGuestActiveError,
  isHostingActive,
  isPrimaryDisabled,
  isStopAction,
  secondsUntilRetry,
  type HostingStatus,
} from "@/lib/hosting";
import {
  listLocalServers,
  listAllServers,
  installMinecraftServer,
  installForgeServer,
  installFabricServer,
  installPaperServer,
  importExistingServer,
  scanExternalServer,
  getJavaVersion,
  startServerOrchestrated,
  updateStoredShortCode,
  type ServerInfo,
  type ServerInstallProgress,
} from "@/lib/server";
import type { ResourceSnapshot } from "@/lib/resourceDiagnostics";
import { getServerSlug, defaultSlugFor, inviteLinkUrl } from "@/lib/inviteLink";
import { installModpack, type ParsedModpack } from "@/lib/modpackImport";
import { ServerConfigModal } from "@/app/ServerConfigModal";
import { ConsolePanel } from "./ConsolePanel";
import { ServerManagePanel } from "./ServerManagePanel";
import { loaderForServerType } from "@/lib/modrinth";
import { reconcilePendingMods } from "@/lib/pendingMods";
import { PlayersPanel } from "./PlayersPanel";
import { ServerList } from "./ServerList";
import { CreateServerModal } from "./CreateServerModal";
import { ImportModpackModal } from "./ImportModpackModal";
import { ImportPackModal } from "./ImportPackModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { SettingsModal } from "./SettingsModal";
import { ConfirmActionModal } from "./ConfirmActionModal";
import { useT, t as tn } from "@/i18n";

// ============================================================
// HostView
// ============================================================
// Painel principal do host. Orquestra todos os subcomponentes.
// Recebe estados e callbacks do page.tsx para preservar estado
// ao alternar entre abas Host/Guest.
// ============================================================

interface HostViewProps {
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

export function HostView({
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
            // Path não é mais acessível — remover da lista persistida
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
        const props = await invoke<Record<string, any>>('read_server_properties', { serverDir: serverInfo.path });
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
                  <p className="text-sm font-bold text-theme-primary mt-1">{(hosting.ip ?? netIp) || t("host.net.inactive")}</p>
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

      {/* Modais */}
      {/* Este app só tem UMA rede por vez: hospedar exige sair do servidor onde está como Convidado. */}
      <ConfirmActionModal
        isOpen={confirmLeaveGuest}
        title={t("host.guestActive.title")}
        message={t("host.guestActive.message")}
        confirmLabel={t("host.guestActive.confirm")}
        onClose={() => setConfirmLeaveGuest(false)}
        onConfirm={async () => {
          setConfirmLeaveGuest(false);
          await handleStartHosting({ localOnly: pendingLocalOnly, leaveGuest: true, skipPendingCheck: true });
        }}
      />

      <ConfirmActionModal
        isOpen={!!pendingModsWarning}
        title={t("pendingMods.startTitle")}
        message={t("pendingMods.startMessage", { count: pendingModsWarning?.count ?? 0 })}
        confirmLabel={t("pendingMods.startConfirm")}
        onClose={() => setPendingModsWarning(null)}
        onConfirm={async () => {
          const opts = pendingModsWarning?.opts ?? {};
          setPendingModsWarning(null);
          await handleStartHosting({ ...opts, skipPendingCheck: true });
        }}
      />

      <CreateServerModal
        isOpen={showCreateServer}
        onClose={() => onSetShowCreateServer(false)}
        onCreate={handleCreateServer}
        installProgress={serverInstallProgress}
        totalRamGb={totalSystemRamGb}
      />

      <ImportModpackModal
        isOpen={showImportModpack}
        onClose={() => setShowImportModpack(false)}
        onImport={handleImportModpack}
        installProgress={serverInstallProgress}
        totalRamGb={totalSystemRamGb}
      />

      <ImportPackModal
        isOpen={showImportPack}
        onClose={() => setShowImportPack(false)}
        existingNames={localServers.map((s) => s.name)}
        onImported={async (name) => {
          const servers = await listLocalServers();
          onSetLocalServers(servers);
          setSelectedServer(name);
        }}
      />

      <DeleteConfirmModal
        serverName={deleteConfirmServer}
        onClose={() => onSetDeleteConfirmServer(null)}
        onConfirm={handleConfirmDelete}
        isImported={deleteConfirmServer ? localServers.some(s => {
          if (s.name !== deleteConfirmServer) return false;
          // Comparar: servidores dentro da pasta padrão não são importados
          const defaultPath = `${serverDir || ''}\\${s.name}`;
          return s.path.toLowerCase() !== defaultPath.toLowerCase();
        }) : false}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => onSetShowSettings(false)}
        currentPort={minecraftPort || 25565}
        onSave={handleSaveSettings}
      />

      <ConfirmActionModal
        isOpen={showRegenerateCode}
        title={t("host.regen.title")}
        message={t("host.regen.message", { code: displayShortCode })}
        confirmLabel={t("host.regen.confirm")}
        onClose={() => setShowRegenerateCode(false)}
        onConfirm={async () => {
          await handleRegenerateCode();
          setShowRegenerateCode(false);
        }}
      />

      <AnimatePresence>
        {showConfigModal && configServerDir && (
          <ServerConfigModal
            serverDir={configServerDir}
            serverName={localServers.find((s) => s.path === configServerDir)?.name ?? ""}
            isImported={importedServerPaths.some((p) => p.toLowerCase() === configServerDir.toLowerCase())}
            existingServerNames={localServers.filter((s) => s.path !== configServerDir).map((s) => s.name)}
            shortCode={localServers.find((s) => s.path === configServerDir)?.shortCode ?? null}
            isOpen={showConfigModal}
            onClose={() => {
              onSetShowConfigModal(false);
              onSetConfigServerDir(null);
            }}
            onSaved={async () => {
              const servers = await listLocalServers();
              onSetLocalServers(servers);
            }}
            onRenamed={async ({ name: newName, path: newPath, backupsMigrationFailed }) => {
              const oldServerInfo = localServers.find((s) => s.path === configServerDir);
              const oldName = oldServerInfo?.name;

              // A pasta física já mudou de lugar (renameServer já rodou) —
              // atualiza a prop que o próprio modal usa antes de qualquer
              // outra coisa, senão a próxima ação nele (ex: salvar
              // propriedades) tentaria ler/escrever num caminho que não
              // existe mais.
              onSetConfigServerDir(newPath);

              // Atualiza a lista local NA HORA (sem esperar o listAllServers
              // no fim) — só pra não deixar o campo de nome do modal piscar
              // vazio no instante entre o rename e o refresh completo mais
              // abaixo (que ainda roda, pra pegar qualquer outra mudança).
              if (oldServerInfo) {
                onSetLocalServers(
                  localServers.map((s) => (s.path === configServerDir ? { ...s, name: newName, path: newPath } : s))
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
            }}
            serverStatus={serverStatus}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// Import necessário para AnimatePresence
import { AnimatePresence } from "framer-motion";
