import { create } from "zustand";

// ============================================================
// Ajuda de conexão (plano B: Radmin VPN)
// ============================================================
// Quando a conexão direta entre os computadores não funciona e o relay não está disponível
// (cota gratuita do mês acabou, modo privado bloqueado, relay fora do ar), o app não deve deixar o
// usuário sem saída. Este store controla a janela que explica, para leigos, o caminho alternativo
// — Radmin VPN, gratuito e sem abrir portas. Efêmero (não persiste): é uma ajuda pontual.
// ============================================================

/** Página oficial de download do Radmin VPN. */
export const RADMIN_DOWNLOAD_URL = "https://www.radmin-vpn.com/";

/** Por que a ajuda foi aberta: muda só a frase de contexto no topo da janela. */
export type ConnectionHelpReason = "direct_failed" | "relay_quota" | "private_locked" | "manual";

/** Códigos de aviso do sidecar que significam "não consegui ligar os dois computadores". */
const DIRECT_FAILURE_CODES = new Set(["peer_failed"]);

/** Dica do Worker de que o relay não vai ser oferecido (cota esgotada). */
export const RELAY_QUOTA_CODE = "relay_quota";

/** A falha de conexão com este código do sidecar justifica abrir a ajuda sozinha? */
export function isDirectFailureCode(code: string | undefined | null): boolean {
  return !!code && DIRECT_FAILURE_CODES.has(code);
}

/** Endereço que o amigo digita no Minecraft pelo Radmin: IP do host + porta (omitida se for 25565). */
export function radminJoinAddress(ip: string, port: number): string {
  return port === 25565 ? ip : `${ip}:${port}`;
}

interface ConnectionHelpState {
  open: boolean;
  reason: ConnectionHelpReason;
  /** Quando a ajuda foi aberta sozinha pela última vez (ms), para não reabrir a cada falha repetida. */
  lastAutoOpenAt: number;
  show: (reason: ConnectionHelpReason) => void;
  /** Abre sozinha, no máximo uma vez a cada `cooldownMs` (a reconexão automática falha em laço). */
  showAuto: (reason: ConnectionHelpReason, cooldownMs?: number) => boolean;
  close: () => void;
}

export const useConnectionHelp = create<ConnectionHelpState>((set, get) => ({
  open: false,
  reason: "manual",
  lastAutoOpenAt: 0,
  show: (reason) => set({ open: true, reason }),
  showAuto: (reason, cooldownMs = 10 * 60 * 1000) => {
    const now = Date.now();
    if (get().open || now - get().lastAutoOpenAt < cooldownMs) return false;
    set({ open: true, reason, lastAutoOpenAt: now });
    return true;
  },
  close: () => set({ open: false }),
}));
