// Transporte de rede entre host e convidado.
//
// - "tailscale-v1/tsnet-v1": o modelo antigo (IP virtual do Tailscale).
// - "link-v1": conexão direta P2P (cubicase-link) — o convidado não precisa de IP, só do código.
//
// O convidado NÃO escolhe o transporte: segue o que o host publica na descoberta
// (`session.provider`). Host e convidado precisam falar o mesmo.

export const LINK_LAUNCHER = "link-v1";

export interface GuestRoute {
  /** Launcher a pedir à API ("link-v1") ou null para o padrão. */
  launcher: string | null;
  /** IP virtual do host (só no modelo antigo). */
  targetIp: string | null;
}

/**
 * Decide como o convidado deve conectar a partir da descoberta. Devolve null quando o host
 * não pode ser alcançado (servidor não encontrado, ou modelo antigo sem IP publicado).
 */
export function guestRouteFromDiscovery(found: boolean, session: { provider?: string | null; hostIp?: string | null } | null | undefined): GuestRoute | null {
  if (!found) return null;
  if (session?.provider === LINK_LAUNCHER) return { launcher: LINK_LAUNCHER, targetIp: null };
  const ip = session?.hostIp ?? null;
  return ip ? { launcher: null, targetIp: ip } : null;
}

/** Rótulo do caminho (chave de i18n) para mostrar "Conexão direta" ou "Via relay". */
export function pathLabelKey(path: string): "net.path.direct" | "net.path.punched" | "net.path.relay" {
  if (path === "relay") return "net.path.relay";
  if (path === "punched") return "net.path.punched";
  return "net.path.direct";
}
