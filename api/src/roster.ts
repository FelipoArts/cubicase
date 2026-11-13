// ============================================================
// Lista de membros do servidor (Fase 2 do perfil do jogador)
// ============================================================
// A sala (link-room.ts) sabe quem está conectado e a conta de cada um (vinda do token que o Worker assinou). Aqui
// as contas viram perfil público + selo Plus, em lote. Quem não tem conta, ou tem conta mas nunca criou perfil,
// aparece sem perfil ("Convidado" no app). O `uid` NUNCA sai deste módulo: o cliente só recebe os campos públicos.
// ============================================================

import { supabaseService, type SupabaseEnv } from './supabase';
import { toPublic, type PublicProfile } from './profile';
import type { RoomMember } from './durable-objects/link-room';

export interface RosterMember {
  /** "host" ou o guestId atribuído pela sala. */
  id: string;
  role: 'host' | 'guest';
  /** É quem pediu a lista. */
  self: boolean;
  /** null: sem conta ou sem perfil criado. */
  profile: PublicProfile | null;
  /** Cubicase Plus ativo agora. Só aparece para quem tem perfil público. */
  plus: boolean;
}

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
  const list = `in.(${ids.join(',')})`;

  const [profileRows, subRows] = await Promise.all([
    rows<{ user_id: string; display_name: string; avatar_id: string; name_color: string | null }>(
      await supabaseService(env, `/rest/v1/profiles?user_id=${list}&select=user_id,display_name,avatar_id,name_color`),
    ),
    rows<{ user_id: string; status: string }>(
      await supabaseService(env, `/rest/v1/subscriptions?user_id=${list}&select=user_id,status`),
    ),
  ]);
  for (const r of profileRows) profiles.set(r.user_id, toPublic(r));
  // Mesmos status que userHasActiveSubscription considera como Plus ativo.
  for (const r of subRows) if (r.status === 'active' || r.status === 'trialing') plus.add(r.user_id);
  return { profiles, plus };
}

/** Junta os membros da sala com os perfis públicos. Host primeiro, depois os convidados na ordem da sala. */
export async function buildRoster(env: SupabaseEnv, members: RoomMember[]): Promise<RosterMember[]> {
  const { profiles, plus } = await lookup(env, members.flatMap((m) => (m.uid ? [m.uid] : [])));
  const out: RosterMember[] = members.map((m) => {
    const profile = m.uid ? profiles.get(m.uid) ?? null : null;
    return { id: m.id, role: m.role, self: m.self, profile, plus: !!(profile && m.uid && plus.has(m.uid)) };
  });
  return out.sort((a, b) => (a.role === b.role ? 0 : a.role === 'host' ? -1 : 1));
}
