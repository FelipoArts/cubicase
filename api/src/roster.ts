// ============================================================
// Lista de membros do servidor (Fase 2 do perfil do jogador)
// ============================================================
// A sala (link-room.ts) sabe quem está conectado e a conta de cada um (vinda do token que o Worker assinou). Aqui
// as contas viram perfil público + selo Plus, em lote. Quem não tem conta, ou tem conta mas nunca criou perfil,
// aparece sem perfil ("Convidado" no app). O `uid` NUNCA sai deste módulo: o cliente só recebe os campos públicos.
// ============================================================

import { chunk, supabaseService, type SupabaseEnv } from './supabase';
import { toPublic, withoutImages, type PublicProfile } from './profile';
import { getStreaks } from './plus-streak';
import { viewOf, type PlusTierId } from './plus-tier';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows<T>(resp: Response): Promise<T[]> {
  if (!resp.ok) return [];
  const data: unknown = await resp.json().catch(() => []);
  return Array.isArray(data) ? (data as T[]) : [];
}

/** Perfis públicos e Plus de várias contas de uma vez (duas consultas, não uma por pessoa). */
async function lookup(env: SupabaseEnv, uids: string[]): Promise<{ profiles: Map<string, PublicProfile>; plus: Set<string> }> {
  const profiles = new Map<string, PublicProfile>();
  const plus = new Set<string>();
  // Os uids vêm de claims assinadas pelo Worker, mas só entram na URL se forem UUID de verdade.
  const ids = [...new Set(uids)].filter((u) => UUID.test(u));
  if (ids.length === 0 || !env.SUPABASE_SERVICE_ROLE_KEY) return { profiles, plus };
  // Em blocos: com centenas de contas a URL passaria do limite e a consulta inteira falharia (ver chunk).
  const parts = await Promise.all(chunk(ids).map(async (part) => {
    const list = `in.(${part.join(',')})`;
    return Promise.all([
      rows<{ user_id: string; display_name: string; avatar_id: string; name_color: string | null; bio: string | null; avatar_hash: string | null; banner_hash: string | null }>(
        await supabaseService(env, `/rest/v1/profiles?user_id=${list}&select=user_id,display_name,avatar_id,name_color,bio,avatar_hash,banner_hash`),
      ),
      rows<{ user_id: string; status: string }>(
        await supabaseService(env, `/rest/v1/subscriptions?user_id=${list}&select=user_id,status`),
      ),
    ]);
  }));
  const profileRows = parts.flatMap((p) => p[0]);
  const subRows = parts.flatMap((p) => p[1]);
  for (const r of profileRows) profiles.set(r.user_id, toPublic(r));
  // Mesmos status que userHasActiveSubscription considera como Plus ativo.
  for (const r of subRows) if (r.status === 'active' || r.status === 'trialing') plus.add(r.user_id);
  return { profiles, plus };
}

/** O que se mostra de uma conta para os outros: o perfil público, se assina o Plus e o nível do badge. */
export interface PublicAccount {
  /** null: a conta nunca criou perfil. */
  profile: PublicProfile | null;
  /** Cubicase Plus ativo agora. Só conta para quem tem perfil público. */
  plus: boolean;
  tier: PlusTierId | null;
}

/** Perfis, Plus e nível de várias contas de uma vez (três consultas ao todo, não uma por pessoa). */
export async function resolveAccounts(env: SupabaseEnv, uids: string[], nowMs = Date.now()): Promise<Map<string, PublicAccount>> {
  const [{ profiles, plus }, streaks] = await Promise.all([lookup(env, uids), getStreaks(env, uids)]);
  const out = new Map<string, PublicAccount>();
  for (const uid of new Set(uids)) {
    const profile = profiles.get(uid) ?? null;
    const isPlus = !!(profile && plus.has(uid));
    // Sem registro de sequência (assinatura anterior ao badge, ou o webhook ainda não chegou): nível inicial.
    const view = isPlus ? viewOf(streaks.get(uid) ?? null, nowMs) : null;
    const tier: PlusTierId | null = isPlus ? (view?.phase === 'active' ? view.tier : 'wood') : null;
    // Foto e banner enviados só aparecem para os outros enquanto a conta assina o Plus.
    out.set(uid, { profile: profile && !isPlus ? withoutImages(profile) : profile, plus: isPlus, tier });
  }
  return out;
}
