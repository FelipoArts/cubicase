"use client";

import { noteServerIconHash } from "@/lib/guestServerIcon";
import { POLL_INTERVAL_MS, REFRESH_ON_RETURN_MS, shouldPoll } from "@/lib/guestPolling";
import { useState, useEffect, useCallback, useRef } from "react";

import { Zap, Play } from "lucide-react";

import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { join } from "@tauri-apps/api/path";
import { useAppStore, type KnownServer, type ServerStatus } from "@/app/store";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { pushDiagnostic } from "@/app/diagnostics";
import { installFabricClient, installForgeClient, getInstanceDir, getLocalServerPort, findInstalledFabricVersion, findInstalledForgeVersion } from "@/lib/clientSetup";

import { planModSync, runModSync, planLocalModSync, runLocalModSync, INITIAL_PREP_STATE, type PrepState } from "@/lib/modSync";
import { connectAddressFor } from "@/lib/connectAddress";

import { useT, t as tn, getLocale, type TKey } from "@/i18n";

// ============================================================
// useGuestController
// ============================================================
// Toda a lógica da biblioteca do Convidado (servidores conhecidos, status, conectar, preparar e jogar, acordar...)
// sem a marcação. A tela atual (GuestView) e a nova interface usam o mesmo controlador.
// ============================================================

/** Tipos de servidor cobertos pelo fluxo "Jogar" (abrir o launcher já pronto). */
export const PLAYABLE_SERVER_TYPES = new Set(["vanilla", "paper", "fabric", "forge", "neoforge"]);

/** Loaders que precisam de instância isolada (mods/config/saves fora do .minecraft/mods compartilhado). */
const ISOLATED_SERVER_TYPES = new Set(["fabric", "forge", "neoforge"]);
const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

export interface GuestViewProps {
  netStatus: "offline" | "connecting" | "online";
  minecraftPort: number;
  onConnect: (inviteCode: string) => void;
  onDisconnect: () => void;
}

export function useGuestController({
  netStatus,
  minecraftPort,
  onConnect,
  onDisconnect,
}: GuestViewProps) {
  const { t, rich, locale } = useT();
  const {
    knownServers,
    addKnownServer,
    removeKnownServer,
    updateKnownServerStatus,
    localServers,
    guestConnectedShortCode: connectedShortCode,
    setGuestConnectedShortCode: setConnectedShortCode,
    radminRoute,
    pendingJoinShortCode,
    setPendingJoinShortCode,
  } = useAppStore();

  /** O que o jogador digita no Minecraft para este servidor: o IP do host (Radmin) ou o endereço do túnel P2P. */
  const addressFor = (server: KnownServer): string =>
    radminRoute && radminRoute.shortCode === server.shortCode ? radminRoute.address : connectAddressFor(server, minecraftPort);

  const [showAddModal, setShowAddModal] = useState(false);
  useLockBodyScroll(showAddModal);
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Wake-on-demand: shortCode do servidor que estamos tentando acordar agora
  // (null = nenhum) + erro por shortCode, pra não confundir cards diferentes.
  const [wakingShortCode, setWakingShortCode] = useState<string | null>(null);
  const [wakeError, setWakeError] = useState<{ shortCode: string; message: string } | null>(null);
  // Contador de tempo online é calculado localmente (a partir de onlineSince) e
  // precisa de um "tick" próprio para atualizar a UI a cada segundo, já que o
  // polling da API Central acontece só a cada 30s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // connectedShortCode é persistido (ver store.ts) para sobreviver a F5/reabertura
  // do app — só é limpo quando a rede mesh cai de verdade, o usuário desconecta
  // manualmente, ou a tentativa de conexão falha (todos tratados em page.tsx, que
  // é quem recebe o evento real "network-status" e o resultado de handleGuestConnect).

  // Fluxo "Preparar e Jogar" (instala o mod loader se precisar, sincroniza os
  // mods com o que o host tem agora, e só então deixa abrir o Minecraft
  // Launcher já com o perfil certo selecionado) — sempre uma ação explícita
  // do jogador (botão próprio, nunca dispara sozinho ao conectar: era
  // exatamente esse auto-disparo que fazia o Explorer "abrir do nada" quando
  // a ativação do launcher via shell:AppsFolder falhava em silêncio pra quem
  // não tem a versão da Microsoft Store instalada).
  //
  // `prepStates` guarda o progresso/relatório por shortCode (sobrevive ao
  // fechamento do modal, então reabrir mostra o último resultado); `prepModalFor`
  // é qual servidor está com o modal aberto agora (null = nenhum).
  const [prepModalFor, setPrepModalFor] = useState<string | null>(null);
  const [prepStates, setPrepStates] = useState<Record<string, PrepState>>({});

  const loaderLabel = (serverType: string): string =>
    serverType === "neoforge" ? "NeoForge" : serverType === "forge" ? "Forge" : "Fabric";

  /** Nome de exibição do tipo de servidor para o textinho "tipo + versão" do card — ao
   * contrário de loaderLabel (só usado pra forge/neoforge/fabric em mensagens de erro),
   * esta cobre todos os tipos, incluindo vanilla/paper. */
  const serverKindLabel = (serverType: string): string =>
    serverType === "neoforge" ? "NeoForge" :
    serverType === "forge" ? "Forge" :
    serverType === "fabric" ? "Fabric" :
    serverType === "paper" ? "Paper" :
    "Vanilla";

  /** Pasta local (ServerInfo) do servidor do próprio host, se este KnownServer for "Meu" — usado pelo fluxo "Jogar" local (sem mesh). */
  const getLocalServerInfo = (shortCode: string) => localServers.find(s => s.shortCode === shortCode) ?? null;

  const patchPrepState = (shortCode: string, patch: Partial<PrepState>) => {
    setPrepStates(prev => ({ ...prev, [shortCode]: { ...(prev[shortCode] ?? INITIAL_PREP_STATE), ...patch } }));
  };

  /** Passo 1: checa o que já está instalado/sincronizado e monta o resumo mostrado no modal — não baixa nada ainda. */
  const handlePrepareAndPlay = async (server: KnownServer) => {
    setPrepModalFor(server.shortCode);
    patchPrepState(server.shortCode, { ...INITIAL_PREP_STATE, phase: "checking" });

    if ((server.serverType === "forge" || server.serverType === "neoforge") && !server.forgeVersion) {
      patchPrepState(server.shortCode, {
        phase: "error",
        errorMessage: tn("guest.prep.unknownLoaderVersion", { loader: loaderLabel(server.serverType), address: addressFor(server) }),
      });
      return;
    }

    const localInfo = server.isOwnServer ? getLocalServerInfo(server.shortCode) : null;
    if (server.isOwnServer && !localInfo) {
      patchPrepState(server.shortCode, {
        phase: "error",
        errorMessage: tn("guest.prep.folderMissing"),
      });
      return;
    }

    try {
      let loaderNote: string | null = null;
      let instanceModsDir = "";
      let plan = { entries: [] as PrepState["modEntries"], remoteMods: [] as PrepState["remoteMods"], alreadyInstalledCount: 0, totalBytesToDownload: 0 };

      if (ISOLATED_SERVER_TYPES.has(server.serverType)) {
        const gameDir = await getInstanceDir(server.shortCode);
        instanceModsDir = await join(gameDir, "mods");

        if (server.serverType === "fabric") {
          const already = await findInstalledFabricVersion(server.version);
          loaderNote = already ? null : tn("guest.prep.installFabric");
        } else {
          const already = server.forgeVersion ? await findInstalledForgeVersion(server.forgeVersion) : null;
          loaderNote = already ? null : tn("guest.prep.installLoader", { loader: loaderLabel(server.serverType), version: server.forgeVersion ?? "" });
        }

        plan = localInfo
          ? await planLocalModSync(localInfo.path, instanceModsDir)
          : await planModSync(server.shortCode, instanceModsDir);
      }

      patchPrepState(server.shortCode, {
        phase: "confirm",
        loaderNote,
        instanceModsDir,
        modEntries: plan.entries,
        remoteMods: plan.remoteMods,
        alreadyInstalledCount: plan.alreadyInstalledCount,
        totalBytesToDownload: plan.totalBytesToDownload,
      });
    } catch (err) {
      patchPrepState(server.shortCode, { phase: "error", errorMessage: String(err) });
    }
  };

  /** Último passo comum a todos os caminhos de sucesso: seleciona o perfil no launcher (nunca o abre — isso só no clique final "Abrir Minecraft"). */
  const finalizeLauncherProfile = async (
    server: KnownServer,
    versionId: string,
    gameDir: string | null,
    extra: Partial<PrepState> = {}
  ) => {
    patchPrepState(server.shortCode, { stageMessage: tn("guest.prep.selectingProfile"), stagePercent: 92 });
    try {
      const prepResult = await invoke<string>("prepare_launcher_profile", {
        versionId,
        profileName: `Cubicase — ${server.name}`,
        gameDir,
      });
      if (prepResult === "not_found") {
        patchPrepState(server.shortCode, {
          phase: "error",
          errorMessage: tn("guest.prep.minecraftNotFound", { address: addressFor(server) }),
        });
        return;
      }

      // Servidor do próprio host: não há túnel mesh pra si mesmo, então
      // adiciona diretamente o endereço local (127.0.0.1:<porta real>) na
      // lista de Multiplayer do Minecraft — mesma cortesia que o convidado já
      // recebe ao conectar (ver handleGuestConnect em page.tsx), só que aqui
      // com a porta de verdade do server.properties, não a do túnel.
      if (server.isOwnServer) {
        const localInfo = getLocalServerInfo(server.shortCode);
        if (localInfo) {
          try {
            const port = await getLocalServerPort(localInfo.path);
            const address = port === 25565 ? "127.0.0.1" : `127.0.0.1:${port}`;
            await invoke<string>("add_minecraft_server_entry", { name: server.name, address });
          } catch (err) {
            console.warn("[GuestView] Falha ao adicionar servidor local à lista de Multiplayer:", err);
          }
        }
      }

      patchPrepState(server.shortCode, { phase: "done", versionId, gameDir, ...extra });
    } catch (err) {
      patchPrepState(server.shortCode, { phase: "error", errorMessage: String(err) });
    }
  };

  /** Passo 2 (clique em "Preparar agora"): instala o loader (se precisar) e sincroniza os mods que faltam. */
  const handleConfirmPrepare = async (server: KnownServer) => {
    const current = prepStates[server.shortCode];
    if (!current) return;

    patchPrepState(server.shortCode, { phase: "syncing", stageMessage: tn("guest.prep.preparing"), stagePercent: 0 });

    try {
      let versionId = server.version ?? "";
      let gameDir: string | null = null;
      const localInfo = server.isOwnServer ? getLocalServerInfo(server.shortCode) : null;

      if (server.serverType === "fabric") {
        gameDir = await getInstanceDir(server.shortCode);
        versionId = await installFabricClient(server.version, (p) =>
          patchPrepState(server.shortCode, { stageMessage: p.status, stagePercent: p.percent * 0.5 })
        );
      } else if (server.serverType === "forge" || server.serverType === "neoforge") {
        gameDir = await getInstanceDir(server.shortCode);
        versionId = await installForgeClient(server.serverType, server.version, server.forgeVersion!, (p) =>
          patchPrepState(server.shortCode, { stageMessage: p.status, stagePercent: p.percent * 0.5 })
        );
      }

      if (ISOLATED_SERVER_TYPES.has(server.serverType) && current.modEntries.length > 0) {
        const entries = current.modEntries.map(e => ({ ...e }));
        if (localInfo) {
          await runLocalModSync({
            serverDir: localInfo.path,
            instanceModsDir: current.instanceModsDir,
            remoteMods: current.remoteMods,
            entries,
            onProgress: (updated) => patchPrepState(server.shortCode, { modEntries: [...updated] }),
          });
        } else {
          await runModSync({
            shortCode: server.shortCode,
            instanceModsDir: current.instanceModsDir,
            remoteMods: current.remoteMods,
            entries,
            onProgress: (updated) => patchPrepState(server.shortCode, { modEntries: [...updated] }),
          });
        }

        if (entries.some(e => e.status === "failed")) {
          // Não prepara o perfil ainda — espera o jogador decidir (tentar de
          // novo só os que falharam, ou continuar mesmo assim).
          patchPrepState(server.shortCode, { phase: "done", modEntries: entries, versionId, gameDir });
          return;
        }
      }

      await finalizeLauncherProfile(server, versionId, gameDir);
    } catch (err) {
      patchPrepState(server.shortCode, { phase: "error", errorMessage: String(err) });
    }
  };

  /** "Tentar de novo (N)" no relatório final: baixa de novo só os mods que falharam. */
  const handleRetryFailedOnly = async (server: KnownServer) => {
    const current = prepStates[server.shortCode];
    if (!current) return;

    const reset = current.modEntries.map(e => (e.status === "failed" ? { ...e, status: "pending" as const, error: undefined } : e));
    patchPrepState(server.shortCode, { phase: "syncing", stageMessage: tn("guest.prep.retrying"), stagePercent: 50, modEntries: reset });

    const toRetry = reset.filter(e => e.status === "pending");
    const localInfo = server.isOwnServer ? getLocalServerInfo(server.shortCode) : null;
    const onProgress = (updated: PrepState["modEntries"]) => {
      setPrepStates(prev => {
        const latest = prev[server.shortCode];
        const merged = latest.modEntries.map(e => updated.find(u => u.filename === e.filename) ?? e);
        return { ...prev, [server.shortCode]: { ...latest, modEntries: merged } };
      });
    };
    if (localInfo) {
      await runLocalModSync({
        serverDir: localInfo.path,
        instanceModsDir: current.instanceModsDir,
        remoteMods: current.remoteMods,
        entries: toRetry,
        onProgress,
      });
    } else {
      await runModSync({
        shortCode: server.shortCode,
        instanceModsDir: current.instanceModsDir,
        remoteMods: current.remoteMods,
        entries: toRetry,
        onProgress,
      });
    }

    // `reset` e `toRetry` compartilham as MESMAS referências de objeto pros
    // itens que estavam "pending" — runModSync muta `entry.status` direto
    // neles, então `reset` já reflete o resultado final aqui, sem precisar
    // ler `prepStates` de volta (evitaria pegar um snapshot desatualizado
    // do closure, já que o estado avançou via setPrepStates durante o await).
    if (reset.some(e => e.status === "failed")) {
      patchPrepState(server.shortCode, { phase: "done" });
    } else {
      await finalizeLauncherProfile(server, current.versionId, current.gameDir);
    }
  };

  /** "Continuar mesmo assim" no relatório final: aceita prosseguir com mods faltando. */
  const handleContinueAnyway = async (server: KnownServer) => {
    const current = prepStates[server.shortCode];
    if (!current) return;
    await finalizeLauncherProfile(server, current.versionId, current.gameDir, { acceptedPartial: true });
  };

  /** Clique final "Abrir Minecraft" — só aqui o launcher é de fato aberto. */
  const handleOpenMinecraftFinal = async () => {
    try {
      await invoke("open_minecraft_launcher");
    } catch (err) {
      console.warn("[GuestView] Falha ao abrir o Minecraft Launcher:", err);
    }
    setPrepModalFor(null);
  };

  // Sincronizar servidores locais do host na biblioteca do guest
  // Adiciona servidores locais novos e remove os que foram deletados
  useEffect(() => {
    const localShortCodes = new Set(
      localServers.filter(s => s.shortCode).map(s => s.shortCode!)
    );

    // Adicionar servidores locais novos que ainda não estão na lista
    for (const server of localServers) {
      if (!server.shortCode) continue;
      const exists = knownServers.find(s => s.shortCode === server.shortCode);
      if (!exists) {
        addKnownServer({
          shortCode: server.shortCode,
          name: server.name,
          version: server.version || "1.20.1",
          serverType: server.serverType || "vanilla",
          description: server.description || tn("guest.defaultDescription", { version: server.version || "1.20.1" }),
          status: "offline",
          minecraftStatus: null,
          port: 25565,
          maxPlayers: 20,
          currentPlayers: 0,
          lastSeenOnline: null,
          onlineSince: null,
          lastConfirmedAt: null,
          addedAt: new Date().toISOString(),
          isOwnServer: true,
          networkProvider: "link-v1",
          forgeVersion: server.forgeVersion ?? null,
          modLoaderVersion: server.modLoaderVersion ?? null,
          connectName: null,
        });
      }
    }

    // Remover servidores "Meu" que foram deletados localmente
    // (isOwnServer=true mas não existe mais em localServers)
    const serversToRemove = knownServers.filter(
      s => s.isOwnServer && !localShortCodes.has(s.shortCode)
    );
    for (const s of serversToRemove) {
      removeKnownServer(s.shortCode);
    }
    // knownServers muda (nova referência) a cada add/remove/update no store —
    // incluindo os feitos por ESTE próprio efeito. Isso faz o efeito rodar de
    // novo depois de cada add/remove, mas aí já converge: na segunda
    // passagem, os servidores que acabaram de ser adicionados/removidos já
    // batem com localServers, então os dois loops acima não encontram mais
    // nada a fazer e o efeito não dispara uma terceira vez.
  }, [localServers, knownServers, addKnownServer, removeKnownServer]);

  // Lê `knownServers` direto do store (não do closure do componente) e é
  // estável entre renders (useCallback com deps vazias) — de propósito: os
  // dois efeitos abaixo rodam só uma vez (montagem) e a cada 30s, e não
  // devem reiniciar o intervalo a cada atualização de status (que também
  // muda `knownServers`, já que updateKnownServerStatus escreve nele). Antes,
  // como a função fechava sobre `knownServers` do render de montagem e os
  // efeitos nunca re-rodavam ([] como dependência), o polling periódico
  // ficava preso pra sempre olhando o `knownServers` de quando o componente
  // montou — se a lista estivesse vazia nesse instante, o refresh periódico
  // nunca via os servidores adicionados depois.
  const lastCheckedRef = useRef<Map<string, number>>(new Map());
  const lastRunRef = useRef(0);
  // `silent` = consulta automática (em segundo plano); fora dela é o botão "atualizar", que consulta todos.
  const refreshAllServers = useCallback(async (silent = false) => {
    const knownServers = useAppStore.getState().knownServers;
    if (knownServers.length === 0) return;
    if (!silent) setIsRefreshing(true);
    lastRunRef.current = Date.now();

    let hasError = false;
    for (const server of knownServers) {
      // Servidor parado há muito tempo muda raramente: na consulta automática, só olha de tempos em tempos.
      const startedAt = Date.now();
      if (!shouldPoll(server, lastCheckedRef.current.get(server.shortCode), startedAt, !silent)) continue;
      lastCheckedRef.current.set(server.shortCode, startedAt);
      try {
        // Consultar API Central para obter status do servidor
        const response = await fetch(`${API_BASE}/api/v1/servers/${server.shortCode}`);
        if (response.ok) {
          // A API Central responde envelopado: os dados reais ficam em data.server
          // (metadados) e data.session (status/jogadores) — não no nível raiz.
          const envelope = await response.json();
          // session vem null quando o host nunca teve uma sessão ativa (ou ela expirou) —
          // trata como "offline" em vez de deixar o status como undefined.
          const session = envelope?.data?.session ?? {};
          // networkStatus (rede mesh) e minecraftStatus (processo Java) são
          // independentes — ver handleDiscoverServer na API Central.
          const status = (session.networkStatus ?? session.status ?? "offline") as ServerStatus;
          const minecraftStatus = (session.minecraftStatus ?? null) as ServerStatus | null;
          console.log(`[GuestView] Servidor ${server.shortCode} (${server.name}): rede=${status}, minecraft=${minecraftStatus}`);
          // Ícone do servidor (a central manda só o hash; a imagem é baixada quando muda).
          noteServerIconHash(server.shortCode, envelope?.data?.server?.iconHash);
          updateKnownServerStatus(
            server.shortCode,
            status,
            minecraftStatus,
            session.currentPlayers ?? undefined
          );
        } else {
          console.warn(`[GuestView] Servidor ${server.shortCode}: API retornou HTTP ${response.status}`);
          // Servidor não encontrado na API (removido pelo host)
          if (response.status === 404) {
            updateKnownServerStatus(server.shortCode, "offline", null);
          }
        }
      } catch (err) {
        console.error(`[GuestView] Erro ao consultar servidor ${server.shortCode}:`, err);
        hasError = true;
      }
    }

    if (hasError) {
      setIsOfflineMode(true);
    } else {
      setIsOfflineMode(false);
    }

    setLastRefreshTime(new Date());
    if (!silent) setIsRefreshing(false);
  }, [updateKnownServerStatus]);

  // Atualizar status de todos os servidores conhecidos ao abrir. Disparado
  // via setTimeout (não chamado direto no corpo do efeito) porque
  // refreshAllServers muda estado (setIsRefreshing) já na sua primeira linha,
  // antes do primeiro await — chamar isso de forma síncrona dentro do efeito
  // encadearia um re-render ainda durante a fase de commit do React.
  useEffect(() => {
    const id = setTimeout(() => refreshAllServers(), 0);
    return () => clearTimeout(id);
  }, [refreshAllServers]);

  // Atualiza o status periodicamente (a cada 30 s), mas só enquanto alguém está olhando: com a janela escondida ou
  // minimizada não há quem veja a mudança, então não consulta a API Central. Ao voltar, atualiza na hora.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
    const start = () => {
      stop();
      interval = setInterval(() => refreshAllServers(true), POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (Date.now() - lastRunRef.current > REFRESH_ON_RETURN_MS) void refreshAllServers(true);
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [refreshAllServers]);

  // Wake-on-demand: pede pro host acordar (POST /wake) e faz um poll rápido
  // (3s, só deste servidor) até minecraftStatus sair de "sleeping" — bem mais
  // frequente que o refreshAllServers de 30s, pra não deixar quem clicou
  // esperando sem feedback por muito tempo. Desiste depois de ~90s.
  const handleWakeServer = async (server: KnownServer) => {
    setWakingShortCode(server.shortCode);
    setWakeError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/servers/${server.shortCode}/wake`, { method: "POST", headers: { "Accept-Language": getLocale() } });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = res.status === 429
          ? tn("guest.wake.rateLimited")
          : (body?.message || tn("guest.wake.failed", { status: res.status }));
        throw new Error(message);
      }

      const POLL_INTERVAL_MS = 3000;
      const MAX_ATTEMPTS = 30; // ~90s no total
      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
          setWakingShortCode(null);
          setWakeError({ shortCode: server.shortCode, message: tn("guest.wake.timeout") });
          return;
        }
        try {
          const discoverRes = await fetch(`${API_BASE}/api/v1/servers/${server.shortCode}`);
          if (discoverRes.ok) {
            const envelope = await discoverRes.json();
            const session = envelope?.data?.session ?? {};
            const status = (session.networkStatus ?? session.status ?? "offline") as ServerStatus;
            const minecraftStatus = (session.minecraftStatus ?? null) as ServerStatus | null;
            updateKnownServerStatus(server.shortCode, status, minecraftStatus, session.currentPlayers ?? undefined);
            if (minecraftStatus !== "sleeping") {
              setWakingShortCode(null);
              return;
            }
          }
        } catch { /* mantém tentando até o limite de tentativas */ }
        setTimeout(poll, POLL_INTERVAL_MS);
      };
      poll();
    } catch (err) {
      setWakingShortCode(null);
      const message = err instanceof Error ? err.message : String(err);
      setWakeError({ shortCode: server.shortCode, message });
    }
  };

  type AddServerResult =
    | { ok: true; server: KnownServer }
    | { ok: false; reason: "not_found" | "network_error" };

  /** Consulta a API Central por um shortCode e adiciona à biblioteca — usado tanto pelo formulário manual quanto pelo link de convite (deep link, ver efeito abaixo). Não checa duplicidade (quem chama já decide o que fazer se já existir). */
  const addServerByCode = async (code: string): Promise<AddServerResult> => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/servers/${code}`);
      if (!response.ok) return { ok: false, reason: "not_found" };

      // Envelope da API Central: metadados em data.server, status/jogadores em data.session.
      const envelope = await response.json();
      const server = envelope?.data?.server ?? {};
      const session = envelope?.data?.session ?? {};
      const networkStatus = session.networkStatus ?? session.status ?? "offline";
      const known: KnownServer = {
        shortCode: server.shortCode,
        name: server.name,
        version: server.version,
        serverType: server.serverType || "vanilla",
        description: server.description || tn("guest.defaultDescription", { version: server.version }),
        status: networkStatus,
        minecraftStatus: session.minecraftStatus ?? null,
        port: session.port || 25565,
        maxPlayers: session.maxPlayers || 20,
        currentPlayers: session.currentPlayers || 0,
        lastSeenOnline: session.minecraftStatus === "online" ? new Date().toISOString() : null,
        onlineSince: session.minecraftStatus === "online" ? new Date().toISOString() : null,
        lastConfirmedAt: new Date().toISOString(),
        addedAt: new Date().toISOString(),
        isOwnServer: false,
        networkProvider: session.provider || "link-v1",
        forgeVersion: server.forgeVersion ?? null,
        modLoaderVersion: server.modLoaderVersion ?? null,
        connectName: server.connectName ?? null,
      };
      addKnownServer(known);
      return { ok: true, server: known };
    } catch {
      return { ok: false, reason: "network_error" };
    }
  };

  const handleAddServer = async () => {
    const code = inviteCodeInput.replace("CF-", "").trim().toUpperCase();
    if (!code) {
      setAddError(tn("guest.add.enterCode"));
      return;
    }

    // Verificar se já existe
    if (knownServers.find(s => s.shortCode === code)) {
      setAddError(tn("guest.add.duplicate"));
      return;
    }

    setIsAdding(true);
    setAddError(null);

    const result = await addServerByCode(code);
    setIsAdding(false);
    if (!result.ok) {
      setAddError(
        result.reason === "not_found"
          ? tn("guest.add.notFound")
          : tn("guest.add.apiDown")
      );
      return;
    }

    setShowAddModal(false);
    setInviteCodeInput("");
  };

  // Um servidor é considerado "obsoleto" se a última confirmação da API Central
  // foi há mais tempo do que alguns ciclos de polling (30s cada). Sem isso, um
  // status cacheado (ex: "online") continuaria sendo exibido como verdade mesmo
  // que a API esteja fora do ar ou as requisições estejam falhando repetidamente —
  // o que passaria informação falsa para o convidado.
  const STALE_THRESHOLD_MS = 100_000; // ~3 ciclos de 30s
  const isServerStale = (server: KnownServer, nowMs: number): boolean => {
    if (!server.lastConfirmedAt) return true;
    return nowMs - new Date(server.lastConfirmedAt).getTime() > STALE_THRESHOLD_MS;
  };

  const handleConnect = (server: KnownServer) => {
    if (server.status !== "online" || isServerStale(server, now)) return;
    setConnectedShortCode(server.shortCode);
    onConnect(`CF-${server.shortCode}`);
  };

  // Convite recebido via link bonito (play.cubicase.net/<slug> -> deep link
  // cubicase://join/<shortCode>, ver src/lib/joinDeepLink.ts). Reusa o mesmo
  // modal de "Adicionar servidor" pra aproveitar o loading/erro já existentes
  // — só entra no fluxo automaticamente em vez de esperar o usuário digitar.
  // Se o servidor já estiver na biblioteca e online, conecta direto.
  useEffect(() => {
    if (!pendingJoinShortCode) return;
    const code = pendingJoinShortCode;

    void (async () => {
      setPendingJoinShortCode(null);

      const existing = knownServers.find(s => s.shortCode === code);
      if (existing) {
        handleConnect(existing);
        return;
      }

      setInviteCodeInput(code);
      setShowAddModal(true);
      setIsAdding(true);
      setAddError(null);
      const result = await addServerByCode(code);
      setIsAdding(false);
      if (!result.ok) {
        const message = result.reason === "not_found"
          ? tn("guest.invite.expired")
          : tn("guest.add.apiDown");
        setAddError(message);
        pushDiagnostic({ level: "warning", source: tn("diag.source.invite"), title: tn("guest.invite.failed.title"), message, detail: `CF-${code}` });
        return;
      }
      setShowAddModal(false);
      setInviteCodeInput("");
      pushDiagnostic({ level: "info", source: tn("diag.source.invite"), title: tn("guest.invite.added.title"), message: tn("guest.invite.added.message", { name: result.server.name }) });
      handleConnect(result.server);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoinShortCode]);

  const handleDisconnect = () => {
    setConnectedShortCode(null);
    onDisconnect();
  };

  const handleRemoveServer = (shortCode: string) => {
    if (connectedShortCode === shortCode) {
      handleDisconnect();
    }
    removeKnownServer(shortCode);
  };

  // Guarda o TEXTO copiado (não um booleano solto) pra só o botão que copiou
  // aquele conteúdo específico mostrar o ícone de check — com um booleano
  // único, copiar o código de um servidor "marcava" o botão de copiar de
  // TODOS os outros servidores da lista, mesmo copiando códigos diferentes.
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((current) => (current === text ? null : current)), 2000);
  };

  const formatLastSeen = (iso: string | null, nowMs: number): string => {
    if (!iso) return t("guest.time.never");
    const diff = nowMs - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t("guest.time.justNow");
    if (minutes < 60) return t("guest.time.minutesAgo", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("guest.time.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    return t("guest.time.daysAgo", { count: days });
  };

  // Tempo online desde a última vez que o status transicionou para "online"
  // (calculado localmente a partir de onlineSince, sem depender do host).
  const formatUptime = (iso: string | null): string => {
    if (!iso) return "0min";
    const diff = Math.max(0, now - new Date(iso).getTime());
    const totalMinutes = Math.floor(diff / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 1) return `${minutes}min`;
    return `${hours}h${minutes.toString().padStart(2, "0")}min`;
  };

  // Rede mesh (status) e Minecraft (minecraftStatus) são reportados de forma
  // independente pela API Central — um host pode ligar só um dos dois (ex: rodar
  // o servidor sem usar a malha do CubeForge, acessível só por IP local/LAN ou
  // outra VPN). Por isso o badge combina os dois em 4 estados em vez de repetir
  // o "Offline" genérico sempre que falta qualquer uma das duas partes.
  const getDisplayStatus = (server: KnownServer): { color: string; textClass: string; label: string; labelKey: TKey } => {
    const networkOnline = server.status === "online";
    const mc = server.minecraftStatus;
    const mcOnline = mc === "online";
    // labelKey identifica o estado (a UI compara por ele, nunca pelo texto traduzido).
    const build = (labelKey: TKey, color: string, textClass: string) => ({ color, textClass, label: t(labelKey), labelKey });

    if (networkOnline && mcOnline) {
      return build("guest.status.online", "bg-emerald-500", "text-emerald-600 dark:text-emerald-400");
    }
    if (networkOnline) {
      // Rede pronta, mas o processo Java não está de pé.
      const labelKey: TKey =
        mc === "starting" ? "guest.status.starting" :
        mc === "stopping" ? "guest.status.stopping" :
        mc === "crashed" ? "guest.status.crashed" :
        "guest.status.stopped";
      return build(
        labelKey,
        mc === "crashed" ? "bg-rose-500" : "bg-amber-500",
        mc === "crashed" ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400",
      );
    }
    if (mcOnline) {
      // Minecraft rodando, mas sem a rede mesh do CubeForge — só acessível
      // diretamente (IP local/LAN) ou por outra VPN, não pelo "Conectar" daqui.
      return build("guest.status.noMesh", "bg-sky-500", "text-sky-600 dark:text-sky-400");
    }
    if (mc === "crashed") {
      // Sem rede E o Minecraft crashou — mantém consistente com o botão de ação
      // abaixo, que já trata esse caso separadamente do "Offline" genérico.
      return build("guest.status.crashed", "bg-rose-500", "text-rose-600 dark:text-rose-400");
    }
    if (mc === "sleeping") {
      // Wake-on-demand armado: rede mesh de propósito desligada até alguém
      // pedir pra entrar (ver botão "Acordar servidor" abaixo).
      return build("guest.status.sleeping", "bg-indigo-400", "text-indigo-500 dark:text-indigo-400");
    }
    return build("guest.status.offline", "bg-slate-400", "text-theme-secondary");
  };

  const isConnecting = netStatus === "connecting";
  const isOnline = netStatus === "online";

  /**
   * Botão "Jogar" para "Meus Servidores": o host não conecta na própria
   * mesh (por isso o card nunca oferece "Conectar" pra si mesmo), mas o
   * Minecraft já está rodando localmente — então em vez de só exibir um
   * badge estático, abre direto o mesmo fluxo "Preparar e Jogar" (loader +
   * mods + perfil do launcher), só que lendo os mods da pasta do servidor no
   * disco e conectando em 127.0.0.1:<porta real>, sem precisar da rede mesh.
   */
  const renderOwnPlayButton = (server: KnownServer) => {
    if (!PLAYABLE_SERVER_TYPES.has(server.serverType)) {
      const display = getDisplayStatus(server);
      return (
        <div className="flex-1 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-500">
          <Zap className="w-3 h-3 text-indigo-400" />
          {display.label}
        </div>
      );
    }
    const busy = prepModalFor === server.shortCode && prepStates[server.shortCode]?.phase !== "error" && prepStates[server.shortCode]?.phase !== "done";
    return (
      <button
        type="button"
        onClick={() => handlePrepareAndPlay(server)}
        disabled={busy}
        className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-theme-shadow"
        title={t("guest.playTitle")}
      >
        <Play className="w-3.5 h-3.5 fill-current" /> {t("guest.play")}
      </button>
    );
  };

  return {
    t,
    rich,
    locale,
    knownServers,
    addKnownServer,
    removeKnownServer,
    updateKnownServerStatus,
    localServers,
    connectedShortCode,
    setConnectedShortCode,
    radminRoute,
    pendingJoinShortCode,
    setPendingJoinShortCode,
    addressFor,
    showAddModal,
    setShowAddModal,
    inviteCodeInput,
    setInviteCodeInput,
    isAdding,
    setIsAdding,
    addError,
    setAddError,
    isRefreshing,
    setIsRefreshing,
    lastRefreshTime,
    setLastRefreshTime,
    isOfflineMode,
    setIsOfflineMode,
    copied,
    setCopied,
    wakingShortCode,
    setWakingShortCode,
    wakeError,
    setWakeError,
    now,
    setNow,
    prepModalFor,
    setPrepModalFor,
    prepStates,
    setPrepStates,
    loaderLabel,
    serverKindLabel,
    getLocalServerInfo,
    patchPrepState,
    handlePrepareAndPlay,
    finalizeLauncherProfile,
    handleConfirmPrepare,
    handleRetryFailedOnly,
    handleContinueAnyway,
    handleOpenMinecraftFinal,
    refreshAllServers,
    handleWakeServer,
    addServerByCode,
    handleAddServer,
    STALE_THRESHOLD_MS,
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
    renderOwnPlayButton,
    netStatus,
    minecraftPort,
    onConnect,
    onDisconnect,
  };
}

export type GuestController = ReturnType<typeof useGuestController>;
