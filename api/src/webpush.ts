// ============================================================
// Web Push (RFC 8030 + VAPID RFC 8292 + criptografia aes128gcm RFC 8291) só com WebCrypto
// ============================================================
// Os pacotes npm de web push dependem do Node (crypto/https) e não rodam em Workers, então isto implementa
// o mínimo: cifrar a mensagem para a inscrição do navegador, assinar o cabeçalho VAPID e fazer o POST ao
// serviço de push (FCM, Mozilla, Apple, Windows). Usado pelo Durable Object do painel (host-channel.ts).
// Chaves VAPID: `node api/scripts/gen-vapid.mjs` gera o par; a pública também vai para o navegador.
// ============================================================

const enc = new TextEncoder();

export interface PushSubscriptionKeys {
  endpoint: string;
  /** Chave pública P-256 do navegador (65 bytes, base64url). */
  p256dh: string;
  /** Segredo de autenticação (16 bytes, base64url). */
  auth: string;
}

export interface VapidKeys {
  /** Ponto público P-256 não comprimido (65 bytes), base64url. */
  publicKey: string;
  /** Escalar privado (32 bytes), base64url. */
  privateKey: string;
  /** "mailto:..." ou URL https — o serviço de push usa para contatar o operador. */
  subject: string;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Só para teste: fixa o par efêmero e o sal. Em produção sempre aleatórios. */
export interface EncryptOverrides {
  serverKeys?: CryptoKeyPair;
  salt?: Uint8Array;
}

/** Corpo `aes128gcm` (RFC 8291) de uma mensagem para a inscrição do navegador. */
export async function encryptPayload(
  payload: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  overrides: EncryptOverrides = {},
): Promise<Uint8Array> {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh inválida');
  if (authSecret.length !== 16) throw new Error('auth inválido');

  const serverKeys = overrides.serverKeys
    ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256));

  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, serverPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Um único registro: dados + 0x02 (delimitador do último registro). O limite do registro é 4096 bytes.
  if (payload.length > 4096 - 17 - 1) throw new Error('mensagem grande demais para push');
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(21 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concat(header, cipher);
}

async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(keys.publicKey);
  if (pub.length !== 65) throw new Error('VAPID_PUBLIC_KEY inválida');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: keys.privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** Cabeçalho `Authorization: vapid t=<jwt>, k=<chave pública>` para o serviço de push do `endpoint`. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 3600, sub: keys.subject })));
  const signingInput = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importVapidSigningKey(keys), enc.encode(signingInput)));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

/** Serviços de push dos navegadores. O endpoint vem do cliente, então só estes destinos são aceitos (evita SSRF). */
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return PUSH_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`));
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/** Envia `message` (JSON) à inscrição. `gone` = o navegador cancelou/expirou (apague a inscrição). */
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  message: unknown,
  keys: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {},
): Promise<PushOutcome> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return 'gone';
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(message)), b64urlDecode(sub.p256dh), b64urlDecode(sub.auth));
    const headers: Record<string, string> = {
      Authorization: await vapidAuthorization(sub.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlSeconds ?? 3600),
      Urgency: opts.urgency ?? 'normal',
    };
    if (opts.topic) headers.Topic = opts.topic;
    const resp = await fetch(sub.endpoint, { method: 'POST', headers, body });
    if (resp.status === 404 || resp.status === 410) return 'gone';
    return resp.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
