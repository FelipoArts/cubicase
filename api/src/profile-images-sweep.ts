// ============================================================
// Limpeza diária das fotos e banners de quem ficou sem Plus por muito tempo
// ============================================================
// Foto e banner são do Plus: sem assinatura ficam guardados (e escondidos) para voltarem se a pessoa reassinar.
// Passados IMAGE_GRACE_DAYS do fim do Plus, o arquivo é apagado do R2 e o perfil perde a referência; ao
// reassinar, a pessoa envia de novo. Na dúvida (consulta falhou, dado estranho), NUNCA apaga.
// ============================================================

import { supabaseService } from './supabase';
import { purgeImage, type ImagesEnv } from './profile-images';

export const IMAGE_GRACE_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;
/** Contas olhadas por consulta, páginas por rodada e teto de contas limpas por rodada (a rodada é diária). */
const PAGE = 200;
const MAX_PAGES = 5;
const MAX_CLEARED = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Candidate { user_id: string; avatar_hash: string | null; banner_hash: string | null; images_updated_at: string | null }

/** A rotina agendada roda a cada 5 minutos; a limpeza vale só na janela das 03:00 UTC (uma vez por dia, sem gravar nada no KV). */
export function isSweepTime(scheduledMs: number): boolean {
  const d = new Date(scheduledMs);
  return d.getUTCHours() === 3 && d.getUTCMinutes() < 5;
}

export async function getJson<T>(env: ImagesEnv, path: string): Promise<T[] | null> {
  const resp = await supabaseService(env, path);
  if (!resp.ok) return null;
  const list: unknown = await resp.json().catch(() => null);
  return Array.isArray(list) ? (list as T[]) : null;
}

/**
 * Quando o Plus da conta acabou de vez: o mais tarde entre o fim do último período pago e o fim da sequência.
 * Sem nenhum dos dois (conta anterior a esses registros), vale `fallbackMs` (a data do último envio de imagem).
 * null: não dá para saber, então não se mexe.
 */
function plusEndedAt(sub: { current_period_end: string | null } | undefined, streak: { last_active_end: string | null } | undefined, fallbackMs: number | null): number | null {
  const times = [sub?.current_period_end, streak?.last_active_end].map((s) => (s ? Date.parse(s) : NaN)).filter(Number.isFinite);
  if (times.length) return Math.max(...times);
  return fallbackMs !== null && Number.isFinite(fallbackMs) ? fallbackMs : null;
}

export interface AccountToCheck { uid: string; fallbackMs: number | null }

/**
 * Quais destas contas estão sem Plus há mais de IMAGE_GRACE_DAYS. `null` se não deu para ler as assinaturas ou as
 * sequências: quem chama NÃO apaga nada nesse caso (na dúvida, nunca apaga).
 */
export async function staleAccounts(env: ImagesEnv, accounts: AccountToCheck[], nowMs: number): Promise<Set<string> | null> {
  const stale = new Set<string>();
  const valid = accounts.filter((a) => UUID.test(a.uid));
  if (valid.length === 0) return stale;
  const list = [...new Set(valid.map((a) => a.uid))].join(',');
  const subs = await getJson<{ user_id: string; status: string; current_period_end: string | null }>(env, `/rest/v1/subscriptions?user_id=in.(${list})&select=user_id,status,current_period_end`);
  const streaks = await getJson<{ user_id: string; last_active_end: string | null }>(env, `/rest/v1/plus_streaks?user_id=in.(${list})&select=user_id,last_active_end`);
  if (!subs || !streaks) return null;
  const subOf = new Map(subs.map((s) => [s.user_id, s]));
  const streakOf = new Map(streaks.map((s) => [s.user_id, s]));
  const limit = nowMs - IMAGE_GRACE_DAYS * DAY_MS;
  for (const a of valid) {
    const sub = subOf.get(a.uid);
    if (sub?.status === 'active' || sub?.status === 'trialing') continue;
    const ended = plusEndedAt(sub, streakOf.get(a.uid), a.fallbackMs);
    if (ended !== null && ended <= limit) stale.add(a.uid);
  }
  return stale;
}

export async function sweepStaleImages(env: ImagesEnv, nowMs = Date.now()): Promise<{ checked: number; cleared: number }> {
  const out = { checked: 0, cleared: 0 };
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.PROFILE_IMAGES) return out;
  for (let page = 0; page < MAX_PAGES && out.cleared < MAX_CLEARED; page++) {
    const people = await getJson<Candidate>(
      env,
      `/rest/v1/profiles?or=(avatar_hash.not.is.null,banner_hash.not.is.null)&select=user_id,avatar_hash,banner_hash,images_updated_at&order=user_id&limit=${PAGE}&offset=${page * PAGE}`,
    );
    if (!people || people.length === 0) break;
    const valid = people.filter((p) => UUID.test(p.user_id));
    out.checked += valid.length;
    const stale = await staleAccounts(env, valid.map((p) => ({ uid: p.user_id, fallbackMs: p.images_updated_at ? Date.parse(p.images_updated_at) : null })), nowMs);
    if (!stale) return out; // sem os dados, não dá para saber quem ainda assina: não apaga nada
    for (const c of valid) {
      if (out.cleared >= MAX_CLEARED) break;
      if (!stale.has(c.user_id)) continue;
      const resp = await supabaseService(env, `/rest/v1/profiles?user_id=eq.${c.user_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ avatar_hash: null, banner_hash: null, updated_at: new Date(nowMs).toISOString() }),
      });
      if (!resp.ok) continue;
      out.cleared++;
      for (const hash of [c.avatar_hash, c.banner_hash]) await purgeImage(env, hash); // só apaga se nenhum outro perfil usa
    }
    if (people.length < PAGE) break;
  }
  return out;
}
