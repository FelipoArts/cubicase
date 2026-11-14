// ============================================================
// Sequência de assinatura do Plus — leitura e gravação no Supabase
// ============================================================
// A regra mora em plus-tier.ts (funções puras). Aqui só se lê o estado, se aplica o evento e se grava de volta.
// Falha de rede nunca derruba o webhook do Stripe: quem chama segue em frente e o próximo evento corrige.
// ============================================================

import { supabaseService, type SupabaseEnv } from './supabase';
import { applyActive, applyEnded, type StreakState } from './plus-tier';

interface StreakRow {
  user_id: string;
  streak_started: string;
  counted_ms: number | string;
  segment_start: string;
  last_active_end: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toState(r: StreakRow): StreakState | null {
  const state: StreakState = {
    streakStartedMs: Date.parse(r.streak_started),
    countedMs: Number(r.counted_ms),
    segmentStartMs: Date.parse(r.segment_start),
    lastActiveEndMs: Date.parse(r.last_active_end),
  };
  return Object.values(state).every(Number.isFinite) ? state : null;
}

/** Estado de várias contas de uma vez (uma consulta). Quem não tem linha, ou tem linha inválida, fica de fora. */
export async function getStreaks(env: SupabaseEnv, userIds: string[]): Promise<Map<string, StreakState>> {
  const out = new Map<string, StreakState>();
  const ids = [...new Set(userIds)].filter((u) => UUID.test(u));
  if (ids.length === 0 || !env.SUPABASE_SERVICE_ROLE_KEY) return out;
  try {
    const resp = await supabaseService(
      env,
      `/rest/v1/plus_streaks?user_id=in.(${ids.join(',')})&select=user_id,streak_started,counted_ms,segment_start,last_active_end`,
    );
    if (!resp.ok) return out;
    const list: unknown = await resp.json().catch(() => []);
    if (!Array.isArray(list)) return out;
    for (const r of list as StreakRow[]) {
      const s = toState(r);
      if (s) out.set(r.user_id, s);
    }
  } catch { /* sem o estado, o badge cai no nível inicial */ }
  return out;
}

async function save(env: SupabaseEnv, userId: string, s: StreakState): Promise<void> {
  const resp = await supabaseService(env, '/rest/v1/plus_streaks?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      user_id: userId,
      streak_started: new Date(s.streakStartedMs).toISOString(),
      counted_ms: Math.max(0, Math.round(s.countedMs)),
      segment_start: new Date(s.segmentStartMs).toISOString(),
      last_active_end: new Date(s.lastActiveEndMs).toISOString(),
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!resp.ok) console.error('Falha ao gravar a sequência do Plus:', resp.status, await resp.text().catch(() => ''));
}

/** O Stripe confirmou que a assinatura está paga até `periodEndMs` (criação, renovação ou volta). */
export async function recordActive(env: SupabaseEnv, userId: string, periodEndMs: number, nowMs = Date.now()): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !UUID.test(userId)) return;
  try {
    const current = (await getStreaks(env, [userId])).get(userId) ?? null;
    const next = applyActive(current, nowMs, periodEndMs);
    if (next && next !== current) await save(env, userId, next);
  } catch (e) {
    console.error('Falha ao atualizar a sequência do Plus:', e);
  }
}

/** A assinatura foi encerrada (customer.subscription.deleted). */
export async function recordEnded(env: SupabaseEnv, userId: string, nowMs = Date.now()): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !UUID.test(userId)) return;
  try {
    const current = (await getStreaks(env, [userId])).get(userId) ?? null;
    const next = applyEnded(current, nowMs);
    if (next && next !== current) await save(env, userId, next);
  } catch (e) {
    console.error('Falha ao encerrar a sequência do Plus:', e);
  }
}
