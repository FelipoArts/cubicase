// ============================================================
// Transporte P2P (cubicase-link) — tokens de sinalização e credenciais ICE
// ============================================================
// Plano: plans/p2p-link-transport-plan.md (§6.3). Este módulo não conhece o Worker
// inteiro (nem json()/ok()): só assina/verifica tokens e monta o que o sidecar precisa
// para se conectar (sala de sinalização + servidores STUN/TURN).
// ============================================================

export interface LinkEnv {
  /** Segredo do HMAC dos tokens de sinalização. `wrangler secret put LINK_TOKEN_SECRET`. */
  LINK_TOKEN_SECRET?: string;
  /** Segredo compartilhado com o coturn (use-auth-secret). `wrangler secret put TURN_SECRET`. */
  TURN_SECRET?: string;
  /** URLs do relay, separadas por vírgula (ex.: "turn:turn.cubicase.net:3478,turns:turn.cubicase.net:443?transport=tcp"). */
  TURN_URLS?: string;
  /** "1" corta a emissão de credenciais do relay NA HORA (freio de custo — sem deploy). */
  TURN_DISABLED?: string;
  /** STUN extra/substituto, separado por vírgula. */
  STUN_URLS?: string;
  /** Cota mensal de relay (bytes) de um servidor sem Cubicase Plus. Padrão: 5 GiB. */
  RELAY_FREE_MONTHLY_BYTES?: string;
}

export type LinkRole = 'host' | 'guest';

export interface LinkClaims {
  /** shortCode do servidor (a sala). */
  sc: string;
  role: LinkRole;
  /** Sessão (ConnectionSession) dona do token. */
  pid: string;
  iat: number;
  exp: number;
}

/**
 * Vida do token de sinalização e das credenciais TURN. O token só é conferido ao conectar na sala, mas a
 * sala reconecta sempre que o WebSocket cai; um host que fica semanas ligado precisa de um token que
 * ainda valha nessa hora (se expirar, o sidecar sai e o app cria uma sessão nova). As credenciais do
 * relay também precisam valer enquanto a alocação for renovada.
 */
export const LINK_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(hash: 'SHA-256' | 'SHA-1', secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** JWT HS256 mínimo: header.payload.assinatura (base64url). */
export async function signLinkToken(env: LinkEnv, claims: Omit<LinkClaims, 'iat' | 'exp'>, nowMs = Date.now()): Promise<string> {
  if (!env.LINK_TOKEN_SECRET) throw new Error('LINK_TOKEN_SECRET ausente');
  const iat = Math.floor(nowMs / 1000);
  const full: LinkClaims = { ...claims, iat, exp: iat + LINK_TOKEN_TTL_SECONDS };
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(full)));
  const sig = b64urlEncode(await hmac('SHA-256', env.LINK_TOKEN_SECRET, `${head}.${body}`));
  return `${head}.${body}.${sig}`;
}

/** Devolve as claims se a assinatura e a validade estiverem corretas; senão null. */
export async function verifyLinkToken(env: LinkEnv, token: string | null | undefined, nowMs = Date.now()): Promise<LinkClaims | null> {
  if (!env.LINK_TOKEN_SECRET || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0 || p.length > 2048)) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (header?.alg !== 'HS256') return null; // nunca aceita "none" nem outro algoritmo
    const expected = await hmac('SHA-256', env.LINK_TOKEN_SECRET, `${parts[0]}.${parts[1]}`);
    if (!timingSafeEqualBytes(expected, b64urlDecode(parts[2]))) return null;
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as Partial<LinkClaims>;
    if (typeof c.sc !== 'string' || typeof c.pid !== 'string' || (c.role !== 'host' && c.role !== 'guest')) return null;
    if (typeof c.exp !== 'number' || typeof c.iat !== 'number' || nowMs / 1000 >= c.exp) return null;
    return c as LinkClaims;
  } catch {
    return null;
  }
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

/**
 * Credenciais efêmeras no esquema "REST API" do coturn: username = <expiração>:<id>,
 * credential = base64(HMAC-SHA1(segredo, username)). null se o relay não está
 * configurado ou foi desligado (TURN_DISABLED=1).
 */
export async function makeTurnCredentials(env: LinkEnv, peerId: string, nowMs = Date.now()): Promise<TurnCredentials | null> {
  if (env.TURN_DISABLED === '1' || !env.TURN_SECRET || !env.TURN_URLS) return null;
  const urls = env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return null;
  const expiry = Math.floor(nowMs / 1000) + LINK_TOKEN_TTL_SECONDS;
  const username = `${expiry}:${peerId}`;
  const credential = btoa(String.fromCharCode(...(await hmac('SHA-1', env.TURN_SECRET, username))));
  return { urls, username, credential };
}

/**
 * Estado do relay nesta sessão: "ok" (credenciais emitidas), "quota" (a cota gratuita do mês acabou —
 * só a conexão direta e o plano B) ou "off" (relay desligado/sem configuração).
 */
export type RelayState = 'ok' | 'quota' | 'off';

export interface LinkCredentials {
  signalUrl: string;
  signalToken: string;
  peerId: string;
  relayOnly: boolean;
  relay: RelayState;
  ice: { stunUrls: string[]; turn?: TurnCredentials };
}

/** O que o sidecar recebe na ConnectionSession `link-v1` (ver cubicase-link/config.go). */
export async function buildLinkCredentials(
  env: LinkEnv,
  opts: { origin: string; shortCode: string; role: LinkRole; peerId: string; relayOnly: boolean; /** false = cota do mês esgotada: não emite credenciais do relay. */ relayAllowed?: boolean },
): Promise<LinkCredentials> {
  const signalToken = await signLinkToken(env, { sc: opts.shortCode, role: opts.role, pid: opts.peerId });
  const relayAllowed = opts.relayAllowed !== false;
  const turn = relayAllowed ? await makeTurnCredentials(env, opts.peerId) : null;
  const relay: RelayState = turn ? 'ok' : relayAllowed ? 'off' : 'quota';
  const wsOrigin = opts.origin.replace(/^http/, 'ws'); // https → wss, http → ws
  const stunUrls = env.STUN_URLS ? env.STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_STUN;
  return {
    signalUrl: `${wsOrigin}/api/v1/link/ws/${opts.shortCode}`,
    signalToken,
    peerId: opts.peerId,
    // Só vale relay forçado se há relay para usar.
    relayOnly: opts.relayOnly && !!turn,
    relay,
    ice: { stunUrls, ...(turn ? { turn } : {}) },
  };
}

// ------------------------------------------------------------
// Cota mensal de relay (servidores sem Cubicase Plus)
// ------------------------------------------------------------
// O que custa é o tráfego que SAI da VM do relay. Quem mede é o próprio coturn (log "usage:" de
// cada alocação), e um serviço na VM reporta os totais ao Worker (ver infra/relay/relay-usage-reporter.py
// e handleRelayUsage). O Worker soma por servidor e por mês; passou da cota, deixa de emitir
// credenciais do relay até o mês virar — a conexão direta e o plano B (Radmin) seguem livres.

export const RELAY_FREE_MONTHLY_BYTES_DEFAULT = 5 * 1024 ** 3;

export function relayQuotaBytes(env: LinkEnv): number {
  const n = Number(env.RELAY_FREE_MONTHLY_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : RELAY_FREE_MONTHLY_BYTES_DEFAULT;
}

/** Chave do KV com os bytes de relay usados por um servidor no mês (UTC) de `nowMs`. */
export function relayUsageKey(shortCode: string, nowMs = Date.now()): string {
  const d = new Date(nowMs);
  return `relayuse:${shortCode}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Assinatura (HMAC-SHA256 em hex, com o TURN_SECRET) que o reporter da VM manda junto do corpo. */
export async function signRelayUsage(env: LinkEnv, rawBody: string): Promise<string> {
  if (!env.TURN_SECRET) throw new Error('TURN_SECRET ausente');
  return toHex(await hmac('SHA-256', env.TURN_SECRET, rawBody));
}

export async function verifyRelayUsageSignature(env: LinkEnv, rawBody: string, signature: string | null): Promise<boolean> {
  if (!env.TURN_SECRET || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = enc.encode(await signRelayUsage(env, rawBody));
  return timingSafeEqualBytes(expected, enc.encode(signature));
}
