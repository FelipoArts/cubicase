// ============================================================
// Marcos e falhas desta instalação (para a contagem anônima — ver installPing.ts)
// ============================================================
// Guarda só DOIS números neste computador: quais etapas do uso esta instalação já alcançou e quais tipos de falha já
// aconteceram nela (cada etapa/falha é um bit). Nada de nomes, caminhos, mensagens de erro, servidores ou contas: só
// "alcançou a etapa X" e "teve uma falha do tipo Y". Vão junto do ping diário, que o usuário pode desligar.
// ============================================================

export const MILESTONES = {
  account: 1,            // entrou numa conta
  server_installed: 2,   // tem pelo menos um servidor no computador
  server_started: 4,     // ligou um servidor (ficou online)
  invited: 8,            // copiou o código/link de convite
  player_joined: 16,     // havia 2 ou mais jogadores online ao mesmo tempo
} as const;
export type Milestone = keyof typeof MILESTONES;

export const ERRORS = {
  install_failed: 1,       // não conseguiu criar/instalar o servidor (Java, download...)
  server_start_failed: 2,  // o servidor não subiu
  connection_failed: 4,    // a conexão com os amigos falhou
  update_failed: 8,        // a atualização do app falhou
} as const;
export type ErrorKind = keyof typeof ERRORS;

const MS_KEY = "cubicase-milestones";
const ER_KEY = "cubicase-errors";

function readMask(key: string): number {
  try {
    const n = Number(localStorage.getItem(key) ?? 0);
    return Number.isInteger(n) && n >= 0 && n < 1 << 16 ? n : 0;
  } catch {
    return 0;
  }
}
function writeMask(key: string, mask: number): void {
  try { localStorage.setItem(key, String(mask)); } catch { /* sem storage: só não conta */ }
}

export function getMilestoneMask(): number { return readMask(MS_KEY); }
export function getErrorMask(): number { return readMask(ER_KEY); }

export function markMilestone(name: Milestone): void {
  const cur = readMask(MS_KEY);
  if ((cur & MILESTONES[name]) === 0) writeMask(MS_KEY, cur | MILESTONES[name]);
}

export function markError(kind: ErrorKind): void {
  const cur = readMask(ER_KEY);
  if ((cur & ERRORS[kind]) === 0) writeMask(ER_KEY, cur | ERRORS[kind]);
}

/** Estado do app que já indica um marco (usado para marcar sem espalhar chamadas pelo código). */
export interface MilestoneSnapshot {
  hasUser: boolean;
  serverCount: number;
  serverStatus: string;
  onlinePlayers: number;
}

export function applySnapshot(s: MilestoneSnapshot): void {
  if (s.hasUser) markMilestone("account");
  if (s.serverCount > 0) markMilestone("server_installed");
  if (s.serverStatus === "online") markMilestone("server_started");
  if (s.onlinePlayers >= 2) markMilestone("player_joined");
}
