// ============================================================
// HostChannel — Durable Object do painel web remoto (Cubicase Plus)
// ============================================================
// Um DO por dispositivo (nome = panel_devices.id, um UUID não-secreto).
// Mantém a conexão WebSocket outbound do app desktop (papel "agent") viva
// via WebSocket Hibernation API (o isolate pode ser evacuado da memória
// entre mensagens sem derrubar a conexão do cliente) e roteia mensagens
// entre ela e quantas conexões de painel web (papel "panel") estiverem
// abertas para o mesmo dispositivo — do dono e de contas convidadas.
//
// Protocolo (JSON por mensagem WS, ver espelho em src-tauri/src/panel_agent.rs):
//   agent -> relay -> painel(is):
//     { type: "status", serverRunning, serverName?, playerCount?, maxPlayers?, ts }
//     { type: "log_line", line, ts }
//     { type: "server_list", servers: [{ id, name, version, serverType, status }] }
//     { type: "error", message } — comando que o agent tentou executar e falhou
//       (ex: enviar comando de console sem servidor rodando)
//     { type: "metrics", totalRamMb, availableRamMb, cpuUsagePercent, processRamMb?, processCpuPercent?, ts }
//       (Fase 3 — só enviada quando o agent já tem uma amostra, ver build_metrics_message)
//     { type: "players", players: string[], ts } — nomes online (Modo Espectador Web).
//       Só entregue a painéis com "ver console" (nomes de jogadores são tão
//       sensíveis quanto o log); os demais continuam vendo só `playerCount` do status.
//     { type: "player_action_result", requestId, ok, action, player, message, ts } —
//       confirmação de kick/ban/pardon. NÃO é broadcast: vai só pras conexões do
//       usuário que pediu (ver routeActionResult).
//   relay -> painel (sem vir do agent):
//     { type: "agent_connected" } | { type: "agent_disconnected" }
//     { type: "access", isOwner, permissions } — logo ao conectar: o que ESTA
//       conexão pode fazer (a UI usa só pra esconder/desabilitar botões; quem
//       de fato barra é este DO, a cada mensagem — ver handlePanelMessage)
//     { type: "error", message } — ação negada por falta de permissão
//   keepalive (agent -> relay): a string pura "ping". O relay responde "pong"
//     via setWebSocketAutoResponse, SEM acordar o Durable Object (sem duração
//     cobrada e sem tocar em storage) — por isso o agent usa isso como sinal de
//     vida em vez de reenviar `status` à toa. Um relay antigo (sem auto-resposta)
//     só ignora o "ping": não é JSON, cai no `catch` de webSocketMessage.
//   painel -> relay:
//     { type: "command", command } | { type: "stop_server" }
//     | { type: "start_server", serverId } | { type: "restart_server", serverId }
//     | { type: "player_action", action: "kick"|"ban"|"pardon", player, reason?, requestId }
//     | { type: "players_refresh" }
//   relay -> agent (o que efetivamente chega ao app desktop):
//     as mensagens acima, RECONSTRUÍDAS depois de autorizadas (nada que o
//     painel mande a mais passa) e com `by` (nome de quem pediu) preenchido
//     aqui — o painel nunca escolhe o próprio `by`. "restart_server" nunca
//     chega ao agent: o DO a executa como stop_server -> (espera status
//     serverRunning=false) -> start_server, pra que "reiniciar" seja uma
//     permissão de verdade e não dê pra usar o meio-caminho pra só desligar.
//
// Permissões (acesso compartilhado): o dono tem tudo; membros têm o que o
// dono definiu (api/src/panel-access.ts). O Worker grava as permissões do
// membro no ticket; aqui elas são guardadas em ctx.storage por usuário
// (`perms:<userId>`) — não no attachment do WebSocket, que tem limite de 2KB
// e uma whitelist de comandos grande estouraria isso.
//
// O agent só empurra `status`/`server_list` por conta própria ao CONECTAR,
// em mudanças de estado do Minecraft, e logo depois de processar um
// comando vindo do painel (ver handle_incoming_message em panel_agent.rs —
// reenvia um snapshot fresco em vez de confiar só no evento se propagar
// sozinho). Ainda assim, um painel que conecta DEPOIS desses eventos (F5,
// segunda aba) não veria nada até o próximo — por isso a DO guarda o
// último `status`/`server_list`, e um histórico curto de `log_line`
// (ctx.storage, sobrevive a hibernação) e repete tudo pra qualquer painel
// que conectar depois (ver cacheAgentSnapshot / handleWebSocketUpgrade).
//
// Notificações push (PWA): o painel instalado se inscreve (POST /api/v1/panel/devices/{id}/push, ver panel-push.ts)
// e este DO guarda as inscrições (`push:<userId>:<hash>`). Como ele já vê tudo que o agent conta, deriva os eventos
// daqui mesmo — jogador entrou/saiu (diferença entre duas listas `players`), servidor ligou/desligou (mudança do
// `status`) e computador offline (agent caiu e não voltou em 2 min, via alarm) — e envia o push. Quem pediu a ação pelo
// painel não é notificado dela (ver `expected`), e ações pedidas pelo painel dizem "por Fulano".
//
// Autenticação de cada lado acontece só aqui dentro (nunca no Worker "puro",
// ver comentário em index.ts sobre por que o painel usa ticket em vez de
// Authorization: o WebSocket do navegador não manda headers custom):
//   - agent: header `Authorization: Bearer <device_token>` (real header —
//     quem conecta é o processo Rust, não um navegador, então não tem a
//     limitação acima). Validado contra panel_devices via service role.
//   - panel: query `?ticket=<uuid>`, de uso único, emitido por
//     POST /api/v1/panel/ws-ticket (panel-members.ts) e consumido aqui.
// ============================================================

import { SUPABASE_URL, userHasActiveSubscription, type SupabaseEnv } from '../supabase';
import { authorizePanelMessage, normalizePermissions, OWNER_PERMISSIONS, type PanelPermissions } from '../panel-access';
import {
  buildMessage, detectStatusChange, diffPlayers, normalizeLang, normalizePrefs, toPayload, vapidFromEnv, wantsEvent,
  type PushEnv, type PushEvent, type StoredPushSub,
} from '../panel-push';
import { sendWebPush } from '../webpush';
import { planControl, validBackupNotify, backupResultMessage, type BackupNotify, type ControlAction } from '../discord-control';

interface Env extends SupabaseEnv, Partial<Pick<PushEnv, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>> {}

const TICKET_TTL_MS = 30_000;
const LOG_HISTORY_KEY = 'log_history';
const LOG_HISTORY_MAX = 200;
const RESTART_KEY = 'pending_restart';
const RESTART_TTL_MS = 90_000;
const MAX_PANEL_MESSAGE_CHARS = 4096;
/** Quanto o agent pode ficar fora antes de avisar "computador offline" (reinícios do app e quedas de rede curtas não contam). */
const OFFLINE_GRACE_MS = 2 * 60_000;
const OFFLINE_DUE_KEY = 'offline_due';
/** Entradas/saídas que chegam juntas viram uma notificação só. */
const PLAYER_PUSH_DELAY_MS = 8000;
const EXPECTED_KEY = 'expected_change';
const EXPECTED_TTL_MS = 2 * 60_000;
const EXPECTED_RESTART_TTL_MS = 5 * 60_000;
const MAX_PUSH_SUBS = 40;
const PUSH_PREFIX = 'push:';
/** Tudo que o agent empurra e o relay guarda pra repetir a quem conecta depois — limpo quando o agent cai. */
/**
 * Duas mensagens JSON do agent são "a mesma" se só o carimbo `ts` difere.
 * Qualquer coisa que não seja JSON válido nunca é considerada igual.
 */
export function sameIgnoringTs(a: string, b: string): boolean {
  try {
    const pa = JSON.parse(a);
    const pb = JSON.parse(b);
    delete pa.ts;
    delete pb.ts;
    return JSON.stringify(pa) === JSON.stringify(pb);
  } catch {
    return false;
  }
}

/**
 * Linhas de console chegam em rajada (um servidor de mods imprime milhares ao iniciar).
 * Gravar o histórico a cada linha = uma gravação por linha; agrupar e gravar a cada
 * poucos segundos corta isso em ordens de grandeza. O custo é, no pior caso (DO
 * reiniciado por deploy), perder as últimas linhas ainda não gravadas do HISTÓRICO
 * de quem conectar depois — o console ao vivo nunca passa por aqui.
 */
const LOG_FLUSH_DELAY_MS = 2000;
const LOG_FLUSH_MAX_BUFFERED = 100;

/** Histórico gravado + linhas ainda em memória, limitado às últimas `max`. */
export function mergeLogHistory(stored: string[], buffered: string[], max: number): string[] {
  const all = stored.length === 0 ? buffered : buffered.length === 0 ? stored : [...stored, ...buffered];
  return all.length > max ? all.slice(all.length - max) : all;
}

const AGENT_CACHE_KEYS = ['last:status', 'last:server_list', 'last:players', LOG_HISTORY_KEY, RESTART_KEY];

const NO_PERMISSIONS: PanelPermissions = {
  viewConsole: false,
  start: false,
  stop: false,
  restart: false,
  commands: { mode: 'none', allowlist: [] },
};

interface PendingTicket {
  userId: string;
  name: string;
  isOwner: boolean;
  permissions: PanelPermissions | null;
  expiresAt: number;
}

/** Guardado no próprio WebSocket (serializeAttachment, máx. 2KB) — só identidade, nunca as permissões (ver comentário no topo). */
interface PanelAttachment {
  userId: string;
  name: string;
  isOwner: boolean;
}

/** Ação pedida pelo painel que vai mudar o estado do servidor — para dizer "por Fulano" e não notificar o próprio autor. */
interface ExpectedChange {
  kind: 'start' | 'stop' | 'restart';
  userId: string;
  by: string;
  expiresAt: number;
}

async function pushKeyFor(userId: string, endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${PUSH_PREFIX}${userId}:${hex}`;
}

interface PendingRestart {
  serverId: string;
  by: string;
  expiresAt: number;
}

interface StoredBackupNotify extends BackupNotify { expiresAt: number }
const BACKUP_NOTIFY_PREFIX = 'backup:';
const BACKUP_NOTIFY_TTL_MS = 14 * 60_000;

export class HostChannel {
  private ctx: DurableObjectState;
  private env: Env;
  /** Linhas de log recebidas e ainda não gravadas (ver LOG_FLUSH_DELAY_MS). Em memória de propósito. */
  private logBuffer: string[] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Entradas/saídas de jogadores esperando o lote de `PLAYER_PUSH_DELAY_MS`. Em memória de propósito (perder um aviso de entrada num deploy é aceitável). */
  private pendingPlayers: { joined: string[]; left: string[] } = { joined: [], left: [] };
  private playersPushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    // Keepalive barato: o agent manda "ping" de tempos em tempos e o runtime responde "pong"
    // sem acordar este objeto (ver comentário de protocolo no topo).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/mint-ticket') {
      return this.handleMintTicket(request);
    }
    if (request.method === 'POST' && url.pathname === '/kick') {
      return this.handleKick(request);
    }
    if (request.method === 'POST' && url.pathname === '/push-subscribe') return this.handlePushSubscribe(request);
    if (request.method === 'POST' && url.pathname === '/push-unsubscribe') return this.handlePushUnsubscribe(request);
    if (request.method === 'POST' && url.pathname === '/push-check') return this.handlePushCheck(request);
    if (request.method === 'POST' && url.pathname === '/discord-control') return this.handleDiscordControl(request);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Comando vindo do bot do Discord (só o Worker chama; ele já conferiu quem pode e o Plus do dono). Segue o mesmo
   * caminho do painel: a decisão do que faz sentido fica em discord-control.ts e o que vai ao app passa por
   * authorizePanelMessage. Responde `{ ok }` ou `{ ok:false, reason }` — o resultado real aparece depois no status.
   */
  private async handleDiscordControl(request: Request): Promise<Response> {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    let body: { action?: ControlAction; shortCode?: string; serverName?: string; by?: string; notify?: BackupNotify };
    try { body = await request.json(); } catch { return reply({ ok: false, reason: 'invalid' }); }
    if (!body.action || typeof body.shortCode !== 'string') return reply({ ok: false, reason: 'invalid' });

    const agent = this.ctx.getWebSockets('agent')[0];
    if (!agent) return reply({ ok: false, reason: 'agent_offline' });

    const plan = planControl(
      body.action, { shortCode: body.shortCode, name: body.serverName },
      (await this.ctx.storage.get<string>('last:status')) ?? null,
      (await this.ctx.storage.get<string>('last:server_list')) ?? null,
    );
    if (!plan.ok) return reply(plan);

    // Nome de quem pediu, só para o log do app: uma linha, sem caracteres de controle.
    const by = `Discord: ${String(body.by ?? '').replace(/[ -]/g, ' ').trim().slice(0, 40) || '?'}`;
    if (plan.expect) await this.expectChange({ kind: plan.expect, userId: 'discord', by }, plan.expect === 'restart' ? EXPECTED_RESTART_TTL_MS : EXPECTED_TTL_MS);
    if (plan.restartServerId) {
      await this.ctx.storage.put(RESTART_KEY, { serverId: plan.restartServerId, by, expiresAt: Date.now() + RESTART_TTL_MS } satisfies PendingRestart);
    }
    // Backup pedido pelo Discord: guarda como responder quando o app avisar que terminou (leva minutos).
    let requestId: string | undefined;
    const notify = body.action.kind === 'backup' ? validBackupNotify(body.notify) : null;
    if (notify) {
      requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      await this.ctx.storage.put(`${BACKUP_NOTIFY_PREFIX}${requestId}`, { ...notify, expiresAt: Date.now() + BACKUP_NOTIFY_TTL_MS } satisfies StoredBackupNotify);
    }
    for (const message of plan.messages) {
      try { agent.send(JSON.stringify({ ...message, by, ...(requestId ? { requestId } : {}) })); } catch { return reply({ ok: false, reason: 'agent_offline' }); }
    }
    return reply({ ok: true });
  }

  /** Chamado só pelo próprio Worker (nunca exposto fora dele — Durable Objects não têm URL pública própria). */
  private async handleMintTicket(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    if (typeof body?.userId !== 'string' || !body.userId) return new Response('userId ausente.', { status: 400 });

    const isOwner = body.isOwner === true;
    const permissions = isOwner ? null : normalizePermissions(body.permissions);
    if (!isOwner && !permissions) return new Response('Permissões inválidas.', { status: 400 });

    const ticket = crypto.randomUUID();
    const pending: PendingTicket = {
      userId: body.userId,
      name: typeof body.name === 'string' && body.name ? body.name.slice(0, 80) : 'Alguém',
      isOwner,
      permissions,
      expiresAt: Date.now() + TICKET_TTL_MS,
    };
    // O usuário e as permissões já foram validados pelo Worker (dono ou
    // membro do dispositivo, com Plus do dono ativo) antes de chegar aqui —
    // o ticket só carrega isso adiante pra conexão. Guardado em ctx.storage
    // (não em memória) porque a DO pode ser evacuada entre o mint e o uso.
    await this.ctx.storage.put(`ticket:${ticket}`, pending);
    return new Response(JSON.stringify({ ticket }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async consumeTicket(ticket: string): Promise<PendingTicket | null> {
    const key = `ticket:${ticket}`;
    const pending = await this.ctx.storage.get<PendingTicket>(key);
    await this.ctx.storage.delete(key); // uso único, válido ou não
    if (!pending || Date.now() >= pending.expiresAt) return null;
    return pending;
  }

  /**
   * Derruba as conexões de painel de um membro — depois de mudar as
   * permissões dele (reconecta já com as novas) ou de removê-lo (o Worker
   * passa a negar o ticket, então ele não volta).
   */
  private async handleKick(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    if (typeof body?.userId !== 'string' || !body.userId) return new Response('userId ausente.', { status: 400 });
    const removed = body.removed === true;

    for (const ws of this.ctx.getWebSockets(`user:${body.userId}`)) {
      try { ws.close(4001, removed ? 'access-removed' : 'access-changed'); } catch { /* já fechando */ }
    }
    // Mudança: as permissões guardadas valem até o painel reconectar e gravar as novas (sem elas, nada de nomes de jogadores no push).
    await this.ctx.storage.delete(`perms:${body.userId}`);
    if (removed) await this.deletePushSubsOf(body.userId);
    return new Response(null, { status: 204 });
  }

  // ---- Inscrições de push ----

  private async handlePushSubscribe(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    const { userId, sub } = body ?? {};
    if (typeof userId !== 'string' || !userId || typeof sub?.endpoint !== 'string') return new Response('Dados inválidos.', { status: 400 });
    const isOwner = body.isOwner === true;
    if (!isOwner) {
      const permissions = normalizePermissions(body.permissions);
      if (!permissions) return new Response('Permissões inválidas.', { status: 400 });
      await this.ctx.storage.put(`perms:${userId}`, permissions);
    }

    const key = await pushKeyFor(userId, sub.endpoint);
    const all = await this.ctx.storage.list<StoredPushSub>({ prefix: PUSH_PREFIX });
    const mine = [...all].filter(([k]) => k.startsWith(`${PUSH_PREFIX}${userId}:`));
    if (!all.has(key)) {
      if (all.size >= MAX_PUSH_SUBS) return new Response('Limite de inscrições do computador atingido.', { status: 429 });
      // Mais de N aparelhos por pessoa: a inscrição mais antiga sai.
      const maxPerUser = Math.min(Number(body.maxPerUser) || 5, 10);
      if (mine.length >= maxPerUser) {
        const oldest = mine.sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        await this.ctx.storage.delete(oldest[0]);
      }
    }
    const record: StoredPushSub = {
      userId,
      isOwner,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      prefs: normalizePrefs(body.prefs),
      lang: normalizeLang(body.lang),
      createdAt: all.get(key)?.createdAt ?? Date.now(),
    };
    await this.ctx.storage.put(key, record);
    return new Response(JSON.stringify({ prefs: record.prefs }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async handlePushUnsubscribe(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    if (typeof body?.userId !== 'string' || typeof body?.endpoint !== 'string') return new Response('Dados inválidos.', { status: 400 });
    await this.ctx.storage.delete(await pushKeyFor(body.userId, body.endpoint));
    return new Response(null, { status: 204 });
  }

  private async handlePushCheck(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    if (typeof body?.userId !== 'string' || typeof body?.endpoint !== 'string') return new Response('Dados inválidos.', { status: 400 });
    const rec = await this.ctx.storage.get<StoredPushSub>(await pushKeyFor(body.userId, body.endpoint));
    return new Response(JSON.stringify(rec ? { subscribed: true, prefs: rec.prefs } : { subscribed: false }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async deletePushSubsOf(userId: string): Promise<void> {
    const keys = [...(await this.ctx.storage.list({ prefix: `${PUSH_PREFIX}${userId}:` })).keys()];
    if (keys.length) await this.ctx.storage.delete(keys);
  }

  // ---- Envio de push ----

  /** Manda o evento a quem se inscreveu e quer/pode recebê-lo. `excludeUserId` = quem causou a mudança. */
  private async notifyPush(event: PushEvent, deviceId: string | null, opts: { excludeUserId?: string } = {}): Promise<void> {
    const vapid = vapidFromEnv(this.env as PushEnv);
    if (!vapid || !deviceId) return;
    const subs = await this.ctx.storage.list<StoredPushSub>({ prefix: PUSH_PREFIX });
    for (const [key, sub] of subs) {
      if (sub.userId === opts.excludeUserId) continue;
      const perms = sub.isOwner ? OWNER_PERMISSIONS : (normalizePermissions(await this.ctx.storage.get<unknown>(`perms:${sub.userId}`)) ?? NO_PERMISSIONS);
      if (!wantsEvent(event, sub.prefs, perms)) continue;
      const message = buildMessage(event, sub.lang, deviceId, perms.start);
      const outcome = await sendWebPush(sub, toPayload(message, sub.lang), vapid, {
        ttlSeconds: event.kind === 'players' ? 300 : 3600,
        topic: message.tag,
      });
      if (outcome === 'gone') await this.ctx.storage.delete(key);
    }
  }

  private async permsFor(att: PanelAttachment): Promise<PanelPermissions> {
    if (att.isOwner) return OWNER_PERMISSIONS;
    const stored = await this.ctx.storage.get<unknown>(`perms:${att.userId}`);
    return normalizePermissions(stored) ?? NO_PERMISSIONS;
  }

  /**
   * Valida device_token contra panel_devices (service role — bypassa RLS,
   * único jeito de validar credencial que não é a sessão de ninguém) e
   * confere que a assinatura Plus do dono ainda está ativa — o dispositivo
   * pareado e o token continuam existindo mesmo depois que uma assinatura
   * expira, então sem esta segunda checagem o painel continuaria
   * funcionando de graça para quem cancelou.
   */
  private async verifyDeviceToken(deviceId: string, token: string): Promise<boolean> {
    if (!this.env.SUPABASE_SERVICE_ROLE_KEY) return false;
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/panel_devices?id=eq.${encodeURIComponent(deviceId)}&device_token=eq.${encodeURIComponent(token)}&select=user_id`,
        { headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (!resp.ok) return false;
      const rows: any = await resp.json().catch(() => []);
      const userId = rows?.[0]?.user_id;
      if (!userId) return false;
      return await userHasActiveSubscription(this.env, userId);
    } catch {
      return false;
    }
  }

  private async touchLastSeen(deviceId: string): Promise<void> {
    if (!this.env.SUPABASE_SERVICE_ROLE_KEY) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/panel_devices?id=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: {
          apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
      });
    } catch {
      // Best-effort — não bloqueia a conexão por causa de telemetria.
    }
  }

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const role = url.searchParams.get('role');
    const deviceId = url.pathname.match(/^\/panel\/ws\/([A-Za-z0-9-]+)$/)?.[1];
    if (!deviceId) return new Response('deviceId ausente na URL.', { status: 400 });

    if (role === 'agent') {
      const auth = request.headers.get('Authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token || !(await this.verifyDeviceToken(deviceId, token))) {
        return new Response('device_token inválido.', { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Encerra uma conexão de agente anterior (ex: app reiniciado) antes de
      // aceitar a nova — só um app desktop de cada vez fala por este canal.
      for (const old of this.ctx.getWebSockets('agent')) {
        try { old.close(4000, 'replaced'); } catch { /* já pode estar fechando sozinho */ }
      }
      this.ctx.acceptWebSocket(server, ['agent']);
      // O id do dispositivo só aparece na URL de conexão: guardado para os pushes (o alarm não tem URL).
      await this.ctx.storage.put('device_id', deviceId);
      // Voltou antes da carência: não há "computador offline" a avisar.
      await this.ctx.storage.delete(OFFLINE_DUE_KEY);
      void this.touchLastSeen(deviceId);
      void this.broadcastToPanels({ type: 'agent_connected' });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'panel') {
      const ticket = url.searchParams.get('ticket');
      const pending = ticket ? await this.consumeTicket(ticket) : null;
      if (!pending) {
        return new Response('Ticket inválido ou expirado.', { status: 401 });
      }

      // Permissões de membro ficam em storage por usuário (ver comentário no topo).
      if (!pending.isOwner && pending.permissions) {
        await this.ctx.storage.put(`perms:${pending.userId}`, pending.permissions);
      }
      const perms = pending.isOwner ? OWNER_PERMISSIONS : (pending.permissions ?? NO_PERMISSIONS);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['panel', `user:${pending.userId}`]);
      const attachment: PanelAttachment = { userId: pending.userId, name: pending.name, isOwner: pending.isOwner };
      server.serializeAttachment(attachment);

      const agentConnected = this.ctx.getWebSockets('agent').length > 0;
      try {
        server.send(JSON.stringify({ type: 'access', isOwner: pending.isOwner, permissions: perms }));
        server.send(JSON.stringify({ type: agentConnected ? 'agent_connected' : 'agent_disconnected' }));
        // O agent só empurra `status`/`server_list` por conta própria quando
        // CONECTA (ou numa mudança de estado do Minecraft) — um painel que
        // chega depois disso (ex: dar F5, abrir uma segunda aba) nunca via
        // nada até o próximo evento, porque não existia como ele pedir um
        // resumo do estado atual. Reproduz aqui o último retrato conhecido,
        // guardado em ctx.storage por cacheAgentSnapshot.
        if (agentConnected) {
          const [lastStatus, lastServerList, lastPlayers, logHistory] = await Promise.all([
            this.ctx.storage.get<string>('last:status'),
            this.ctx.storage.get<string>('last:server_list'),
            this.ctx.storage.get<string>('last:players'),
            this.ctx.storage.get<string[]>(LOG_HISTORY_KEY),
          ]);
          if (lastStatus) server.send(lastStatus);
          if (lastServerList) server.send(lastServerList);
          if (perms.viewConsole) {
            if (lastPlayers) server.send(lastPlayers);
            for (const line of mergeLogHistory(logHistory ?? [], this.logBuffer, LOG_HISTORY_MAX)) server.send(line);
          }
        }
      } catch { /* conexão pode já ter caído antes deste send */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('role precisa ser "agent" ou "panel".', { status: 400 });
  }

  /**
   * Manda `message` pra todos os painéis abertos. `consoleOnly` pula quem não
   * tem a permissão de ver o console (log_line e erros de comando podem
   * conter o que outros digitaram/o que o servidor imprimiu).
   */
  private async broadcastToPanels(message: unknown, opts: { consoleOnly?: boolean } = {}): Promise<void> {
    const body = JSON.stringify(message);
    const canSeeConsole = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets('panel')) {
      if (opts.consoleOnly) {
        const att = ws.deserializeAttachment() as PanelAttachment | null;
        if (!att) continue;
        let allowed = canSeeConsole.get(att.userId);
        if (allowed === undefined) {
          allowed = (await this.permsFor(att)).viewConsole;
          canSeeConsole.set(att.userId, allowed);
        }
        if (!allowed) continue;
      }
      try { ws.send(body); } catch { /* painel pode ter caído entre a listagem e o send */ }
    }
  }

  // ---- WebSocket Hibernation API ----

  /**
   * Guarda o último `status`/`server_list` recebido do agent (pra repetir
   * pra um painel que conecta depois) e um histórico curto de `log_line`
   * (pra o console do painel não voltar vazio a cada F5/segunda aba — antes
   * disso, log_line nunca era cacheado, só repassado ao vivo).
   */
  private async cacheAgentSnapshot(parsed: any, raw: string): Promise<void> {
    if (parsed?.type === 'status' || parsed?.type === 'server_list' || parsed?.type === 'players') {
      // O agent reenvia status/lista periodicamente e quase sempre nada mudou (só o `ts`):
      // ler custa bem menos que gravar, e cada gravação conta na cota do Durable Object.
      const key = `last:${parsed.type}`;
      const previous = await this.ctx.storage.get<string>(key);
      if (previous !== undefined && sameIgnoringTs(previous, raw)) return;
      await this.ctx.storage.put(key, raw);
      if (previous !== undefined) this.ctx.waitUntil(this.derivePushEvents(parsed, previous));
      return;
    }
    if (parsed?.type === 'log_line') {
      this.logBuffer.push(raw);
      if (this.logBuffer.length >= LOG_FLUSH_MAX_BUFFERED) {
        await this.flushLogBuffer();
      } else if (!this.logFlushTimer) {
        // Enquanto este timer estiver pendente o runtime não hiberna o objeto, então o lote
        // sempre é gravado (ou descartado, se o agent cair) em ~2s.
        this.logFlushTimer = setTimeout(() => { void this.flushLogBuffer(); }, LOG_FLUSH_DELAY_MS);
      }
    }
  }

  /** Compara com o retrato anterior e dispara os pushes. Sem retrato anterior (primeira mensagem após o agent conectar) é só linha de base. */
  private async derivePushEvents(parsed: any, previousRaw: string): Promise<void> {
    try {
      let previous: any;
      try { previous = JSON.parse(previousRaw); } catch { return; }
      const deviceId = (await this.ctx.storage.get<string>('device_id')) ?? null;

      if (parsed.type === 'status') {
        const change = detectStatusChange(previous, parsed);
        if (!change) return;
        const serverName = typeof parsed.serverName === 'string' ? parsed.serverName : (typeof previous?.serverName === 'string' ? previous.serverName : null);
        const expected = await this.ctx.storage.get<ExpectedChange>(EXPECTED_KEY);
        const valid = expected && Date.now() <= expected.expiresAt ? expected : null;
        if (change === 'stopped') {
          this.dropPendingPlayers(); // todos "saem" quando o servidor desliga — não é aviso útil
          if (valid?.kind === 'restart') return; // vai voltar já já; o aviso é o de "ligado"
          if (valid?.kind === 'stop') await this.ctx.storage.delete(EXPECTED_KEY);
          await this.notifyPush({ kind: 'server_stopped', serverName, by: valid?.kind === 'stop' ? valid.by : null }, deviceId, { excludeUserId: valid?.kind === 'stop' ? valid.userId : undefined });
        } else {
          if (valid) await this.ctx.storage.delete(EXPECTED_KEY);
          await this.notifyPush({ kind: 'server_started', serverName, by: valid ? valid.by : null }, deviceId, { excludeUserId: valid?.userId });
        }
        return;
      }

      if (parsed.type === 'players' && Array.isArray(parsed.players) && Array.isArray(previous?.players)) {
        const lastStatusRaw = await this.ctx.storage.get<string>('last:status');
        let running = false;
        try { running = lastStatusRaw ? JSON.parse(lastStatusRaw).serverRunning === true : false; } catch { /* trata como parado */ }
        if (!running) return;
        const names = (v: unknown[]) => v.filter((n): n is string => typeof n === 'string' && n.length > 0);
        const { joined, left } = diffPlayers(names(previous.players), names(parsed.players));
        this.queuePlayers(joined, left);
      }
    } catch (e) {
      console.error('push: falha ao derivar eventos', e);
    }
  }

  private queuePlayers(joined: string[], left: string[]): void {
    if (!joined.length && !left.length) return;
    for (const n of joined) {
      const wasLeft = this.pendingPlayers.left.findIndex((x) => x.toLowerCase() === n.toLowerCase());
      if (wasLeft >= 0) this.pendingPlayers.left.splice(wasLeft, 1); // saiu e voltou no mesmo lote: não mudou nada
      else this.pendingPlayers.joined.push(n);
    }
    for (const n of left) {
      const wasJoined = this.pendingPlayers.joined.findIndex((x) => x.toLowerCase() === n.toLowerCase());
      if (wasJoined >= 0) this.pendingPlayers.joined.splice(wasJoined, 1);
      else this.pendingPlayers.left.push(n);
    }
    if (!this.playersPushTimer && (this.pendingPlayers.joined.length || this.pendingPlayers.left.length)) {
      this.playersPushTimer = setTimeout(() => { void this.flushPlayersPush(); }, PLAYER_PUSH_DELAY_MS);
    }
  }

  private dropPendingPlayers(): void {
    if (this.playersPushTimer) { clearTimeout(this.playersPushTimer); this.playersPushTimer = null; }
    this.pendingPlayers = { joined: [], left: [] };
  }

  private async flushPlayersPush(): Promise<void> {
    this.playersPushTimer = null;
    const batch = this.pendingPlayers;
    this.pendingPlayers = { joined: [], left: [] };
    if (!batch.joined.length && !batch.left.length) return;
    try {
      await this.notifyPush({ kind: 'players', joined: batch.joined, left: batch.left }, (await this.ctx.storage.get<string>('device_id')) ?? null);
    } catch (e) {
      console.error('push: falha ao enviar aviso de jogadores', e);
    }
  }

  /** O agent caiu: avisa "computador offline" só se não voltar em OFFLINE_GRACE_MS (ver alarm). */
  private async scheduleOfflineNotice(): Promise<void> {
    this.dropPendingPlayers();
    const due = Date.now() + OFFLINE_GRACE_MS;
    await this.ctx.storage.put(OFFLINE_DUE_KEY, due);
    await this.ctx.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    const due = await this.ctx.storage.get<number>(OFFLINE_DUE_KEY);
    if (due === undefined) return; // o agent voltou antes
    if (Date.now() < due) { await this.ctx.storage.setAlarm(due); return; }
    await this.ctx.storage.delete(OFFLINE_DUE_KEY);
    if (this.ctx.getWebSockets('agent').length > 0) return;
    await this.notifyPush({ kind: 'agent_offline' }, (await this.ctx.storage.get<string>('device_id')) ?? null);
  }

  private async flushLogBuffer(): Promise<void> {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    if (this.logBuffer.length === 0) return;
    const batch = this.logBuffer;
    this.logBuffer = [];
    const stored = (await this.ctx.storage.get<string[]>(LOG_HISTORY_KEY)) ?? [];
    await this.ctx.storage.put(LOG_HISTORY_KEY, mergeLogHistory(stored, batch, LOG_HISTORY_MAX));
  }

  /** Agent caiu: o histórico some junto com o resto do cache, inclusive o que ainda estava no lote. */
  private async clearAgentCache(): Promise<void> {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    this.logBuffer = [];
    await this.ctx.storage.delete(AGENT_CACHE_KEYS);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('agent')) {
      // Log/status/lista de servidores do app desktop -> painéis abertos.
      if (typeof message !== 'string') return;
      let parsed: any;
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed?.type === 'player_action_result') {
        await this.routeActionResult(parsed);
        return;
      }
      if (parsed?.type === 'backup_result') {
        await this.routeBackupResult(parsed);
        return;
      }
      await this.cacheAgentSnapshot(parsed, message);
      await this.broadcastToPanels(parsed, { consoleOnly: parsed?.type === 'log_line' || parsed?.type === 'error' || parsed?.type === 'players' });
      if (parsed?.type === 'status' && parsed.serverRunning === false) {
        await this.maybeCompleteRestart(ws);
      }
      return;
    }
    if (tags.includes('panel')) {
      await this.handlePanelMessage(ws, message);
    }
  }

  /**
   * Confirmação de kick/ban/pardon: o relay prefixou o requestId com o userId
   * de quem pediu (ver handlePanelMessage), então a resposta volta só pras
   * conexões dele — outros painéis abertos não recebem (nem precisam).
   */
  private async routeActionResult(parsed: any): Promise<void> {
    const raw = typeof parsed.requestId === 'string' ? parsed.requestId : '';
    const dot = raw.indexOf('.');
    if (dot < 1) return;
    const userId = raw.slice(0, dot);
    const body = JSON.stringify({ ...parsed, requestId: raw.slice(dot + 1) });
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      try { ws.send(body); } catch { /* painel pode ter caído */ }
    }
  }

  /** O app terminou (ou recusou) um backup: se o pedido veio do Discord, edita a resposta do comando com o resultado. */
  private async routeBackupResult(parsed: any): Promise<void> {
    const id = typeof parsed.requestId === 'string' && /^[a-f0-9]{16}$/.test(parsed.requestId) ? parsed.requestId : null;
    if (!id) return;
    const key = `${BACKUP_NOTIFY_PREFIX}${id}`;
    const stored = await this.ctx.storage.get<StoredBackupNotify>(key);
    if (!stored) return;
    await this.ctx.storage.delete(key);
    if (Date.now() > stored.expiresAt) return;
    const content = backupResultMessage(stored, parsed);
    try {
      await fetch(`https://discord.com/api/v10/webhooks/${stored.appId}/${stored.token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
    } catch { /* o Discord pode ter recusado (prazo de 15 min): o app já mostrou o resultado ao host */ }
  }

  private sendError(ws: WebSocket, message: string): void {
    try { ws.send(JSON.stringify({ type: 'error', message })); } catch { /* já fechou */ }
  }

  /**
   * Único caminho de mensagem painel -> agent, e onde as permissões são
   * aplicadas (ver authorizePanelMessage). Nada é repassado "como veio".
   */
  private async handlePanelMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_PANEL_MESSAGE_CHARS) return;
    let parsed: unknown;
    try { parsed = JSON.parse(message); } catch { return; }

    const att = ws.deserializeAttachment() as PanelAttachment | null;
    if (!att) { try { ws.close(1008, 'sem identidade'); } catch { /* */ } return; }

    const decision = authorizePanelMessage(await this.permsFor(att), parsed);
    if (!decision.ok) {
      this.sendError(ws, decision.reason);
      return;
    }

    const agent = this.ctx.getWebSockets('agent')[0];
    if (!agent) {
      try { ws.send(JSON.stringify({ type: 'agent_disconnected' })); } catch { /* já fechou */ }
      return;
    }

    const forward = decision.forward;
    if (forward.type === 'restart_server') {
      await this.beginRestart(ws, agent, forward.serverId, att.name, att.userId);
      return;
    }
    const isConsoleStop = forward.type === 'command' && typeof (forward as any).command === 'string' && (forward as any).command.trim().replace(/^\//, '').toLowerCase() === 'stop';
    if (forward.type === 'stop_server' || isConsoleStop) {
      await this.expectChange({ kind: 'stop', userId: att.userId, by: att.name }, EXPECTED_TTL_MS);
    } else if (forward.type === 'start_server') {
      await this.expectChange({ kind: 'start', userId: att.userId, by: att.name }, EXPECTED_TTL_MS);
    }
    const outgoing = forward.type === 'player_action'
      ? { ...forward, requestId: `${att.userId}.${forward.requestId}` }
      : forward;
    try { agent.send(JSON.stringify({ ...outgoing, by: att.name })); } catch { /* agente pode ter caído */ }
  }

  /**
   * "Reiniciar" atômico: manda parar agora e só manda iniciar quando o agent
   * confirmar (status serverRunning=false) — ver maybeCompleteRestart.
   */
  private async expectChange(change: Omit<ExpectedChange, 'expiresAt'>, ttlMs: number): Promise<void> {
    await this.ctx.storage.put(EXPECTED_KEY, { ...change, expiresAt: Date.now() + ttlMs } satisfies ExpectedChange);
  }

  private async beginRestart(ws: WebSocket, agent: WebSocket, serverId: string, by: string, userId: string): Promise<void> {
    let running = false;
    try {
      const raw = await this.ctx.storage.get<string>('last:status');
      running = raw ? JSON.parse(raw).serverRunning === true : false;
    } catch { /* trata como parado */ }
    if (!running) {
      this.sendError(ws, 'O servidor não está rodando — use "Iniciar".');
      return;
    }
    const pending: PendingRestart = { serverId, by, expiresAt: Date.now() + RESTART_TTL_MS };
    await this.ctx.storage.put(RESTART_KEY, pending);
    await this.expectChange({ kind: 'restart', userId, by }, EXPECTED_RESTART_TTL_MS);
    try { agent.send(JSON.stringify({ type: 'stop_server', by })); } catch { /* agente pode ter caído */ }
  }

  private async maybeCompleteRestart(agent: WebSocket): Promise<void> {
    const pending = await this.ctx.storage.get<PendingRestart>(RESTART_KEY);
    if (!pending) return;
    await this.ctx.storage.delete(RESTART_KEY); // uma vez só
    if (Date.now() > pending.expiresAt) return;
    try { agent.send(JSON.stringify({ type: 'start_server', serverId: pending.serverId, by: pending.by })); } catch { /* agente pode ter caído */ }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    if (this.ctx.getTags(ws).includes('agent')) {
      await this.clearAgentCache();
      await this.broadcastToPanels({ type: 'agent_disconnected' });
      await this.scheduleOfflineNotice();
    }
    try { ws.close(); } catch { /* já fechado */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.ctx.getTags(ws).includes('agent')) {
      await this.clearAgentCache();
      await this.broadcastToPanels({ type: 'agent_disconnected' });
      await this.scheduleOfflineNotice();
    }
  }
}
