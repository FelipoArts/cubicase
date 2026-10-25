import { pathLabelKey } from "@/lib/networkTransport";
import { t as tn } from "@/i18n";

/**
 * Mostra o "endereço" da rede: no modelo antigo é o IP virtual; no P2P ("p2p") não existe IP,
 * então mostra o tipo de caminho (conexão direta / via relay) e a latência, quando conhecidos.
 */
export function meshAddressLabel(ip: string | null, path: { path: string; rttMs: number | null } | null, t: typeof tn): string {
  if (ip !== "p2p") return ip ?? "";
  if (!path) return t("net.path.connecting");
  return t(pathLabelKey(path.path)) + (path.rttMs != null ? ` · ${path.rttMs} ms` : "");
}
