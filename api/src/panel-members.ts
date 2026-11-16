// ============================================================
// Painel web remoto — acesso compartilhado (membros, convites, ticket)
// ============================================================
// Endpoints REST do Worker para o dono de um dispositivo dar acesso (ver,
// ligar, desligar, reiniciar, rodar comandos) a outras contas, e para essas
// contas aceitarem o convite. A APLICAÇÃO das permissões acontece no Durable
// Object (host-channel.ts), a cada mensagem; aqui só se decide quem entra e
// com o quê. Toda leitura/escrita usa a service role (as tabelas têm RLS
// ligado sem policies — ver scripts/supabase-panel-members.sql).
//
// Este módulo não conhece json()/ok()/fail() do index.ts (evita import
// circular): devolve um PanelResult simples e o roteador em index.ts embrulha.
// ============================================================

import {
  inviteUsable,
  generateInviteToken,
  normalizePermissions,
  OWNER_PERMISSIONS,
  type PanelPermissions,
} from './panel-access';
import { sendInviteEmail, inviteMailConfigured, type InviteMailEnv } from './panel-invite-mail';
import {
  resolveSupabaseUser,
  supabaseService,
  userHasActiveSubscription,
  type SupabaseEnv,
  type SupabaseUser,
} from './supabase';

export interface PanelEnv extends SupabaseEnv, InviteMailEnv {
  HOST_CHANNEL: DurableObjectNamespace;
}

export interface PanelResult {
  status: number;
  code: string;
  message: string;
  data?: unknown;
}

export interface PanelDeps {
  env: PanelEnv;
  /** Rate limit por chave (KV do index.ts) — true se ainda dentro do limite. */
  rateLimit: (bucket: string, key: string, limit: number) => Promise<boolean>;
}

const MAX_MEMBERS_AND_INVITES_PER_DEVICE = 25;
const INVITE_RATE_LIMIT = 10; // por dono/min — inclui as tentativas de e-mail inexistente (ver comentário em createInvite)
const EMAIL_INVITE_TTL_HOURS = 14 * 24;
const DEFAULT_LINK_TTL_HOURS = 7 * 24;
const MAX_LINK_TTL_HOURS = 30 * 24;

const res = (status: number, code: string, message: string, data?: unknown): PanelResult => ({ status, code, message, data });
const OK = (message: string, data?: unknown) => res(200, 'SUCCESS', message, data);
const UNAUTHORIZED = res(401, 'BAD_REQUEST', 'Sessão inválida ou expirada. Faça login novamente.');
const NOT_CONFIGURED = res(503, 'INTERNAL_ERROR', 'Painel web não configurado neste servidor.');
const DEVICE_NOT_FOUND = res(404, 'SERVER_NOT_FOUND', 'Dispositivo não encontrado para este usuário.');

interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  last_seen_at: string | null;
  created_at?: string;
}

interface InviteRow {
  id: string;
  device_id: string;
  kind: 'email' | 'link';
  token: string | null;
  target_user_id: string | null;
  permissions: unknown;
  single_use: boolean;
  uses: number;
  expires_at: string;
  created_by: string;
  created_at: string;
}

const enc = encodeURIComponent;

async function rows<T>(resp: Response): Promise<T[]> {
  if (!resp.ok) return [];
  const data = await resp.json().catch(() => []);
  return Array.isArray(data) ? (data as T[]) : [];
}

async function getDevice(env: PanelEnv, deviceId: string): Promise<DeviceRow | null> {
  const list = await rows<DeviceRow>(
    await supabaseService(env, `/rest/v1/panel_devices?id=eq.${enc(deviceId)}&select=id,user_id,device_name,last_seen_at`)
  );
  return list[0] ?? null;
}

async function getMemberPermissions(env: PanelEnv, deviceId: string, userId: string): Promise<{ found: boolean; permissions: PanelPermissions | null }> {
  const list = await rows<{ permissions: unknown }>(
    await supabaseService(env, `/rest/v1/panel_device_members?device_id=eq.${enc(deviceId)}&user_id=eq.${enc(userId)}&select=permissions`)
  );
  if (list.length === 0) return { found: false, permissions: null };
  return { found: true, permissions: normalizePermissions(list[0].permissions) };
}

async function userInfo(env: PanelEnv, ids: string[]): Promise<Map<string, { email: string | null; name: string | null }>> {
  const map = new Map<string, { email: string | null; name: string | null }>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const list = await rows<{ id: string; email: string | null; name: string | null }>(
    await supabaseService(env, '/rest/v1/rpc/panel_user_info', { method: 'POST', body: JSON.stringify({ p_ids: unique }) })
  );
  for (const u of list) map.set(u.id, { email: u.email, name: u.name });
  return map;
}

function labelOf(info: { email: string | null; name: string | null } | undefined): string {
  return info?.name || info?.email || 'Conta removida';
}

/** Avisa o Durable Object pra derrubar as conexões de um membro (ele reconecta já com as permissões novas — ou é barrado, se foi removido). */
async function kickMember(env: PanelEnv, deviceId: string, userId: string, removed: boolean): Promise<void> {
  try {
    const stub = env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
    await stub.fetch('https://host-channel.internal/kick', {
      method: 'POST',
      body: JSON.stringify({ userId, removed }),
    });
  } catch {
    // Best-effort: se o DO não respondeu, o membro removido ainda é barrado
    // no próximo ticket (resolvePanelAccess), só não é derrubado na hora.
  }
}

// ------------------------------------------------------------
// Acesso a um dispositivo (usado pelo ticket do WebSocket)
// ------------------------------------------------------------

type AccessResult =
  | { ok: true; isOwner: boolean; permissions: PanelPermissions }
  | { ok: false; result: PanelResult };

/** Dono (com Plus ativo) ou membro (o dono é quem precisa ter Plus ativo, não o membro). */
export async function resolvePanelAccess(env: PanelEnv, user: SupabaseUser, deviceId: string): Promise<AccessResult> {
  const device = await getDevice(env, deviceId);
  if (!device) return { ok: false, result: DEVICE_NOT_FOUND };

  if (device.user_id === user.id) {
    if (!(await userHasActiveSubscription(env, user.id))) {
      return { ok: false, result: res(402, 'SUBSCRIPTION_REQUIRED', 'O painel web remoto é um recurso do Cubicase Plus.') };
    }
    return { ok: true, isOwner: true, permissions: OWNER_PERMISSIONS };
  }

  const member = await getMemberPermissions(env, deviceId, user.id);
  // Mesma resposta de "não existe" pra quem não tem acesso — não confirma
  // que aquele id de dispositivo existe pra quem não deveria saber.
  if (!member.found) return { ok: false, result: DEVICE_NOT_FOUND };
  if (!member.permissions) return { ok: false, result: res(403, 'FORBIDDEN', 'Suas permissões neste computador estão inválidas. Peça ao dono para reconfigurá-las.') };
  if (!(await userHasActiveSubscription(env, device.user_id))) {
    return { ok: false, result: res(402, 'SUBSCRIPTION_REQUIRED', 'O dono deste computador não está com o Cubicase Plus ativo agora.') };
  }
  return { ok: true, isOwner: false, permissions: member.permissions };
}

/** POST /api/v1/panel/ws-ticket — emite o ticket de uso único (30s) para o painel abrir o WebSocket. */
export async function handlePanelWsTicket(req: Request, env: PanelEnv): Promise<PanelResult> {
  const user = await resolveSupabaseUser(req);
  if (!user) return UNAUTHORIZED;

  let body: any;
  try { body = await req.json(); } catch { return res(400, 'BAD_REQUEST', 'JSON inválido.'); }
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : null;
  if (!deviceId) return res(400, 'VALIDATION_ERROR', 'deviceId obrigatório.');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return NOT_CONFIGURED;

  const access = await resolvePanelAccess(env, user, deviceId);
  if (!access.ok) return access.result;

  const stub = env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
  const mintResp = await stub.fetch('https://host-channel.internal/mint-ticket', {
    method: 'POST',
    body: JSON.stringify({
      userId: user.id,
      name: user.displayName,
      isOwner: access.isOwner,
      permissions: access.isOwner ? undefined : access.permissions,
    }),
  });
  const { ticket } = (await mintResp.json()) as { ticket: string };
  return OK('Ticket emitido.', { ticket, deviceId, isOwner: access.isOwner, permissions: access.permissions });
}

// ------------------------------------------------------------
// Roteador dos demais endpoints (/api/v1/panel/...)
// ------------------------------------------------------------

/** Devolve null se o caminho não é de nenhum endpoint deste módulo (o index.ts segue pro próximo). */
export async function handlePanelAccessRoute(req: Request, deps: PanelDeps, method: string, path: string, url: URL): Promise<PanelResult | null> {
  const sub = path.slice('/api/v1/panel'.length); // "" | "/devices" | "/invites/accept" ...

  const mDevices = sub === '/devices' && method === 'GET';
  const isCleanup = sub === '/devices/cleanup' && method === 'POST';
  const mDevice = sub.match(/^\/devices\/([A-Za-z0-9-]+)$/);
  const mMembers = sub.match(/^\/devices\/([A-Za-z0-9-]+)\/members$/);
  const mInvites = sub.match(/^\/devices\/([A-Za-z0-9-]+)\/invites$/);
  const mInvite = sub.match(/^\/devices\/([A-Za-z0-9-]+)\/invites\/([A-Za-z0-9-]+)$/);
  const mMember = sub.match(/^\/devices\/([A-Za-z0-9-]+)\/members\/([A-Za-z0-9-]+)$/);
  const isPreview = sub === '/invites/preview' && method === 'GET';
  const isAccept = sub === '/invites/accept' && method === 'POST';
  const isDecline = sub === '/invites/decline' && method === 'POST';

  const matched =
    mDevices ||
    isCleanup ||
    (mDevice && (method === 'DELETE' || method === 'PATCH')) ||
    (mMembers && method === 'GET') ||
    (mInvites && method === 'POST') ||
    (mInvite && method === 'DELETE') ||
    (mMember && (method === 'PATCH' || method === 'DELETE')) ||
    isPreview || isAccept || isDecline;
  if (!matched) return null;

  const { env } = deps;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return NOT_CONFIGURED;
  const user = await resolveSupabaseUser(req);
  if (!user) return UNAUTHORIZED;

  if (mDevices) return listDevices(env, user);
  if (isCleanup) return cleanupDevices(env, user);
  if (mDevice && method === 'PATCH') return renameDevice(req, env, user, mDevice[1]);
  if (mDevice) return removeDevice(env, user, mDevice[1]);
  if (mMembers) return listMembers(env, user, mMembers[1]);
  if (mInvites) return createInvite(req, deps, user, mInvites[1]);
  if (mInvite) return revokeInvite(env, user, mInvite[1], mInvite[2]);
  if (mMember && method === 'PATCH') return updateMember(req, env, user, mMember[1], mMember[2]);
  if (mMember) return removeMember(env, user, mMember[1], mMember[2]);
  if (isPreview) return previewInvite(env, user, url.searchParams.get('token'));
  if (isAccept) return acceptInvite(req, env, user);
  return declineInvite(req, env, user);
}

// ---- Dispositivos (meus + compartilhados comigo + convites pendentes) ----

/** O app do computador está conectado agora? `null` se não deu para saber (o painel então não mostra nada). */
async function agentOnline(env: PanelEnv, deviceId: string): Promise<boolean | null> {
  try {
    const stub = env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
    const r = await stub.fetch('https://host-channel.internal/presence', { method: 'POST', signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = (await r.json()) as { agentOnline?: unknown };
    return typeof j.agentOnline === 'boolean' ? j.agentOnline : null;
  } catch {
    return null;
  }
}

/** Derruba as conexões de um computador que saiu da conta (o app dele passa a ser barrado no próximo contato). */
async function unpairDevice(env: PanelEnv, deviceId: string): Promise<void> {
  try {
    const stub = env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
    await stub.fetch('https://host-channel.internal/unpair', { method: 'POST' });
  } catch { /* melhor esforço: o token já não existe mais no banco */ }
}

/** Mais que isto na lista, o painel não consulta quem está online (cada consulta é uma chamada ao Durable Object). */
const PRESENCE_MAX_DEVICES = 30;

async function listDevices(env: PanelEnv, user: SupabaseUser): Promise<PanelResult> {
  const nowIso = new Date().toISOString();
  const [owned, memberships, pending] = await Promise.all([
    supabaseService(env, `/rest/v1/panel_devices?user_id=eq.${enc(user.id)}&select=id,device_name,last_seen_at,created_at&order=last_seen_at.desc.nullslast`).then((r) => rows<DeviceRow>(r)),
    supabaseService(env, `/rest/v1/panel_device_members?user_id=eq.${enc(user.id)}&select=permissions,panel_devices(id,user_id,device_name,last_seen_at)`).then((r) => rows<any>(r)),
    supabaseService(env, `/rest/v1/panel_device_invites?kind=eq.email&target_user_id=eq.${enc(user.id)}&expires_at=gt.${enc(nowIso)}&select=id,permissions,expires_at,created_by,panel_devices(device_name)`).then((r) => rows<any>(r)),
  ]);

  const info = await userInfo(env, [
    ...memberships.map((m) => m.panel_devices?.user_id).filter(Boolean),
    ...pending.map((p) => p.created_by),
  ]);

  const sharedDevices = memberships.filter((m) => m.panel_devices);
  const ids = [...owned.map((d) => d.id), ...sharedDevices.map((m) => m.panel_devices.id as string)].slice(0, PRESENCE_MAX_DEVICES);
  const online = new Map<string, boolean | null>(await Promise.all(ids.map(async (id) => [id, await agentOnline(env, id)] as const)));

  return OK('Dispositivos listados.', {
    owned: owned.map((d) => ({ id: d.id, deviceName: d.device_name, lastSeenAt: d.last_seen_at, createdAt: d.created_at ?? null, online: online.get(d.id) ?? null })),
    shared: sharedDevices
      .map((m) => ({
        id: m.panel_devices.id,
        deviceName: m.panel_devices.device_name,
        lastSeenAt: m.panel_devices.last_seen_at,
        online: online.get(m.panel_devices.id) ?? null,
        ownerLabel: labelOf(info.get(m.panel_devices.user_id)),
        permissions: normalizePermissions(m.permissions),
      })),
    pendingInvites: pending.map((p) => ({
      id: p.id,
      deviceName: p.panel_devices?.device_name ?? 'Computador',
      invitedBy: labelOf(info.get(p.created_by)),
      permissions: normalizePermissions(p.permissions),
      expiresAt: p.expires_at,
    })),
  });
}

// ---- Gerenciar os próprios computadores: remover, renomear e limpar duplicados ----

export const DEVICE_NAME_MAX = 40;

/** Nome de computador aceito: sem caracteres de controle, espaços arrumados, de 1 a 40 caracteres. */
export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && [...name].length <= DEVICE_NAME_MAX ? name : null;
}

/** Tira um computador da conta. O app dele perde o pareamento (o token deixa de existir) e quem tinha acesso compartilhado também. */
async function removeDevice(env: PanelEnv, user: SupabaseUser, deviceId: string): Promise<PanelResult> {
  const owner = await requireOwner(env, user, deviceId);
  if ('result' in owner) return owner.result;
  const resp = await supabaseService(env, `/rest/v1/panel_devices?id=eq.${enc(deviceId)}&user_id=eq.${enc(user.id)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível remover o computador.');
  await unpairDevice(env, deviceId);
  return OK('Computador removido.');
}

async function renameDevice(req: Request, env: PanelEnv, user: SupabaseUser, deviceId: string): Promise<PanelResult> {
  const owner = await requireOwner(env, user, deviceId);
  if ('result' in owner) return owner.result;
  const body: any = await req.json().catch(() => null);
  const name = cleanDeviceName(body?.deviceName);
  if (!name) return res(400, 'VALIDATION_ERROR', `O nome precisa ter de 1 a ${DEVICE_NAME_MAX} caracteres.`);
  const resp = await supabaseService(env, `/rest/v1/panel_devices?id=eq.${enc(deviceId)}&user_id=eq.${enc(user.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ device_name: name }),
  });
  if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível renomear o computador.');
  return OK('Computador renomeado.', { deviceName: name });
}

const CLEANUP_MIN_AGE_MS = 24 * 3600 * 1000;

/**
 * Remove os computadores repetidos da conta: entre os de mesmo nome fica o visto por último, e os outros saem se não
 * têm ninguém com acesso, não estão online agora, não foram vistos nas últimas 24 horas (ou nunca conectaram) e não
 * são recém-criados.
 * Devolve quantos saíram. Idempotente: rodar de novo não remove mais nada.
 */
async function cleanupDevices(env: PanelEnv, user: SupabaseUser): Promise<PanelResult> {
  const own = await rows<DeviceRow>(await supabaseService(env, `/rest/v1/panel_devices?user_id=eq.${enc(user.id)}&select=id,device_name,last_seen_at,created_at&limit=200`));
  const groups = new Map<string, DeviceRow[]>();
  for (const d of own) {
    const key = d.device_name.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const stamp = (d: DeviceRow) => Date.parse(d.last_seen_at ?? '') || 0;
  const created = (d: DeviceRow) => Date.parse(d.created_at ?? '') || 0;

  const candidates: DeviceRow[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => stamp(b) - stamp(a) || created(b) - created(a));
    candidates.push(...sorted.slice(1));
  }
  if (candidates.length === 0) return OK('Nenhum computador repetido.', { removed: 0 });

  // Quem tem pessoas com acesso (ou convite) não é lixo: não mexe.
  const idList = candidates.map((d) => enc(d.id)).join(',');
  const [members, invites] = await Promise.all([
    rows<{ device_id: string }>(await supabaseService(env, `/rest/v1/panel_device_members?device_id=in.(${idList})&select=device_id`)),
    rows<{ device_id: string }>(await supabaseService(env, `/rest/v1/panel_device_invites?device_id=in.(${idList})&select=device_id`)),
  ]);
  const busy = new Set([...members, ...invites].map((r) => r.device_id));

  const now = Date.now();
  const doomed: DeviceRow[] = [];
  for (const d of candidates) {
    if (busy.has(d.id)) continue;
    if (stamp(d) && now - stamp(d) < CLEANUP_MIN_AGE_MS) continue; // visto há pouco: pode ser outro computador com o mesmo nome
    if (created(d) && now - created(d) < CLEANUP_MIN_AGE_MS) continue; // recém-criado: o app ainda nem teve tempo de conectar
    if ((await agentOnline(env, d.id)) !== false) continue; // online, ou sem saber: na dúvida, fica
    doomed.push(d);
  }
  if (doomed.length === 0) return OK('Nenhum computador repetido.', { removed: 0 });

  const resp = await supabaseService(env, `/rest/v1/panel_devices?id=in.(${doomed.map((d) => enc(d.id)).join(',')})&user_id=eq.${enc(user.id)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível limpar os computadores repetidos.');
  await Promise.all(doomed.map((d) => unpairDevice(env, d.id)));
  return OK('Computadores repetidos removidos.', { removed: doomed.length });
}

// ---- Membros e convites de um dispositivo (só o dono) ----

async function requireOwner(env: PanelEnv, user: SupabaseUser, deviceId: string): Promise<{ device: DeviceRow } | { result: PanelResult }> {
  const device = await getDevice(env, deviceId);
  if (!device || device.user_id !== user.id) return { result: DEVICE_NOT_FOUND };
  return { device };
}

async function listMembers(env: PanelEnv, user: SupabaseUser, deviceId: string): Promise<PanelResult> {
  const owner = await requireOwner(env, user, deviceId);
  if ('result' in owner) return owner.result;

  const [members, invites] = await Promise.all([
    supabaseService(env, `/rest/v1/panel_device_members?device_id=eq.${enc(deviceId)}&select=user_id,permissions,created_at&order=created_at.asc`).then((r) => rows<{ user_id: string; permissions: unknown; created_at: string }>(r)),
    supabaseService(env, `/rest/v1/panel_device_invites?device_id=eq.${enc(deviceId)}&select=*&order=created_at.desc`).then((r) => rows<InviteRow>(r)),
  ]);

  const now = Date.now();
  const usable = invites.filter((i) => inviteUsable(i, now));
  // Limpeza preguiçosa: convites vencidos/esgotados não servem pra nada e só
  // ocupariam a cota de MAX_MEMBERS_AND_INVITES_PER_DEVICE.
  const dead = invites.filter((i) => !inviteUsable(i, now)).map((i) => i.id);
  if (dead.length > 0) {
    void supabaseService(env, `/rest/v1/panel_device_invites?id=in.(${dead.map(enc).join(',')})`, { method: 'DELETE' });
  }

  const info = await userInfo(env, [...members.map((m) => m.user_id), ...usable.map((i) => i.target_user_id).filter((x): x is string => !!x)]);

  return OK('Membros listados.', {
    members: members.map((m) => ({
      userId: m.user_id,
      name: info.get(m.user_id)?.name ?? null,
      email: info.get(m.user_id)?.email ?? null,
      permissions: normalizePermissions(m.permissions),
      createdAt: m.created_at,
    })),
    invites: usable.map((i) => ({
      id: i.id,
      kind: i.kind,
      target: i.target_user_id ? labelOf(info.get(i.target_user_id)) : null,
      token: i.kind === 'link' ? i.token : null,
      permissions: normalizePermissions(i.permissions),
      singleUse: i.single_use,
      uses: i.uses,
      expiresAt: i.expires_at,
    })),
  });
}

async function createInvite(req: Request, deps: PanelDeps, user: SupabaseUser, deviceId: string): Promise<PanelResult> {
  const { env } = deps;
  const owner = await requireOwner(env, user, deviceId);
  if ('result' in owner) return owner.result;

  // Antes de qualquer coisa que revele algo (ex: "esse e-mail não tem
  // conta"): limita por dono, não por IP — sem isso, dá pra usar este
  // endpoint como um verificador de e-mails cadastrados.
  if (!(await deps.rateLimit('panel-invite', user.id, INVITE_RATE_LIMIT))) {
    return res(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde um minuto e tente de novo.');
  }
  if (!(await userHasActiveSubscription(env, user.id))) {
    return res(402, 'SUBSCRIPTION_REQUIRED', 'Compartilhar o painel é um recurso do Cubicase Plus.');
  }

  let body: any;
  try { body = await req.json(); } catch { return res(400, 'BAD_REQUEST', 'JSON inválido.'); }
  const permissions = normalizePermissions(body?.permissions);
  if (!permissions) return res(422, 'VALIDATION_ERROR', 'Permissões inválidas.');
  const kind = body?.kind;
  if (kind !== 'email' && kind !== 'link') return res(422, 'VALIDATION_ERROR', 'kind precisa ser "email" ou "link".');

  const [memberRows, inviteRows] = await Promise.all([
    supabaseService(env, `/rest/v1/panel_device_members?device_id=eq.${enc(deviceId)}&select=user_id`).then((r) => rows<{ user_id: string }>(r)),
    supabaseService(env, `/rest/v1/panel_device_invites?device_id=eq.${enc(deviceId)}&select=id,kind,target_user_id`).then((r) => rows<{ id: string; kind: string; target_user_id: string | null }>(r)),
  ]);
  if (memberRows.length + inviteRows.length >= MAX_MEMBERS_AND_INVITES_PER_DEVICE) {
    return res(409, 'CONFLICT', `Limite de ${MAX_MEMBERS_AND_INVITES_PER_DEVICE} membros/convites por computador atingido. Remova algum antes de convidar mais.`);
  }

  if (kind === 'email') {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res(422, 'VALIDATION_ERROR', 'E-mail inválido.');

    const lookup = await supabaseService(env, '/rest/v1/rpc/panel_find_user_by_email', { method: 'POST', body: JSON.stringify({ p_email: email }) });
    const targetId = lookup.ok ? await lookup.json().catch(() => null) : null;
    if (!targetId || typeof targetId !== 'string') {
      return res(404, 'USER_NOT_FOUND', 'Não existe conta do Cubicase com esse e-mail. A pessoa precisa criar a conta (fazer login uma vez) antes de ser convidada.');
    }
    if (targetId === user.id) return res(409, 'CONFLICT', 'Esse e-mail é da sua própria conta.');
    if (memberRows.some((m) => m.user_id === targetId)) return res(409, 'CONFLICT', 'Essa conta já tem acesso a este computador.');

    // Reconvidar a mesma conta substitui o convite pendente (permite corrigir permissões).
    const stale = inviteRows.filter((i) => i.kind === 'email' && i.target_user_id === targetId).map((i) => i.id);
    if (stale.length > 0) {
      await supabaseService(env, `/rest/v1/panel_device_invites?id=in.(${stale.map(enc).join(',')})`, { method: 'DELETE' });
    }

    const created = await rows<InviteRow>(await supabaseService(env, '/rest/v1/panel_device_invites', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        device_id: deviceId,
        kind: 'email',
        target_user_id: targetId,
        permissions,
        single_use: true,
        expires_at: new Date(Date.now() + EMAIL_INVITE_TTL_HOURS * 3_600_000).toISOString(),
        created_by: user.id,
      }),
    }));
    if (!created[0]) return res(500, 'INTERNAL_ERROR', 'Não foi possível criar o convite.');
    // O convite já está criado e a pessoa o vê ao abrir o painel; o e-mail é só o aviso (e só sai com remetente próprio configurado).
    const ownerInfo = await userInfo(env, [user.id]);
    const emailed = await sendInviteEmail(env, {
      to: email,
      owner: labelOf(ownerInfo.get(user.id)),
      device: owner.device.device_name,
      days: Math.round(EMAIL_INVITE_TTL_HOURS / 24),
    });
    const message = emailed
      ? 'Convite criado e e-mail enviado. A pessoa também o verá ao abrir o painel.'
      : inviteMailConfigured(env)
        ? 'Convite criado, mas o e-mail não saiu. Avise a pessoa para abrir o painel e entrar com este e-mail.'
        : 'Convite criado. Avise a pessoa para abrir o painel e entrar com este e-mail: o convite aparece lá.';
    return OK(message, { id: created[0].id, kind: 'email', emailed });
  }

  const singleUse = body.singleUse !== false;
  const hours = Math.min(Math.max(Number(body.expiresInHours) || DEFAULT_LINK_TTL_HOURS, 1), MAX_LINK_TTL_HOURS);
  const created = await rows<InviteRow>(await supabaseService(env, '/rest/v1/panel_device_invites', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      device_id: deviceId,
      kind: 'link',
      token: generateInviteToken(),
      permissions,
      single_use: singleUse,
      expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
      created_by: user.id,
    }),
  }));
  if (!created[0]) return res(500, 'INTERNAL_ERROR', 'Não foi possível criar o convite.');
  return OK('Link de convite criado.', { id: created[0].id, kind: 'link', token: created[0].token, expiresAt: created[0].expires_at, singleUse });
}

async function revokeInvite(env: PanelEnv, user: SupabaseUser, deviceId: string, inviteId: string): Promise<PanelResult> {
  const owner = await requireOwner(env, user, deviceId);
  if ('result' in owner) return owner.result;
  await supabaseService(env, `/rest/v1/panel_device_invites?id=eq.${enc(inviteId)}&device_id=eq.${enc(deviceId)}`, { method: 'DELETE' });
  return OK('Convite cancelado.');
}

async function updateMember(req: Request, env: PanelEnv, user: SupabaseUser, deviceId: string, memberId: string): Promise<PanelResult> {
  const owner = await requireOwner(env, user, deviceId);
  if ('result' in owner) return owner.result;

  let body: any;
  try { body = await req.json(); } catch { return res(400, 'BAD_REQUEST', 'JSON inválido.'); }
  const permissions = normalizePermissions(body?.permissions);
  if (!permissions) return res(422, 'VALIDATION_ERROR', 'Permissões inválidas.');

  const updated = await rows<{ user_id: string }>(await supabaseService(
    env,
    `/rest/v1/panel_device_members?device_id=eq.${enc(deviceId)}&user_id=eq.${enc(memberId)}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ permissions }) },
  ));
  if (updated.length === 0) return res(404, 'NOT_FOUND', 'Membro não encontrado.');
  await kickMember(env, deviceId, memberId, false);
  return OK('Permissões atualizadas.');
}

async function removeMember(env: PanelEnv, user: SupabaseUser, deviceId: string, memberId: string): Promise<PanelResult> {
  // O dono remove qualquer membro; um membro pode remover a si mesmo (sair).
  if (memberId !== user.id) {
    const owner = await requireOwner(env, user, deviceId);
    if ('result' in owner) return owner.result;
  }
  const removed = await rows<{ user_id: string }>(await supabaseService(
    env,
    `/rest/v1/panel_device_members?device_id=eq.${enc(deviceId)}&user_id=eq.${enc(memberId)}`,
    { method: 'DELETE', headers: { Prefer: 'return=representation' } },
  ));
  if (removed.length === 0) return res(404, 'NOT_FOUND', 'Membro não encontrado.');
  await kickMember(env, deviceId, memberId, true);
  return OK('Acesso removido.');
}

// ---- Convites (lado de quem recebe) ----

async function findLinkInvite(env: PanelEnv, token: string): Promise<InviteRow | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const list = await rows<InviteRow>(await supabaseService(env, `/rest/v1/panel_device_invites?kind=eq.link&token=eq.${enc(token)}&select=*`));
  return list[0] ?? null;
}

async function previewInvite(env: PanelEnv, user: SupabaseUser, token: string | null): Promise<PanelResult> {
  const invite = token ? await findLinkInvite(env, token) : null;
  if (!invite || !inviteUsable(invite, Date.now())) return res(410, 'NOT_FOUND', 'Este convite expirou, já foi usado ou não existe.');
  const device = await getDevice(env, invite.device_id);
  if (!device) return res(410, 'NOT_FOUND', 'Este convite expirou, já foi usado ou não existe.');
  const info = await userInfo(env, [device.user_id]);
  return OK('Convite válido.', {
    deviceName: device.device_name,
    ownerLabel: labelOf(info.get(device.user_id)),
    permissions: normalizePermissions(invite.permissions),
    isOwner: device.user_id === user.id,
    alreadyMember: (await getMemberPermissions(env, device.id, user.id)).found,
  });
}

async function acceptInvite(req: Request, env: PanelEnv, user: SupabaseUser): Promise<PanelResult> {
  let body: any;
  try { body = await req.json(); } catch { return res(400, 'BAD_REQUEST', 'JSON inválido.'); }

  let invite: InviteRow | null = null;
  if (typeof body?.token === 'string') {
    invite = await findLinkInvite(env, body.token);
  } else if (typeof body?.inviteId === 'string') {
    const list = await rows<InviteRow>(await supabaseService(env, `/rest/v1/panel_device_invites?id=eq.${enc(body.inviteId)}&kind=eq.email&target_user_id=eq.${enc(user.id)}&select=*`));
    invite = list[0] ?? null;
  }
  const gone = res(410, 'NOT_FOUND', 'Este convite expirou, já foi usado ou não existe.');
  if (!invite || !inviteUsable(invite, Date.now())) return gone;

  const permissions = normalizePermissions(invite.permissions);
  if (!permissions) return res(422, 'VALIDATION_ERROR', 'O convite tem permissões inválidas. Peça um novo ao dono.');
  const device = await getDevice(env, invite.device_id);
  if (!device) return gone;
  if (device.user_id === user.id) return res(409, 'CONFLICT', 'Este computador já é seu.');

  // Já é membro: não consome o convite nem mexe nas permissões atuais.
  if ((await getMemberPermissions(env, device.id, user.id)).found) {
    return OK('Você já tem acesso a este computador.', { deviceId: device.id, deviceName: device.device_name, alreadyMember: true });
  }

  // "Reivindica" o convite antes de criar o vínculo, de forma atômica — dois
  // cliques simultâneos num link de uso único não podem entrar os dois.
  const claimed = invite.kind === 'email'
    ? await rows<InviteRow>(await supabaseService(env, `/rest/v1/panel_device_invites?id=eq.${enc(invite.id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } }))
    : await rows<InviteRow>(await supabaseService(env, `/rest/v1/panel_device_invites?id=eq.${enc(invite.id)}&uses=eq.${invite.uses}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ uses: invite.uses + 1 }),
      }));
  if (claimed.length === 0) return gone;

  const insert = await supabaseService(env, '/rest/v1/panel_device_members', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ device_id: device.id, user_id: user.id, permissions, invited_by: invite.created_by }),
  });
  if (!insert.ok) {
    if (invite.kind === 'link') {
      void supabaseService(env, `/rest/v1/panel_device_invites?id=eq.${enc(invite.id)}`, { method: 'PATCH', body: JSON.stringify({ uses: invite.uses }) });
    }
    return res(500, 'INTERNAL_ERROR', 'Não foi possível aceitar o convite. Tente de novo.');
  }
  return OK('Convite aceito.', { deviceId: device.id, deviceName: device.device_name, alreadyMember: false });
}

async function declineInvite(req: Request, env: PanelEnv, user: SupabaseUser): Promise<PanelResult> {
  let body: any;
  try { body = await req.json(); } catch { return res(400, 'BAD_REQUEST', 'JSON inválido.'); }
  if (typeof body?.inviteId !== 'string') return res(422, 'VALIDATION_ERROR', 'inviteId obrigatório.');
  await supabaseService(env, `/rest/v1/panel_device_invites?id=eq.${enc(body.inviteId)}&kind=eq.email&target_user_id=eq.${enc(user.id)}`, { method: 'DELETE' });
  return OK('Convite recusado.');
}
