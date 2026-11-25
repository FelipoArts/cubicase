// ============================================================
// Transporte P2P (cubicase-link) — tokens de sinalização e credenciais ICE
// ============================================================
// Plano: plans/p2p-link-transport-plan.md (§6.3). Este módulo não conhece o Worker
// inteiro (nem json()/ok()): só assina/verifica tokens e monta o que o sidecar precisa
// para se conectar (sala de sinalização + servidores STUN). Não há servidor de relay: a conexão é direta.
// ============================================================

export interface LinkEnv {
  /** Segredo do HMAC dos tokens de sinalização. `wrangler secret put LINK_TOKEN_SECRET`. */
  LINK_TOKEN_SECRET?: string;
  /** STUN extra/substituto, separado por vírgula. */
  STUN_URLS?: string;
}

export type LinkRole = 'host' | 'guest';

export interface LinkClaims {
  /** shortCode do servidor (a sala). */
  sc: string;
  role: LinkRole;
  /** Sessão (ConnectionSession) dona do token. */
  pid: string;
  /**
   * Conta (Supabase) de quem pediu a sessão, quando estava logado. Só o Worker grava este campo, depois de validar
   * o token da conta; o cliente nunca escolhe. Serve para a lista de membros (perfil público). Tokens antigos não têm.
   */
  uid?: string;
  iat: number;
  exp: number;
}

/**
 * Vida do token de sinalização. O token só é conferido ao conectar na sala, mas a
 * sala reconecta sempre que o WebSocket cai; um host que fica semanas ligado precisa de um token que
 * ainda valha nessa hora (se expirar, o sidecar sai e o app cria uma sessão nova).
 */
export const LINK_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

/** Token `Bearer` do cabeçalho Authorization, se houver. */
export function bearerToken(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

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
    if (c.uid !== undefined && typeof c.uid !== 'string') return null;
    return c as LinkClaims;
  } catch {
    return null;
  }
}

export interface LinkCredentials {
  signalUrl: string;
  signalToken: string;
  peerId: string;
  /** Sempre false e "off": o relay não existe mais. Só para apps antigos, que ainda leem esses campos. */
  relayOnly: false;
  relay: 'off';
  ice: { stunUrls: string[] };
}

/** O que o sidecar recebe na ConnectionSession `link-v1` (ver cubicase-link/config.go). */
export async function buildLinkCredentials(
  env: LinkEnv,
  opts: { origin: string; shortCode: string; role: LinkRole; peerId: string; /** Conta já validada de quem pediu a sessão (entra no token como `uid`). */ userId?: string | null },
): Promise<LinkCredentials> {
  const signalToken = await signLinkToken(env, { sc: opts.shortCode, role: opts.role, pid: opts.peerId, ...(opts.userId ? { uid: opts.userId } : {}) });
  const wsOrigin = opts.origin.replace(/^http/, 'ws'); // https → wss, http → ws
  const stunUrls = env.STUN_URLS ? env.STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_STUN;
  return {
    signalUrl: `${wsOrigin}/api/v1/link/ws/${opts.shortCode}`,
    signalToken,
    peerId: opts.peerId,
    relayOnly: false,
    relay: 'off',
    ice: { stunUrls },
  };
}
