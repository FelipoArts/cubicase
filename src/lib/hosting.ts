// Hospedagem unificada (servidor Minecraft + rede mesh) — lado TypeScript.
//
// O backend (src-tauri/src/hosting.rs) orquestra os dois ciclos de vida e
// publica um único status ("hosting-status"). Aqui ficam só os tipos e as
// funções puras que a UI usa para decidir o que mostrar — sem Tauri, para
// serem testáveis (ver __tests__/hosting.test.ts).

export type HostingPhase =
  | "idle"
  | "starting"
  | "connecting"
  | "onlineFriends"
  | "localOnly"
  | "stopping"
  | "crashed";

export type LocalOnlyReason = "userChoice" | "networkFailed" | "networkDropped";

export interface HostingStatus {
  phase: HostingPhase;
  mc: "offline" | "starting" | "online" | "crashed";
  net: "off" | "connecting" | "online";
  localOnlyReason: LocalOnlyReason | null;
  /** Há uma tentativa de rede em andamento agora. */
  netRetrying: boolean;
  /** Instante (ms Unix) da próxima tentativa automática, se agendada. */
  netRetryAtMs: number | null;
  /** As tentativas automáticas acabaram; só o botão manual resolve. */
  netGaveUp: boolean;
  netError: string | null;
  /** Falha ao iniciar o Minecraft (já traduzida pelo backend). */
  error: string | null;
  shortCode: string | null;
  serverName: string | null;
  ip: string | null;
  /** Wake-on-demand armado mas PAUSADO: o usuário parou o servidor à mão, então ninguém consegue acordá-lo. */
  wakePaused: boolean;
}

export const IDLE_HOSTING_STATUS: HostingStatus = {
  phase: "idle",
  mc: "offline",
  net: "off",
  localOnlyReason: null,
  netRetrying: false,
  netRetryAtMs: null,
  netGaveUp: false,
  netError: null,
  error: null,
  shortCode: null,
  serverName: null,
  ip: null,
  wakePaused: false,
};

/** Código devolvido por `start_hosting` quando este app é convidado de outro servidor. */
export const HOSTING_GUEST_ACTIVE = "GUEST_ACTIVE";

export function isGuestActiveError(err: unknown): boolean {
  return String(err).trim() === HOSTING_GUEST_ACTIVE;
}

/** Há uma sessão de hospedagem em andamento (qualquer fase exceto parada/crash). */
export function isHostingActive(phase: HostingPhase): boolean {
  return phase !== "idle" && phase !== "crashed";
}

/** Rótulo único do botão principal e do status — o usuário nunca vê "mesh". */
export type HostingHeadline =
  | "idle"
  | "preparing"
  | "starting"
  | "connecting"
  | "onlineFriends"
  | "localOnlyChoice"
  | "localOnlyFailed"
  | "stopping"
  | "crashed";

export interface HeadlineInputs {
  status: HostingStatus;
  /** Preparação feita no frontend antes do start_hosting (instalar Java etc.). */
  preparing: boolean;
  /** Estado do processo Minecraft vindo de "minecraft-status-changed" (store). */
  mcStatus: "offline" | "starting" | "online" | "stopping" | "crashed" | "sleeping";
  /** A rede de HOST está online (netStatus/netMode do app) — só usado fora de uma sessão do orquestrador. */
  hostNetOnline: boolean;
}

export function hostingHeadline({ status, preparing, mcStatus, hostNetOnline }: HeadlineInputs): HostingHeadline {
  if (preparing) return "preparing";
  switch (status.phase) {
    case "starting": return "starting";
    case "connecting": return "connecting";
    case "onlineFriends": return "onlineFriends";
    case "localOnly": return status.localOnlyReason === "userChoice" ? "localOnlyChoice" : "localOnlyFailed";
    case "stopping": return "stopping";
    case "crashed": return "crashed";
    case "idle":
      // Minecraft de pé sem sessão do orquestrador (ex.: iniciado pelo modo de
      // espera/wake-on-demand): continua sendo "parável" na UI.
      if (mcStatus === "stopping") return "stopping";
      if (mcStatus === "starting") return "starting";
      if (mcStatus === "online") return hostNetOnline ? "onlineFriends" : "localOnlyFailed";
      if (mcStatus === "crashed") return "crashed";
      return "idle";
  }
}

/** O botão principal para a sessão (Parar) em vez de iniciar (Iniciar)? */
export function isStopAction(h: HostingHeadline): boolean {
  return h === "starting" || h === "connecting" || h === "onlineFriends" || h === "localOnlyChoice" || h === "localOnlyFailed";
}

/** Botão principal desabilitado (transições em que um clique só atrapalharia). */
export function isPrimaryDisabled(h: HostingHeadline): boolean {
  return h === "preparing" || h === "stopping";
}

/** Segundos até a próxima tentativa automática de rede (null se não agendada/já passou). */
export function secondsUntilRetry(status: HostingStatus, nowMs: number): number | null {
  if (status.netRetryAtMs == null || status.netRetrying) return null;
  const left = Math.ceil((status.netRetryAtMs - nowMs) / 1000);
  return left > 0 ? left : null;
}

/** Os amigos conseguem entrar agora? */
export function friendsCanJoin(status: HostingStatus): boolean {
  return status.phase === "onlineFriends";
}
