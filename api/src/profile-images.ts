// ============================================================
// Imagens de perfil: foto e banner (só Cubicase Plus)
// ============================================================
// O app recorta e comprime a imagem para o tamanho exato (e apaga dados escondidos, como a localização de uma foto) e
// envia um WebP. O Worker NÃO confia nisso: confere o formato, o tamanho em bytes e as dimensões do próprio arquivo.
//
// As imagens ficam no R2 como objetos imutáveis chaveados pelo hash do conteúdo ("img/<hash>"); o banco guarda só o
// hash em profiles (avatar_hash / banner_hash). O hash vira a URL pública da imagem: não contém a conta de ninguém e
// não dá para adivinhar. Quem deixa de assinar o Plus continua com os arquivos guardados, mas os outros param de ver.
//
// Mesmo padrão de profile.ts: devolve um PanelResult simples; o roteador (index.ts) embrulha.
// ============================================================

import { resolveSupabaseUser, supabaseService, userHasActiveSubscription, type SupabaseEnv } from './supabase';
import { toPublic, type PublicProfile } from './profile';
import type { PanelResult } from './panel-members';

export interface ImagesEnv extends SupabaseEnv {
  PROFILE_IMAGES: R2Bucket;
}

export type ImageKind = 'avatar' | 'banner';

/** Dimensões exatas de cada tipo (o app gera exatamente isto) e o teto de bytes. */
export const IMAGE_SPECS: Record<ImageKind, { width: number; height: number; maxBytes: number }> = {
  avatar: { width: 256, height: 256, maxBytes: 120 * 1024 },
  banner: { width: 960, height: 320, maxBytes: 300 * 1024 },
};

/**
 * Intervalo mínimo entre dois envios da mesma conta (evita martelar o R2 e o banco). Curto de propósito: quem troca a
 * foto e logo em seguida o banner, ou refaz uma escolha, não pode ser barrado (era de 15 s e travava a troca direta).
 */
export const UPLOAD_COOLDOWN_MS = 3_000;

const HASH = /^[a-f0-9]{32}$/;

const res = (status: number, code: string, message: string, data?: unknown): PanelResult => ({ status, code, message, data });
const OK = (message: string, data?: unknown) => res(200, 'SUCCESS', message, data);
const UNAUTHORIZED = res(401, 'BAD_REQUEST', 'Sessão inválida ou expirada. Faça login novamente.');
const NOT_CONFIGURED = res(503, 'INTERNAL_ERROR', 'Imagens de perfil não configuradas neste servidor.');

// ------------------------------------------------------------
// Leitura do cabeçalho de um WebP
// ------------------------------------------------------------

export interface WebpInfo { width: number; height: number; animated: boolean }

const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/**
 * Lê largura, altura e se é animado direto do cabeçalho (sem decodificar a imagem). `null` se não for um WebP válido.
 * Cobre os três formatos: VP8 (com perdas), VP8L (sem perdas) e VP8X (estendido).
 */
export function parseWebp(bytes: Uint8Array): WebpInfo | null {
  if (bytes.length < 30 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null;
  // O tamanho declarado no RIFF tem de bater com o arquivo (barra arquivo truncado ou com lixo no fim)
  const declared = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  if (declared + 8 !== bytes.length) return null;

  if (ascii(bytes, 12, 'VP8 ')) {
    // quadro-chave: 3 bytes de tag, código de início 9d 01 2a, depois largura e altura (14 bits cada)
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff, animated: false };
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null;
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (ascii(bytes, 12, 'VP8X')) {
    const animated = (bytes[20] & 0x02) !== 0;
    return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1, animated };
  }
  return null;
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ImageCheck = { ok: true; hash: string } | { ok: false; status: number; message: string };

/** Confere o arquivo recebido para o tipo pedido e calcula o hash que o identifica. */
export async function checkImage(kind: ImageKind, bytes: Uint8Array): Promise<ImageCheck> {
  const spec = IMAGE_SPECS[kind];
  if (bytes.length === 0) return { ok: false, status: 400, message: 'Nenhuma imagem enviada.' };
  if (bytes.length > spec.maxBytes) return { ok: false, status: 413, message: `A imagem passou de ${Math.round(spec.maxBytes / 1024)} KB.` };
  const info = parseWebp(bytes);
  if (!info) return { ok: false, status: 415, message: 'Formato não aceito. Envie uma imagem WebP.' };
  if (info.animated) return { ok: false, status: 415, message: 'Imagens animadas não são aceitas.' };
  if (info.width !== spec.width || info.height !== spec.height) {
    return { ok: false, status: 400, message: `A imagem precisa ter ${spec.width}x${spec.height} pixels.` };
  }
  return { ok: true, hash: await hashOf(bytes) };
}

// ------------------------------------------------------------
// Banco e R2
// ------------------------------------------------------------

interface ImageRow {
  user_id: string;
  display_name: string;
  avatar_id: string;
  name_color: string | null;
  bio: string | null;
  avatar_hash: string | null;
  banner_hash: string | null;
  images_updated_at: string | null;
}

const COLUMN: Record<ImageKind, 'avatar_hash' | 'banner_hash'> = { avatar: 'avatar_hash', banner: 'banner_hash' };

async function getRow(env: ImagesEnv, userId: string): Promise<ImageRow | null> {
  const resp = await supabaseService(
    env,
    `/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id,display_name,avatar_id,name_color,bio,avatar_hash,banner_hash,images_updated_at`,
  );
  if (!resp.ok) return null;
  const list: unknown = await resp.json().catch(() => []);
  return Array.isArray(list) ? ((list[0] as ImageRow | undefined) ?? null) : null;
}

const objectKey = (hash: string) => `img/${hash}`;

/** Algum perfil ainda aponta para este hash? (o mesmo arquivo pode ser de duas contas se os bytes forem idênticos) */
async function stillReferenced(env: ImagesEnv, hash: string): Promise<boolean> {
  const resp = await supabaseService(env, `/rest/v1/profiles?or=(avatar_hash.eq.${hash},banner_hash.eq.${hash})&select=user_id&limit=1`);
  if (!resp.ok) return true; // na dúvida, não apaga
  const list: unknown = await resp.json().catch(() => []);
  return !Array.isArray(list) || list.length > 0;
}

/** Apaga o arquivo do R2 se ninguém mais usa. `force` apaga mesmo assim (moderação). Best-effort. */
export async function purgeImage(env: ImagesEnv, hash: string | null | undefined, force = false): Promise<void> {
  if (!hash || !HASH.test(hash)) return;
  try {
    if (force || !(await stillReferenced(env, hash))) await env.PROFILE_IMAGES.delete(objectKey(hash));
  } catch (e) {
    console.error('Falha ao apagar imagem do R2:', e);
  }
}

// ------------------------------------------------------------
// Rotas: PUT/DELETE /api/v1/profile/me/{avatar|banner}
// ------------------------------------------------------------

export async function handleProfileImageRoute(req: Request, env: ImagesEnv, method: string, path: string, nowMs = Date.now()): Promise<PanelResult | null> {
  const m = path.match(/^\/api\/v1\/profile\/me\/(avatar|banner)$/);
  if (!m || (method !== 'PUT' && method !== 'DELETE')) return null;
  const kind = m[1] as ImageKind;
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.PROFILE_IMAGES) return NOT_CONFIGURED;

  const user = await resolveSupabaseUser(req);
  if (!user) return UNAUTHORIZED;
  const row = await getRow(env, user.id);
  if (!row) return res(400, 'BAD_REQUEST', 'Crie o seu perfil antes de enviar imagens.');
  const column = COLUMN[kind];

  const respond = (updated: ImageRow, message: string) => OK(message, { profile: toPublic(updated) satisfies PublicProfile });

  if (method === 'DELETE') {
    const old = row[column];
    const resp = await supabaseService(env, `/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [column]: null, updated_at: new Date(nowMs).toISOString() }),
    });
    if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível remover a imagem.');
    await purgeImage(env, old);
    return respond({ ...row, [column]: null }, 'Imagem removida.');
  }

  // PUT: só quem assina o Plus envia imagens
  if (!(await userHasActiveSubscription(env, user.id))) {
    return res(403, 'SUBSCRIPTION_REQUIRED', 'Enviar foto e banner é um recurso do Cubicase Plus.');
  }
  const last = row.images_updated_at ? Date.parse(row.images_updated_at) : 0;
  if (Number.isFinite(last) && nowMs - last < UPLOAD_COOLDOWN_MS) {
    return res(429, 'RATE_LIMITED', 'Aguarde um instante e tente de novo.');
  }

  // Corta cedo por Content-Length, sem ler um corpo enorme
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > IMAGE_SPECS[kind].maxBytes) {
    return res(413, 'BAD_REQUEST', `A imagem passou de ${Math.round(IMAGE_SPECS[kind].maxBytes / 1024)} KB.`);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  const check = await checkImage(kind, bytes);
  if (!check.ok) return res(check.status, 'BAD_REQUEST', check.message);

  await env.PROFILE_IMAGES.put(objectKey(check.hash), bytes, {
    httpMetadata: { contentType: 'image/webp' },
  });
  const resp = await supabaseService(env, `/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ [column]: check.hash, images_updated_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() }),
  });
  if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível salvar a imagem.');
  if (row[column] && row[column] !== check.hash) await purgeImage(env, row[column]); // a anterior, se ninguém mais usa
  return respond({ ...row, [column]: check.hash }, 'Imagem salva.');
}

// ------------------------------------------------------------
// GET /api/v1/profile-image/{hash} — a imagem em si
// ------------------------------------------------------------

/**
 * Serve a imagem pelo hash. Pública (o hash não dá para adivinhar e não identifica ninguém). O navegador/webview guarda
 * por um ano (o conteúdo de um hash nunca muda; se a imagem sai do perfil, ninguém mais aponta para esse endereço), e
 * a borda da Cloudflare guarda por 1 hora, para uma imagem removida pela moderação sumir de lá logo.
 */
export async function serveProfileImage(req: Request, env: ImagesEnv, hash: string, ctx?: ExecutionContext): Promise<Response> {
  if (!HASH.test(hash) || !env.PROFILE_IMAGES) return new Response('Not found', { status: 404 });

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(req.url).origin + `/api/v1/profile-image/${hash}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const object = await env.PROFILE_IMAGES.get(objectKey(hash));
  if (!object) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });

  const body = await object.arrayBuffer();
  const base = { 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' };
  if (cache && ctx) {
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { ...base, 'Cache-Control': 'public, max-age=3600' } })).catch(() => undefined));
  }
  return new Response(body, { headers: { ...base, 'Cache-Control': 'public, max-age=31536000, immutable' } });
}
