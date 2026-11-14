// ============================================================
// Badge de tempo de assinatura do Cubicase Plus (Fase 3 do perfil do jogador)
// ============================================================
// O badge do Plus evolui com o tempo CONTÍNUO de assinatura (Madeira → Netherite). Parar de pagar tira o badge na
// hora; voltar em até 7 dias preserva o progresso (o tempo parado não conta); passar disso zera tudo.
//
// Tudo aqui é função pura (sem rede nem relógio próprio): o estado vem do banco e o "agora" vem de quem chama.
// O nível é calculado na LEITURA, então não há rotina que promova níveis nem que expire a janela de 7 dias.
//
// Estado guardado (tabela plus_streaks, ver scripts/supabase-plus-streaks.sql):
//   streak_started   início da sequência (informativo)
//   counted_ms       tempo ativo já fechado, sem contar buracos
//   segment_start    início do trecho contínuo em andamento
//   last_active_end  até quando o último pagamento cobre (o fim do período pago)
// ============================================================

export const TIER_IDS = ['wood', 'stone', 'iron', 'gold', 'redstone', 'diamond', 'emerald', 'netherite'] as const;
export type PlusTierId = (typeof TIER_IDS)[number];

const DAY_MS = 24 * 3600 * 1000;
/** Um "mês" de assinatura para os níveis: 30 dias (assim o plano anual, de 365 dias, já passa dos 12 meses). */
const MONTH_MS = 30 * DAY_MS;

/** Quanto tempo parado ainda preserva o progresso. */
export const GRACE_MS = 7 * DAY_MS;

/** Tempo contínuo mínimo de cada nível. Ajustável aqui, num único lugar. */
const TIER_MIN_MONTHS: Record<PlusTierId, number> = {
  wood: 0, stone: 1, iron: 3, gold: 6, redstone: 12, diamond: 18, emerald: 24, netherite: 36,
};

export interface StreakState {
  streakStartedMs: number;
  countedMs: number;
  segmentStartMs: number;
  lastActiveEndMs: number;
}

/** O que o app mostra: badge ativo, janela de 7 dias (sem badge, progresso guardado) ou nada. */
export type StreakPhase = 'active' | 'grace' | 'none';

export interface StreakView {
  phase: StreakPhase;
  /** Nível de quem está ativo, ou o nível que se perde se a janela de 7 dias fechar (fase `grace`). */
  tier: PlusTierId | null;
  /** Tempo contínuo acumulado, em dias inteiros. */
  days: number;
  /** Só na fase `grace`: até quando dá para voltar sem perder o progresso (ISO). */
  graceEndsAt: string | null;
}

/** Nível correspondente a um tempo contínuo de assinatura. */
export function tierForDuration(ms: number): PlusTierId {
  let current: PlusTierId = 'wood';
  for (const id of TIER_IDS) {
    if (ms >= TIER_MIN_MONTHS[id] * MONTH_MS) current = id;
  }
  return current;
}

/**
 * Chegou a confirmação de que a assinatura está paga até `periodEndMs` (criação, renovação, volta depois de uma
 * falha). Devolve o novo estado. Eventos sem período futuro (reenvio de um evento antigo) não mudam nada.
 */
export function applyActive(state: StreakState | null, nowMs: number, periodEndMs: number): StreakState | null {
  if (!Number.isFinite(periodEndMs) || periodEndMs <= nowMs) return state;
  if (!state) {
    return { streakStartedMs: nowMs, countedMs: 0, segmentStartMs: nowMs, lastActiveEndMs: periodEndMs };
  }
  // Renovou a tempo: o trecho continua e só estende até onde está pago.
  if (nowMs <= state.lastActiveEndMs) {
    return { ...state, lastActiveEndMs: Math.max(state.lastActiveEndMs, periodEndMs) };
  }
  // Já tinha vencido. Voltou dentro da janela: fecha o trecho antigo (o buraco não conta) e abre outro.
  if (nowMs - state.lastActiveEndMs <= GRACE_MS) {
    return {
      streakStartedMs: state.streakStartedMs,
      countedMs: state.countedMs + Math.max(0, state.lastActiveEndMs - state.segmentStartMs),
      segmentStartMs: nowMs,
      lastActiveEndMs: periodEndMs,
    };
  }
  // Passou da janela: recomeça do zero.
  return { streakStartedMs: nowMs, countedMs: 0, segmentStartMs: nowMs, lastActiveEndMs: periodEndMs };
}

/** A assinatura acabou agora (cancelamento imediato): o pagamento deixa de cobrir o que ainda sobrava do período. */
export function applyEnded(state: StreakState | null, nowMs: number): StreakState | null {
  if (!state) return state;
  return { ...state, lastActiveEndMs: Math.min(state.lastActiveEndMs, nowMs) };
}

/** Tempo contínuo acumulado até `nowMs`, contando só o que já foi coberto por pagamento. */
export function continuousMs(state: StreakState, nowMs: number): number {
  const open = Math.max(0, Math.min(nowMs, state.lastActiveEndMs) - state.segmentStartMs);
  return state.countedMs + open;
}

/** O que mostrar agora para este estado. */
export function viewOf(state: StreakState | null, nowMs: number): StreakView {
  if (!state) return { phase: 'none', tier: null, days: 0, graceEndsAt: null };
  const ms = continuousMs(state, nowMs);
  const days = Math.floor(ms / DAY_MS);
  if (nowMs <= state.lastActiveEndMs) {
    return { phase: 'active', tier: tierForDuration(ms), days, graceEndsAt: null };
  }
  const graceEnd = state.lastActiveEndMs + GRACE_MS;
  if (nowMs <= graceEnd) {
    return { phase: 'grace', tier: tierForDuration(ms), days, graceEndsAt: new Date(graceEnd).toISOString() };
  }
  return { phase: 'none', tier: null, days: 0, graceEndsAt: null };
}
