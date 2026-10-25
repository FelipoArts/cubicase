// ============================================================
// Notificações push do painel web (Cubicase Plus)
// ============================================================
// Quem gerencia as inscrições e envia é o Durable Object do dispositivo (host-channel.ts), porque é ele quem
// já recebe tudo que o app desktop conta (status, jogadores). Este módulo tem:
//   - as regras puras (quais eventos existem, o que cada inscrito quer receber, o texto da notificação);
//   - as rotas HTTP do Worker (/api/v1/panel/push/key e /api/v1/panel/devices/{id}/push...), que autenticam o
//     usuário e conferem o acesso ao dispositivo antes de falar com o Durable Object.
// ============================================================

import { resolvePanelAccess, type PanelEnv, type PanelResult } from './panel-members';
import { isAllowedPushEndpoint, type VapidKeys } from './webpush';
import { resolveSupabaseUser } from './supabase';
import type { PanelPermissions } from './panel-access';

export interface PushEnv extends PanelEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export function vapidFromEnv(env: PushEnv): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:contato@cubicase.net' };
}

// ---- Preferências e inscrições ----

export interface PushPrefs {
  /** Entrou/saiu jogador (só quem pode ver o console — nomes de jogadores são tão sensíveis quanto o log). */
  players: boolean;
  /** Servidor ligado/desligado. */
  server: boolean;
  /** O Cubicase do computador ficou offline. */
  offline: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = { players: true, server: true, offline: true };

export type PushLang = 'pt-BR' | 'en';

export function normalizePrefs(raw: unknown): PushPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof PushPrefs) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : DEFAULT_PUSH_PREFS[k]);
  return { players: pick('players'), server: pick('server'), offline: pick('offline') };
}

export function normalizeLang(raw: unknown): PushLang {
  return typeof raw === 'string' && raw.toLowerCase().startsWith('en') ? 'en' : 'pt-BR';
}

/** Inscrição como guardada no Durable Object. */
export interface StoredPushSub {
  userId: string;
  isOwner: boolean;
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: PushPrefs;
  lang: PushLang;
  createdAt: number;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Valida o objeto `subscription` que o navegador entrega (PushSubscription.toJSON()). */
export function parseBrowserSubscription(raw: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!r || !isAllowedPushEndpoint(r.endpoint)) return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length !== 87 || auth.length !== 22) return null;
  return { endpoint: r.endpoint, p256dh, auth };
}

// ---- Eventos ----

export type PushEvent =
  | { kind: 'players'; joined: string[]; left: string[] }
  | { kind: 'server_started'; serverName: string | null; by: string | null }
  | { kind: 'server_stopped'; serverName: string | null; by: string | null }
  | { kind: 'agent_offline' };

/** Quem entrou/saiu entre duas listas de jogadores (sem diferenciar maiúsculas, como o Minecraft). */
export function diffPlayers(previous: string[], next: string[]): { joined: string[]; left: string[] } {
  const before = new Map(previous.map((n) => [n.toLowerCase(), n]));
  const after = new Map(next.map((n) => [n.toLowerCase(), n]));
  return {
    joined: [...after].filter(([k]) => !before.has(k)).map(([, n]) => n),
    left: [...before].filter(([k]) => !after.has(k)).map(([, n]) => n),
  };
}

export type StatusChange = 'started' | 'stopped' | null;

/** Mudança de estado do servidor entre dois `status` do agent. Sem estado anterior não há "mudança" (é só a linha de base). */
export function detectStatusChange(previous: { serverRunning?: unknown } | null, next: { serverRunning?: unknown }): StatusChange {
  if (!previous || typeof previous.serverRunning !== 'boolean' || typeof next.serverRunning !== 'boolean') return null;
  if (previous.serverRunning === next.serverRunning) return null;
  return next.serverRunning ? 'started' : 'stopped';
}

/** O que o inscrito quer e pode receber para este evento. */
export function wantsEvent(event: PushEvent, prefs: PushPrefs, perms: Pick<PanelPermissions, 'viewConsole'>): boolean {
  switch (event.kind) {
    case 'players': return prefs.players && perms.viewConsole;
    case 'server_started':
    case 'server_stopped': return prefs.server;
    case 'agent_offline': return prefs.offline;
  }
}

// ---- Texto da notificação ----

export interface PushMessage {
  title: string;
  body: string;
  /** Notificações com a mesma tag se substituem (não empilham). */
  tag: string;
  /** Abrir o painel direto neste computador. */
  deviceId: string;
  /** Botão da notificação, quando a pessoa pode fazer a ação. */
  action?: 'start';
  serverName?: string | null;
}

const MAX_NAMES = 3;

function nameList(names: string[], lang: PushLang): string {
  const shown = names.slice(0, MAX_NAMES);
  const extra = names.length - shown.length;
  const and = lang === 'en' ? 'and' : 'e';
  const base = shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} ${and} ${shown[shown.length - 1]}`;
  if (extra <= 0) return base;
  return lang === 'en' ? `${shown.join(', ')} and ${extra} more` : `${shown.join(', ')} e mais ${extra}`;
}

/** Texto limpo: nomes de jogador/servidor vêm do mundo externo — sem quebras de linha e com tamanho limitado. */
function clean(s: string, max = 40): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

export function buildMessage(event: PushEvent, lang: PushLang, deviceId: string, canStart: boolean): PushMessage {
  const en = lang === 'en';
  switch (event.kind) {
    case 'players': {
      const joined = event.joined.map((n) => clean(n, 20));
      const left = event.left.map((n) => clean(n, 20));
      const parts: string[] = [];
      if (joined.length) parts.push(en ? `${nameList(joined, lang)} joined` : `${nameList(joined, lang)} ${joined.length === 1 ? 'entrou' : 'entraram'}`);
      if (left.length) parts.push(en ? `${nameList(left, lang)} left` : `${nameList(left, lang)} ${left.length === 1 ? 'saiu' : 'saíram'}`);
      return {
        title: joined.length && !left.length ? (en ? 'Player online' : 'Jogador online') : (en ? 'Players' : 'Jogadores'),
        body: parts.join(en ? '; ' : '; '),
        tag: 'players',
        deviceId,
      };
    }
    case 'server_started': {
      const name = event.serverName ? clean(event.serverName) : null;
      const by = event.by ? clean(event.by, 30) : null;
      return {
        title: en ? 'Server is online' : 'Servidor ligado',
        body: by
          ? (en ? `${by} started${name ? ` ${name}` : ' the server'}.` : `${by} ligou${name ? ` ${name}` : ' o servidor'}.`)
          : (en ? `${name ?? 'The server'} is running.` : `${name ?? 'O servidor'} está rodando.`),
        tag: 'server',
        deviceId,
      };
    }
    case 'server_stopped': {
      const name = event.serverName ? clean(event.serverName) : null;
      const by = event.by ? clean(event.by, 30) : null;
      return {
        title: en ? 'Server stopped' : 'Servidor parou',
        body: by
          ? (en ? `${by} stopped ${name ?? 'the server'}.` : `${by} desligou ${name ?? 'o servidor'}.`)
          : (en ? `${name ?? 'The server'} is no longer running.` : `${name ?? 'O servidor'} não está mais rodando.`),
        tag: 'server',
        deviceId,
        action: canStart ? 'start' : undefined,
        serverName: name,
      };
    }
    case 'agent_offline':
      return {
        title: en ? 'Computer offline' : 'Computador offline',
        body: en ? 'Cubicase on your computer is no longer connected (closed, PC off or no internet).' : 'O Cubicase do computador não está mais conectado (fechado, PC desligado ou sem internet).',
        tag: 'offline',
        deviceId,
      };
  }
}

/** Carga JSON que o service worker recebe (limitada: o registro de push tem 4 KB). */
export function toPayload(msg: PushMessage, lang: PushLang): Record<string, unknown> {
  return {
    title: msg.title,
    body: msg.body,
    tag: msg.tag,
    deviceId: msg.deviceId,
    lang,
    ...(msg.action ? { action: msg.action, serverName: msg.serverName ?? null } : {}),
  };
}

// ============================================================
// Rotas HTTP (Worker)
// ============================================================

const res = (status: number, code: string, message: string, data?: unknown): PanelResult => ({ status, code, message, data });
const PUSH_NOT_CONFIGURED = res(503, 'INTERNAL_ERROR', 'As notificações não estão configuradas neste servidor.');
const MAX_SUBS_PER_USER = 5;

async function toChannel(env: PushEnv, deviceId: string, path: string, body: unknown): Promise<Response> {
  const stub = env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
  return stub.fetch(`https://host-channel.internal${path}`, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * GET /api/v1/panel/push/key — chave pública VAPID (o navegador precisa dela para se inscrever; é pública por
 * natureza). Sem login: a tela de escolher computador também pode checar se o recurso existe.
 * /api/v1/panel/devices/{id}/push[/check] — POST (inscrever/atualizar), DELETE (cancelar), POST .../check (estado).
 * Devolve null quando o caminho não é de push.
 */
export async function handlePanelPushRoute(req: Request, env: PushEnv, method: string, path: string): Promise<PanelResult | null> {
  const sub = path.slice('/api/v1/panel'.length);
  if (sub === '/push/key' && method === 'GET') {
    const vapid = vapidFromEnv(env);
    return vapid ? res(200, 'SUCCESS', 'OK', { publicKey: vapid.publicKey }) : PUSH_NOT_CONFIGURED;
  }

  const m = sub.match(/^\/devices\/([A-Za-z0-9-]+)\/push(\/check)?$/);
  if (!m) return null;
  const isCheck = !!m[2];
  if (!((method === 'POST') || (method === 'DELETE' && !isCheck))) return null;
  const deviceId = m[1];

  if (!env.SUPABASE_SERVICE_ROLE_KEY || !vapidFromEnv(env)) return PUSH_NOT_CONFIGURED;
  const user = await resolveSupabaseUser(req);
  if (!user) return res(401, 'BAD_REQUEST', 'Sessão inválida ou expirada. Faça login novamente.');

  let body: any;
  try { body = await req.json(); } catch { return res(400, 'BAD_REQUEST', 'JSON inválido.'); }

  // Só quem tem acesso (dono com Plus ativo, ou membro de dono com Plus ativo) pode se inscrever.
  const access = await resolvePanelAccess(env, user, deviceId);
  if (!access.ok) return access.result;

  if (method === 'DELETE' || isCheck) {
    const endpoint = body?.endpoint;
    if (!isAllowedPushEndpoint(endpoint)) return res(400, 'VALIDATION_ERROR', 'Inscrição inválida.');
    const r = await toChannel(env, deviceId, isCheck ? '/push-check' : '/push-unsubscribe', { userId: user.id, endpoint });
    const data = isCheck ? await r.json().catch(() => ({ subscribed: false })) : undefined;
    return res(200, 'SUCCESS', 'OK', data);
  }

  const parsed = parseBrowserSubscription(body?.subscription);
  if (!parsed) return res(400, 'VALIDATION_ERROR', 'Inscrição de notificação inválida.');
  const r = await toChannel(env, deviceId, '/push-subscribe', {
    userId: user.id,
    isOwner: access.isOwner,
    permissions: access.isOwner ? undefined : access.permissions,
    sub: parsed,
    prefs: normalizePrefs(body?.prefs),
    lang: normalizeLang(body?.lang),
    maxPerUser: MAX_SUBS_PER_USER,
  });
  if (!r.ok) return res(r.status === 429 ? 429 : 500, 'INTERNAL_ERROR', 'Não foi possível salvar a inscrição.');
  return res(200, 'SUCCESS', 'Notificações ativadas.', await r.json().catch(() => ({})));
}
