// ============================================================
// LinkRoom — sala de sinalização do transporte P2P (um Durable Object por servidor)
// ============================================================
// Nome do DO = shortCode. Reúne o host e os convidados de UM servidor e só encaminha
// mensagens de sinalização entre eles (oferta/resposta/candidatos ICE) — os dados do
// jogo NUNCA passam por aqui (vão direto entre os peers ou pelo relay TURN).
//
// Protocolo (espelho de src-tauri/sidecars/cubicase-link/signal.go):
//   peer → sala : hello | offer | answer | ice | bye
//   sala → peer : host_online | host_left | peer_joined | peer_left | error
// Regras de segurança aplicadas AQUI:
//   - o token (JWT HS256) é verificado a cada conexão: papel, sessão e sala vêm dele;
//   - o `from` é SEMPRE preenchido pela sala (convidado não escolhe identidade);
//   - convidado só fala com o host; host só responde a convidados que existem;
//   - tamanho de mensagem, taxa de mensagens e nº de convidados são limitados.
//
// Presença: o host conectado = servidor "online" na rede. A sala publica isso na
// ConnectionSession (KV) só quando muda (2 gravações por sessão), substituindo os
// heartbeats de 60 s do modelo anterior.
// ============================================================

import { verifyLinkToken, LINK_TOKEN_TTL_SECONDS, type LinkClaims, type LinkEnv } from '../link';

interface Env extends LinkEnv {
  CUBEFORGE_REGISTRY: KVNamespace;
  /** Limite de convidados na sala (rede de proteção; o host tem o próprio limite). */
  LINK_MAX_GUESTS?: string;
}

export const MAX_SIGNAL_CHARS = 64 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 120; // por conexão, a cada 10 s (trickle ICE de uma conexão cabe com folga)
const DEFAULT_MAX_GUESTS = 50;
const REVOKED_PREFIX = 'revoked:';
const ALLOWED_FROM_GUEST = new Set(['hello', 'offer', 'ice', 'bye']);
const ALLOWED_FROM_HOST = new Set(['hello', 'answer', 'ice', 'error', 'bye']);

interface Attachment {
  role: 'host' | 'guest';
  /** guestId (atribuído pela sala) ou, no host, "host". */
  id: string;
  /** Sessão (peerId) do token. */
  pid: string;
  sc: string;
}

export class LinkRoom {
  private ctx: DurableObjectState;
  private env: Env;
  /** Janela de taxa por conexão (em memória: reiniciar o DO só zera a contagem). */
  private rate = new WeakMap<WebSocket, { start: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/close') return this.handleClose();
    if (request.method === 'GET' && url.pathname === '/presence') return this.handlePresence();
    if (request.method === 'POST' && url.pathname === '/revoke') return this.handleRevoke(request);
    if (request.headers.get('Upgrade') === 'websocket') return this.handleUpgrade(request, url);
    return new Response('Not found', { status: 404 });
  }

  /**
   * Presença AGORA, com consistência forte (a sala é a fonte da verdade). A descoberta usa isto
   * em vez de esperar o KV: ele é eventualmente consistente e a presença publicada nele podia
   * levar quase 1 minuto para aparecer em outra região (medido em produção: 48 s).
   */
  private handlePresence(): Response {
    const host = this.ctx.getWebSockets('host')[0];
    const att = host?.deserializeAttachment() as Attachment | null;
    return Response.json({
      hostOnline: !!host,
      hostSession: att?.pid ?? null,
      guests: this.ctx.getWebSockets('guest').length,
    });
  }

  /** Chamado pelo Worker quando o servidor é apagado ou o código regenerado: derruba todo mundo. */
  private async handleClose(): Promise<Response> {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4002, 'room-closed'); } catch { /* já fechando */ }
    }
    return new Response(null, { status: 204 });
  }

  /**
   * Revoga uma sessão (peerId): derruba as conexões dela e passa a recusar o token. O token é um JWT que vale
   * dias; sem esta lista, uma sessão apagada ou substituída continuaria entrando na sala. A lista vive no
   * storage do DO (consistência forte) — o KV levaria até ~1 min para propagar e deixaria uma janela aberta.
   */
  private async handleRevoke(request: Request): Promise<Response> {
    let pid: unknown;
    try { pid = ((await request.json()) as { pid?: unknown }).pid; } catch { /* corpo inválido */ }
    if (typeof pid !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(pid)) return new Response('pid inválido', { status: 400 });
    const now = Date.now();
    await this.ctx.storage.put(REVOKED_PREFIX + pid, now);
    // Poda quem já passou da vida máxima do token (o token venceria sozinho de qualquer forma).
    const old = await this.ctx.storage.list<number>({ prefix: REVOKED_PREFIX });
    const stale = [...old].filter(([, at]) => now - at > (LINK_TOKEN_TTL_SECONDS + 3600) * 1000).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.pid === pid) { try { ws.close(4001, 'session-revoked'); } catch { /* já fechando */ } }
    }
    return new Response(null, { status: 204 });
  }

  private async handleUpgrade(request: Request, url: URL): Promise<Response> {
    const shortCode = url.pathname.match(/\/api\/v1\/link\/ws\/([A-Za-z0-9]+)$/)?.[1]?.toUpperCase();
    if (!shortCode) return new Response('sala ausente na URL', { status: 400 });

    const auth = request.headers.get('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const claims = await verifyLinkToken(this.env, token);
    if (!claims || claims.sc !== shortCode) return new Response('token inválido', { status: 401 });
    if (await this.ctx.storage.get(REVOKED_PREFIX + claims.pid)) return new Response('sessão revogada', { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (claims.role === 'host') {
      // Um host por sala: uma conexão nova (app reiniciado) substitui a anterior.
      for (const old of this.ctx.getWebSockets('host')) {
        try { old.close(4000, 'replaced'); } catch { /* já pode estar fechando */ }
      }
      const att: Attachment = { role: 'host', id: 'host', pid: claims.pid, sc: shortCode };
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment(att);
      // Convidados já na sala passam a ver o novo host (com a sessão dele: se mudou, renegociam).
      this.broadcastToGuests({ t: 'host_online', peerId: claims.pid });
      void this.publishPresence(claims, 'online');
      return new Response(null, { status: 101, webSocket: client });
    }

    // convidado
    const max = Math.max(1, Number(this.env.LINK_MAX_GUESTS) || DEFAULT_MAX_GUESTS);
    if (this.ctx.getWebSockets('guest').length >= max) {
      server.accept();
      server.send(JSON.stringify({ t: 'error', code: 'ROOM_FULL', detail: 'sala cheia' }));
      server.close(4003, 'room-full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const guestId = crypto.randomUUID().slice(0, 8);
    const att: Attachment = { role: 'guest', id: guestId, pid: claims.pid, sc: shortCode };
    this.ctx.acceptWebSocket(server, ['guest', `guest:${guestId}`]);
    server.serializeAttachment(att);
    const host = this.ctx.getWebSockets('host')[0];
    const hostAtt = host?.deserializeAttachment() as Attachment | null;
    server.send(JSON.stringify(host ? { t: 'host_online', peerId: hostAtt?.pid } : { t: 'host_left' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket Hibernation API ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_SIGNAL_CHARS) return;
    if (this.rateLimited(ws)) {
      this.send(ws, { t: 'error', code: 'RATE_LIMITED', detail: 'mensagens demais' });
      return;
    }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) { try { ws.close(1008, 'sem identidade'); } catch { /* */ } return; }

    let m: any;
    try { m = JSON.parse(message); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

    if (att.role === 'guest') {
      if (!ALLOWED_FROM_GUEST.has(m.t) || m.t === 'hello') return; // hello já foi validado pelo token
      const host = this.ctx.getWebSockets('host')[0];
      if (!host) { this.send(ws, { t: 'host_left' }); return; }
      // Reconstrói a mensagem: só os campos conhecidos, com from = id do convidado.
      this.send(host, this.clean(m, { from: att.id }));
      return;
    }

    // host
    if (!ALLOWED_FROM_HOST.has(m.t) || m.t === 'hello') return;
    if (typeof m.to !== 'string') return;
    const target = this.ctx.getWebSockets(`guest:${m.to}`)[0];
    if (!target) return; // convidado já saiu
    this.send(target, this.clean(m, { from: 'host' }));
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.onGone(ws);
    try { ws.close(); } catch { /* já fechado */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (att.role === 'host') {
      // Pode ter sido SUBSTITUÍDO por um host novo (reconexão): só avisa se não há outro.
      const stillHost = this.ctx.getWebSockets('host').some((h) => h !== ws);
      if (stillHost) return;
      this.broadcastToGuests({ t: 'host_left' });
      void this.publishPresence({ sc: att.sc, role: 'host', pid: att.pid, iat: 0, exp: 0 }, 'stopped');
    } else {
      const host = this.ctx.getWebSockets('host')[0];
      if (host) this.send(host, { t: 'peer_left', from: att.id });
    }
  }

  // ---- utilidades ----

  /** Copia só os campos permitidos da mensagem e força o `from` (ou o `to`) da sala. */
  private clean(m: any, force: { from: string }): Record<string, unknown> {
    const out: Record<string, unknown> = { t: m.t, from: force.from };
    if (typeof m.to === 'string') out.to = m.to;
    if (typeof m.sdp === 'string' && m.sdp.length <= MAX_SIGNAL_CHARS) out.sdp = m.sdp;
    if (m.candidate && typeof m.candidate === 'object') out.candidate = m.candidate;
    if (typeof m.code === 'string') out.code = m.code.slice(0, 64);
    if (typeof m.detail === 'string') out.detail = m.detail.slice(0, 200);
    return out;
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* conexão pode ter caído */ }
  }

  private broadcastToGuests(msg: unknown): void {
    const body = JSON.stringify(msg);
    for (const g of this.ctx.getWebSockets('guest')) {
      try { g.send(body); } catch { /* idem */ }
    }
  }

  private rateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.start > RATE_WINDOW_MS) {
      r = { start: now, count: 0 };
      this.rate.set(ws, r);
    }
    r.count++;
    return r.count > RATE_MAX_MESSAGES;
  }

  /**
   * Reflete "host conectado/desconectado" na ConnectionSession do host (KV), que é de onde
   * a descoberta (GET /servers/{sc}) lê o estado da rede. Só em mudança de estado.
   */
  private async publishPresence(claims: LinkClaims, status: 'online' | 'stopped'): Promise<void> {
    try {
      const raw = await this.env.CUBEFORGE_REGISTRY.get(`csession:${claims.pid}`);
      if (!raw) return;
      const cs = JSON.parse(raw);
      if (cs.status === status) return;
      cs.status = status;
      cs.lastHeartbeat = new Date().toISOString();
      await this.env.CUBEFORGE_REGISTRY.put(`csession:${claims.pid}`, JSON.stringify(cs), { expirationTtl: LINK_TOKEN_TTL_SECONDS });
    } catch {
      // Best-effort: a sala funciona mesmo se o KV falhar.
    }
  }
}
