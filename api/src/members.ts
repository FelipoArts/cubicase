// ============================================================
// Membros do servidor: quem adicionou o servidor, com quem está conectado em destaque
// ============================================================
// "Membro" é uma CONTA que adicionou o servidor à biblioteca (ou é o anfitrião dele). Quem usa o Cubicase sem conta
// não entra na lista, e continua podendo entrar e jogar normalmente. A lista só é visível para os próprios membros.
//
// Tabela server_members (scripts/supabase-server-members.sql): RLS ligado e sem policies, só o Worker (service role)
// lê e escreve. O "online" vem da sala de sinalização (a conta de quem está conectado agora), sem gravar nada no KV.
// O `uid` nunca sai daqui: cada membro sai com um id opaco, derivado do código do servidor e da conta.
// ============================================================

import { resolveSupabaseUser, supabaseService, type SupabaseEnv, type SupabaseUser } from './supabase';
import { resolveAccounts, type PublicAccount } from './roster';
import type { PublicProfile } from './profile';
import type { PlusTierId } from './plus-tier';
import type { PanelResult } from './panel-members';

export interface MembersEnv extends SupabaseEnv {
  CUBEFORGE_REGISTRY: KVNamespace;
  LINK_ROOM: DurableObjectNamespace;
  /** Webhook do Discord (canal só do dono): avisa que chegou uma denúncia de perfil. */
  ADMIN_DISCORD_WEBHOOK?: string;
}

export interface MembersDeps {
  env: MembersEnv;
  /** Quem está conectado à sala agora. Injetável nos testes; o padrão pergunta à sala (Durable Object). */
  online?: (shortCode: string) => Promise<OnlineNow>;
}

/** Conectados agora: as contas (para marcar os membros) e quantos entraram sem conta (só um número). */
export interface OnlineNow {
  uids: Set<string>;
  anonymous: number;
}

export interface ServerMember {
  /** Id opaco (não é a conta). */
  id: string;
  role: 'host' | 'member';
  self: boolean;
  /** Conectado ao servidor agora. */
  online: boolean;
  profile: PublicProfile | null;
  plus: boolean;
  tier: PlusTierId | null;
}

/** Teto de membros por servidor (rede de proteção; não é um número que se espere alcançar). */
export const MAX_MEMBERS = 500;
const MAX_BULK = 100;
/** Denúncias por conta em 24 horas (evita usar o botão para perseguir alguém ou entupir o painel). */
export const MAX_REPORTS_PER_DAY = 10;
const REPORT_REASONS = ['image', 'name_or_bio', 'other'] as const;
const REASON_LABEL: Record<(typeof REPORT_REASONS)[number], string> = { image: 'imagem', name_or_bio: 'nome ou bio', other: 'outro motivo' };
const CODE = /^[A-Za-z0-9]{3,12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const res = (status: number, code: string, message: string, data?: unknown): PanelResult => ({ status, code, message, data });
const OK = (message: string, data?: unknown) => res(200, 'SUCCESS', message, data);
const UNAUTHORIZED = res(401, 'BAD_REQUEST', 'Sessão inválida ou expirada. Faça login novamente.');
const NOT_CONFIGURED = res(503, 'INTERNAL_ERROR', 'Membros não configurados neste servidor.');
const NOT_FOUND = res(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
const enc = encodeURIComponent;

async function rows<T>(resp: Response): Promise<T[]> {
  if (!resp.ok) return [];
  const data: unknown = await resp.json().catch(() => []);
  return Array.isArray(data) ? (data as T[]) : [];
}

async function serverExists(env: MembersEnv, shortCode: string): Promise<boolean> {
  return !!(await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`));
}

/** Contas conectadas à sala agora (a sala só devolve o que sabe: quem entrou com conta). */
async function onlineFromRoom(env: MembersEnv, shortCode: string): Promise<OnlineNow> {
  try {
    const room = env.LINK_ROOM.get(env.LINK_ROOM.idFromName(shortCode));
    const resp = await room.fetch('https://link-room.internal/online');
    const body: any = await resp.json().catch(() => null);
    return {
      uids: new Set(Array.isArray(body?.uids) ? body.uids.filter((u: unknown): u is string => typeof u === 'string') : []),
      anonymous: Number.isInteger(body?.anonymous) && body.anonymous > 0 ? body.anonymous : 0,
    };
  } catch {
    return { uids: new Set(), anonymous: 0 };
  }
}

async function opaqueId(shortCode: string, uid: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`member:${shortCode}:${uid}`));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface MemberRow { user_id: string; role: 'host' | 'member'; created_at: string }

async function listRows(env: MembersEnv, shortCode: string): Promise<MemberRow[]> {
  return rows<MemberRow>(await supabaseService(
    env,
    `/rest/v1/server_members?server_short_code=eq.${enc(shortCode)}&select=user_id,role,created_at&order=created_at.asc&limit=${MAX_MEMBERS}`,
  ));
}

async function countMembers(env: MembersEnv, shortCode: string): Promise<number> {
  const resp = await supabaseService(env, `/rest/v1/server_members?server_short_code=eq.${enc(shortCode)}&select=user_id&limit=1`, {
    headers: { Prefer: 'count=exact' },
  });
  const range = resp.headers.get('content-range'); // "0-0/37" ou "*/0"
  const total = Number(range?.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

/** Avisa o dono no Discord (se o webhook estiver configurado). Sem nenhum dado pessoal: o detalhe fica no painel. */
async function notifyReport(env: MembersEnv, reason: (typeof REPORT_REASONS)[number]): Promise<void> {
  if (!env.ADMIN_DISCORD_WEBHOOK) return;
  try {
    await fetch(env.ADMIN_DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Cubicase — denúncias', content: `🚩 Nova denúncia de perfil (${REASON_LABEL[reason]}). Veja e decida no painel: /admin` }),
    });
  } catch { /* o aviso é um extra: a denúncia já está guardada */ }
}

/** Entra como membro. Não rebaixa o anfitrião (ignora linha que já existe). */
async function addMember(env: MembersEnv, shortCode: string, userId: string): Promise<boolean> {
  const resp = await supabaseService(env, '/rest/v1/server_members?on_conflict=server_short_code,user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify([{ server_short_code: shortCode, user_id: userId, role: 'member' }]),
  });
  return resp.ok;
}

/**
 * O dono abriu o servidor com a conta logada: ele passa a ser o anfitrião na lista (e quem era antes volta a ser
 * membro). Best-effort: nunca atrapalha a criação da sessão.
 */
export async function recordHost(env: SupabaseEnv, shortCode: string, userId: string): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !UUID.test(userId)) return;
  try {
    await supabaseService(env, `/rest/v1/server_members?server_short_code=eq.${enc(shortCode)}&role=eq.host&user_id=neq.${enc(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ role: 'member' }),
    });
    await supabaseService(env, '/rest/v1/server_members?on_conflict=server_short_code,user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ server_short_code: shortCode, user_id: userId, role: 'host' }]),
    });
  } catch (e) {
    console.error('Falha ao registrar o anfitrião nos membros:', e);
  }
}

/** O servidor foi apagado: some a lista de membros dele. Best-effort. */
export async function deleteServerMembers(env: SupabaseEnv, shortCode: string): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await supabaseService(env, `/rest/v1/server_members?server_short_code=eq.${enc(shortCode)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  } catch (e) {
    console.error('Falha ao apagar os membros do servidor:', e);
  }
}

export async function handleMembersRoute(req: Request, deps: MembersDeps, method: string, path: string): Promise<PanelResult | null> {
  const { env } = deps;

  const bulk = path === '/api/v1/memberships' && method === 'PUT';
  const mine = path.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/members\/me$/);
  const list = path.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/members$/);
  const report = path.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/members\/([a-f0-9]{12})\/report$/);
  if (!bulk && !(mine && (method === 'POST' || method === 'DELETE')) && !(list && method === 'GET') && !(report && method === 'POST')) return null;

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return NOT_CONFIGURED;
  const user: SupabaseUser | null = await resolveSupabaseUser(req);
  if (!user) return UNAUTHORIZED;

  // PUT /api/v1/memberships — a conta registra de uma vez os servidores que já tem na biblioteca (ao entrar no app)
  if (bulk) {
    const body: any = await req.json().catch(() => null);
    const codes: unknown = body?.shortCodes;
    if (!Array.isArray(codes) || codes.length > MAX_BULK) return res(400, 'BAD_REQUEST', `Envie de 0 a ${MAX_BULK} códigos.`);
    const unique = [...new Set(codes.filter((c): c is string => typeof c === 'string' && CODE.test(c)).map((c) => c.toUpperCase()))];
    let added = 0;
    for (const code of unique) {
      if (!(await serverExists(env, code))) continue; // código que não existe mais: ignora
      if ((await countMembers(env, code)) >= MAX_MEMBERS) continue;
      if (await addMember(env, code, user.id)) added++;
    }
    return OK('Servidores registrados.', { added });
  }

  if (mine) {
    const code = mine[1].toUpperCase();
    // POST — adicionou o servidor
    if (method === 'POST') {
      if (!(await serverExists(env, code))) return NOT_FOUND;
      if ((await countMembers(env, code)) >= MAX_MEMBERS) return res(409, 'CONFLICT', 'Este servidor já tem o máximo de membros.');
      if (!(await addMember(env, code, user.id))) return res(502, 'INTERNAL_ERROR', 'Não foi possível entrar na lista de membros.');
      return OK('Você é membro deste servidor.');
    }
    // DELETE — removeu o servidor. O anfitrião não sai da lista por esta rota (só se o servidor for apagado).
    const resp = await supabaseService(env, `/rest/v1/server_members?server_short_code=eq.${enc(code)}&user_id=eq.${enc(user.id)}&role=eq.member`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível sair da lista de membros.');
    return OK('Você saiu da lista de membros.');
  }

  // POST /api/v1/servers/{sc}/members/{id}/report — denunciar o perfil de outro membro (só quem também é membro)
  if (report) {
    const code = report[1].toUpperCase();
    const body: any = await req.json().catch(() => null);
    const reason = REPORT_REASONS.find((r) => r === body?.reason);
    if (!reason) return res(400, 'BAD_REQUEST', 'Motivo inválido.');
    const note = typeof body?.note === 'string' ? body.note.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';

    const all = await listRows(env, code);
    if (!all.some((r) => r.user_id === user.id)) return res(403, 'FORBIDDEN', 'Só quem é membro do servidor pode denunciar.');
    let target: MemberRow | undefined;
    for (const r of all) { if ((await opaqueId(code, r.user_id)) === report[2]) { target = r; break; } }
    if (!target) return NOT_FOUND;
    if (target.user_id === user.id) return res(400, 'BAD_REQUEST', 'Você não pode denunciar o próprio perfil.');

    // Já há uma denúncia aberta sua contra esta pessoa: não duplica (e não conta no limite do dia)
    const open = await rows<{ id: string }>(await supabaseService(env, `/rest/v1/profile_reports?reporter_id=eq.${enc(user.id)}&target_id=eq.${enc(target.user_id)}&status=eq.open&select=id&limit=1`));
    if (open.length > 0) return OK('Denúncia enviada.');

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const countResp = await supabaseService(env, `/rest/v1/profile_reports?reporter_id=eq.${enc(user.id)}&created_at=gte.${enc(since)}&select=id&limit=1`, { headers: { Prefer: 'count=exact' } });
    const sent = Number(countResp.headers.get('content-range')?.split('/')[1]);
    if (Number.isFinite(sent) && sent >= MAX_REPORTS_PER_DAY) return res(429, 'RATE_LIMITED', 'Muitas denúncias hoje. Tente novamente amanhã.');

    const insert = await supabaseService(env, '/rest/v1/profile_reports', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ reporter_id: user.id, target_id: target.user_id, server_short_code: code, reason, note: note || null }),
    });
    if (!insert.ok && insert.status !== 409) return res(502, 'INTERNAL_ERROR', 'Não foi possível enviar a denúncia.');
    await notifyReport(env, reason);
    return OK('Denúncia enviada.');
  }

  // GET /api/v1/servers/{sc}/members — só para quem é membro
  const code = list![1].toUpperCase();
  const all = await listRows(env, code);
  if (!all.some((r) => r.user_id === user.id)) {
    return res(403, 'FORBIDDEN', 'Só quem é membro do servidor vê a lista.');
  }
  const uids = all.map((r) => r.user_id);
  const [accounts, online] = await Promise.all([
    resolveAccounts(env, uids),
    (deps.online ?? ((c) => onlineFromRoom(env, c)))(code),
  ]);

  const members: ServerMember[] = await Promise.all(all.map(async (r) => {
    const a: PublicAccount | undefined = accounts.get(r.user_id);
    return {
      id: await opaqueId(code, r.user_id),
      role: r.role,
      self: r.user_id === user.id,
      online: online.uids.has(r.user_id),
      profile: a?.profile ?? null,
      plus: a?.plus ?? false,
      tier: a?.tier ?? null,
    };
  }));
  // Anfitrião primeiro; depois quem está conectado; depois a ordem de entrada (já vem assim do banco).
  const rank = (m: ServerMember) => (m.role === 'host' ? 0 : m.online ? 1 : 2);
  members.sort((a, b) => rank(a) - rank(b));
  return OK('Membros.', {
    members,
    total: members.length,
    onlineCount: members.filter((m) => m.online).length,
    // Quem está conectado sem conta não aparece na lista (não é membro), mas conta como gente no servidor.
    anonymousOnline: online.anonymous,
  });
}
