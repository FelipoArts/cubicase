import { create } from "zustand";

// ============================================================
// Ajuda de conexão (plano B: Radmin VPN)
// ============================================================
// Quando a conexão direta entre os computadores não funciona e o relay não está disponível (cota do mês
// esgotada, modo privado bloqueado, relay fora do ar), o app não deve deixar o usuário sem saída. Este store
// controla a janela que guia, para leigos, o caminho alternativo — Radmin VPN, gratuito e sem abrir portas
// (ver src/lib/radmin.ts e ConnectionHelpModal.tsx). Efêmero (não persiste): é uma ajuda pontual.
// ============================================================

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

/** O servidor que o convidado estava tentando alcançar (a janela guia a entrada nele). */
export interface GuestTarget {
  shortCode: string;
  name: string;
}

interface ConnectionHelpState {
  open: boolean;
  reason: ConnectionHelpReason;
  /** Servidor que o convidado tentava alcançar; null = a janela abriu sem contexto (ex.: Central de Ajuda). */
  target: GuestTarget | null;
  /** Quando a ajuda foi aberta sozinha pela última vez (ms), para não reabrir a cada falha repetida. */
  lastAutoOpenAt: number;
  /** Abre sem contexto de servidor (botão da Central de Ajuda). */
  show: (reason: ConnectionHelpReason) => void;
  /** Abre guiando a entrada num servidor específico. */
  showForServer: (target: GuestTarget, reason?: ConnectionHelpReason) => void;
  /** Lembra o servidor da tentativa em andamento, sem abrir nada (uma falha logo depois abre a janela com ele). */
  setTarget: (target: GuestTarget | null) => void;
  /** Abre sozinha, no máximo uma vez a cada `cooldownMs` (a reconexão automática falha em laço). */
  showAuto: (reason: ConnectionHelpReason, cooldownMs?: number) => boolean;
  close: () => void;
}

export const useConnectionHelp = create<ConnectionHelpState>((set, get) => ({
  open: false,
  reason: "manual",
  target: null,
  lastAutoOpenAt: 0,
  show: (reason) => set({ open: true, reason, target: null }),
  showForServer: (target, reason = "manual") => set({ open: true, reason, target }),
  setTarget: (target) => set({ target }),
  showAuto: (reason, cooldownMs = 10 * 60 * 1000) => {
    const now = Date.now();
    if (get().open || now - get().lastAutoOpenAt < cooldownMs) return false;
    set({ open: true, reason, lastAutoOpenAt: now });
    return true;
  },
  close: () => set({ open: false }),
}));
