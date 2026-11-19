// ============================================================
// Contas no painel do dono: busca, ficha e ações
// ============================================================
// Tudo roda com a service role, só depois de o admin.ts conferir o ADMIN_TOKEN. Cada ação que muda algo deixa uma linha
// no registro (admin-audit.ts). Regras de segurança:
//  - dar Plus "de cortesia" cria uma linha `manual_admin_<id>` em `subscriptions`; nunca mexe numa assinatura real
//    (Stripe): quem tem cobrança de verdade se resolve no Stripe, senão o Worker e o Stripe ficariam em desacordo;
//  - tirar Plus só vale para cortesia (`manual_*`), pelo mesmo motivo.
// ============================================================

import { supabaseService, type SupabaseEnv } from './supabase';
import { purgeImage, type ImagesEnv } from './profile-images';
import { recordAudit, type AuditEnv } from './admin-audit';

export type AccountsEnv = SupabaseEnv & AuditEnv & { PROFILE_IMAGES?: R2Bucket };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACCOUNT_ACTIONS = ['grant_plus', 'revoke_plus', 'clear_images', 'clear_bio', 'rename'] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

interface AuthUser { id: string; email?: string; created_at: string; last_sign_in_at?: string | null; app_metadata?: { provider?: string } }

async function rows<T>(resp: Response): Promise<T[]> {
  if (!resp.ok) return [];
  const data: unknown = await resp.json().catch(() => []);
  return Array.isArray(data) ? (data as T[]) : [];
}

async function allUsers(env: SupabaseEnv): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await supabaseService(env, `/auth/v1/admin/users?page=${page}&per_page=1000`);
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    const body = (await res.json()) as { users?: AuthUser[] };
    users.push(...(body.users ?? []));
    if ((body.users ?? []).length < 1000) break;
  }
  return users;
}

/** Só letras, números e poucos símbolos entram na busca por nome (nada que vire filtro do PostgREST). */
function safeTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 60);
}

export interface AccountHit { id: string; email: string; displayName: string | null; createdAt: string; lastSignIn: string | null }

export async function searchAccounts(env: SupabaseEnv, rawQuery: string): Promise<AccountHit[]> {
  const q = safeTerm(rawQuery);
  if (q.length < 2) return [];
  const needle = q.toLowerCase();
  const users = await allUsers(env);
  const byId = new Map(users.map((u) => [u.id, u]));
  const ids = new Set<string>();
  for (const u of users) if ((u.email ?? '').toLowerCase().includes(needle) || u.id.toLowerCase() === needle) ids.add(u.id);
  const named = await rows<{ user_id: string }>(await supabaseService(env, `/rest/v1/profiles?or=(display_name.ilike.*${encodeURIComponent(q)}*,handle.ilike.*${encodeURIComponent(q)}*)&select=user_id&limit=20`));
  for (const n of named) if (byId.has(n.user_id)) ids.add(n.user_id);
  const picked = [...ids].slice(0, 20);
  if (!picked.length) return [];
  const profiles = await rows<{ user_id: string; display_name: string }>(await supabaseService(env, `/rest/v1/profiles?user_id=in.(${picked.join(',')})&select=user_id,display_name`));
  const nameOf = new Map(profiles.map((p) => [p.user_id, p.display_name]));
  return picked.map((id) => {
    const u = byId.get(id)!;
    return { id, email: u.email ?? '(sem e-mail)', displayName: nameOf.get(id) ?? null, createdAt: u.created_at, lastSignIn: u.last_sign_in_at ?? null };
  });
}

export interface AccountDetail {
  id: string;
  email: string;
  provider: string;
  createdAt: string;
  lastSignIn: string | null;
  profile: { displayName: string; handle: string | null; bio: string | null; avatarHash: string | null; bannerHash: string | null } | null;
  subscription: { plan: string; status: string; periodEnd: string | null; cancelAtPeriodEnd: boolean; manual: boolean } | null;
  streak: { startedAt: string; lastActiveEnd: string } | null;
  devices: { name: string; createdAt: string; lastSeenAt: string | null }[];
  servers: { shortCode: string; role: string }[];
  reports: { open: number; total: number };
}

export async function getAccount(env: SupabaseEnv, id: string): Promise<AccountDetail | null> {
  if (!UUID.test(id)) return null;
  const userRes = await supabaseService(env, `/auth/v1/admin/users/${id}`);
  if (!userRes.ok) return null;
  const u = (await userRes.json()) as AuthUser;
  const [profile, sub, streak, devices, servers, reports] = await Promise.all([
    supabaseService(env, `/rest/v1/profiles?user_id=eq.${id}&select=display_name,handle,bio,avatar_hash,banner_hash`).then((r) => rows<any>(r)),
    supabaseService(env, `/rest/v1/subscriptions?user_id=eq.${id}&select=plan,status,current_period_end,cancel_at_period_end,stripe_customer_id`).then((r) => rows<any>(r)),
    supabaseService(env, `/rest/v1/plus_streaks?user_id=eq.${id}&select=streak_started,last_active_end`).then((r) => rows<any>(r)),
    supabaseService(env, `/rest/v1/panel_devices?user_id=eq.${id}&select=device_name,created_at,last_seen_at&order=created_at.desc&limit=50`).then((r) => rows<any>(r)),
    supabaseService(env, `/rest/v1/server_members?user_id=eq.${id}&select=server_short_code,role&limit=100`).then((r) => rows<any>(r)),
    supabaseService(env, `/rest/v1/profile_reports?target_id=eq.${id}&select=status&limit=500`).then((r) => rows<{ status: string }>(r)),
  ]);
  const p = profile[0], s = sub[0], k = streak[0];
  return {
    id,
    email: u.email ?? '(sem e-mail)',
    provider: u.app_metadata?.provider ?? '?',
    createdAt: u.created_at,
    lastSignIn: u.last_sign_in_at ?? null,
    profile: p ? { displayName: p.display_name, handle: p.handle ?? null, bio: p.bio ?? null, avatarHash: p.avatar_hash ?? null, bannerHash: p.banner_hash ?? null } : null,
    subscription: s ? { plan: s.plan, status: s.status, periodEnd: s.current_period_end ?? null, cancelAtPeriodEnd: !!s.cancel_at_period_end, manual: String(s.stripe_customer_id ?? '').startsWith('manual_') } : null,
    streak: k ? { startedAt: k.streak_started, lastActiveEnd: k.last_active_end } : null,
    devices: devices.map((d) => ({ name: d.device_name, createdAt: d.created_at, lastSeenAt: d.last_seen_at ?? null })),
    servers: servers.map((m) => ({ shortCode: m.server_short_code, role: m.role })),
    reports: { open: reports.filter((r) => r.status === 'open').length, total: reports.length },
  };
}

export type ActionResult = { ok: true; message: string } | { ok: false; status: number; message: string };

export async function applyAccountAction(env: AccountsEnv, id: string, action: unknown, nowMs = Date.now()): Promise<ActionResult> {
  if (!UUID.test(id)) return { ok: false, status: 400, message: 'Identificador inválido.' };
  if (typeof action !== 'string' || !(ACCOUNT_ACTIONS as readonly string[]).includes(action)) return { ok: false, status: 400, message: 'Ação inválida.' };
  const acc = await getAccount(env, id);
  if (!acc) return { ok: false, status: 404, message: 'Conta não encontrada.' };
  const label = acc.email;
  const done = async (message: string, detail?: string): Promise<ActionResult> => {
    await recordAudit(env, { action, target: id, label, detail }, nowMs).catch((e) => console.error('[admin] registro de ação falhou:', e));
    return { ok: true, message };
  };
  const patchProfile = (body: Record<string, unknown>) => supabaseService(env, `/rest/v1/profiles?user_id=eq.${id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...body, updated_at: new Date(nowMs).toISOString() }),
  });

  if (action === 'grant_plus') {
    if (acc.subscription && !acc.subscription.manual) return { ok: false, status: 409, message: 'Esta conta tem assinatura real (Stripe). Resolva pelo Stripe.' };
    if (acc.subscription?.status === 'active') return { ok: false, status: 409, message: 'Esta conta já tem Plus de cortesia.' };
    const resp = await supabaseService(env, '/rest/v1/subscriptions?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: id, stripe_customer_id: `manual_admin_${id}`, stripe_subscription_id: null, plan: 'annual', status: 'active', current_period_end: null, cancel_at_period_end: false, updated_at: new Date(nowMs).toISOString() }]),
    });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não consegui dar o Plus.' };
    return done('Plus de cortesia ativado.');
  }
  if (action === 'revoke_plus') {
    if (!acc.subscription) return { ok: false, status: 409, message: 'Esta conta não tem assinatura.' };
    if (!acc.subscription.manual) return { ok: false, status: 409, message: 'Esta assinatura é real (Stripe): cancele pelo Stripe.' };
    const resp = await supabaseService(env, `/rest/v1/subscriptions?user_id=eq.${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'canceled', updated_at: new Date(nowMs).toISOString() }),
    });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não consegui tirar o Plus.' };
    return done('Plus de cortesia removido.');
  }
  if (!acc.profile) return { ok: false, status: 409, message: 'Esta conta ainda não tem perfil.' };
  if (action === 'clear_images') {
    const resp = await patchProfile({ avatar_hash: null, banner_hash: null });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não consegui remover as imagens.' };
    if (env.PROFILE_IMAGES) for (const h of [acc.profile.avatarHash, acc.profile.bannerHash]) await purgeImage(env as ImagesEnv, h, true);
    return done('Imagens removidas.');
  }
  if (action === 'clear_bio') {
    const resp = await patchProfile({ bio: null });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não consegui remover a bio.' };
    return done('Bio removida.');
  }
  const suffix = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const resp = await patchProfile({ display_name: `Jogador-${suffix}` });
  if (!resp.ok) return { ok: false, status: 502, message: 'Não consegui trocar o nome.' };
  return done('Nome trocado.', `antes: ${acc.profile.displayName}`);
}
