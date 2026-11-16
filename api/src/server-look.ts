// ============================================================
// Aparência do servidor para os convidados: cor, etiquetas, recado e banner
// ============================================================
// O host escolhe como o servidor aparece na lista e na tela de detalhes dos amigos. Cor, etiquetas e recado são de
// graça; o banner é do Cubicase Plus. Tudo mora na própria entidade do servidor (`look`, no KV), então não há tabela
// nova. Cor e etiquetas são ids de uma lista fechada (nada de texto livre); o recado passa pelas mesmas regras da bio
// (sem links, sem palavras proibidas). O banner é um WebP validado como o das contas (ver profile-images.ts) e fica no
// R2 sob uma chave do próprio servidor, então trocar ou apagar não afeta nenhum outro arquivo.
//
// Quem vê o banner: só enquanto a conta que o enviou assina o Plus. Essa conferência é por conta, guardada no cache
// da borda por alguns minutos para o status dos amigos (consultado a toda hora) não virar uma consulta ao banco cada.
// ============================================================

import { checkImage, type ImagesEnv } from './profile-images';
import { validateBio } from './profile';
import { userHasActiveSubscription } from './supabase';

export const LOOK_COLORS = ['indigo', 'violet', 'pink', 'rose', 'red', 'orange', 'amber', 'lime', 'emerald', 'teal', 'sky', 'slate'] as const;
export const LOOK_TAGS = ['survival', 'creative', 'modded', 'vanilla', 'ptbr', 'english', 'casual', 'hardcore', 'pvp', 'minigames', 'roleplay', 'building'] as const;
export const LOOK_TAGS_MAX = 3;
export const LOOK_NOTE_MAX = 140;
export const LOOK_NOTE_MAX_LINES = 2;
export const BANNER_COOLDOWN_MS = 3_000;
const PLUS_CACHE_SECONDS = 600;

/** O que a aparência precisa para tirar um banner de um servidor: o registro (KV) e o bucket de imagens (R2). */
export type BannerEnv = ImagesEnv & { CUBEFORGE_REGISTRY: KVNamespace };

/** O que fica guardado no servidor. `bannerOwner` (a conta que enviou o banner) NUNCA sai da API. */
export interface ServerLook {
  color: string | null;
  tags: string[];
  note: string | null;
  bannerHash: string | null;
  bannerOwner: string | null;
  bannerAt: number | null;
}

/** O que os convidados recebem. */
export interface PublicLook {
  color: string | null;
  tags: string[];
  note: string | null;
  bannerHash: string | null;
}

export const EMPTY_LOOK: ServerLook = { color: null, tags: [], note: null, bannerHash: null, bannerOwner: null, bannerAt: null };

export const bannerKey = (serverUuid: string) => `srvbanner/${serverUuid}`;

const isColor = (v: unknown): v is string => typeof v === 'string' && (LOOK_COLORS as readonly string[]).includes(v);
const isTag = (v: unknown): v is string => typeof v === 'string' && (LOOK_TAGS as readonly string[]).includes(v);

export type LookEdit = { ok: true; look: ServerLook } | { ok: false; message: string };

/** Aplica a edição de cor, etiquetas e recado (o banner não muda por aqui). Valida tudo; nada de entrada inválida passa. */
export function applyLookEdit(current: ServerLook | undefined, body: unknown): LookEdit {
  const base = current ?? EMPTY_LOOK;
  if (!body || typeof body !== 'object') return { ok: false, message: 'JSON inválido.' };
  const b = body as Record<string, unknown>;

  let color = base.color;
  if ('color' in b) {
    if (b.color !== null && !isColor(b.color)) return { ok: false, message: 'Cor inválida.' };
    color = b.color as string | null;
  }

  let tags = base.tags;
  if ('tags' in b) {
    if (!Array.isArray(b.tags) || b.tags.length > LOOK_TAGS_MAX || !b.tags.every(isTag) || new Set(b.tags).size !== b.tags.length) {
      return { ok: false, message: `Escolha até ${LOOK_TAGS_MAX} etiquetas da lista.` };
    }
    tags = [...(b.tags as string[])];
  }

  let note = base.note;
  if ('note' in b) {
    const v = validateBio(b.note);
    if (!v.ok) {
      const why = { length: 'O recado é longo demais.', lines: 'O recado tem linhas demais.', chars: 'O recado tem caracteres que não são permitidos.', blocked: 'Esse recado tem palavras que não podem ser usadas. Reescreva.', links: 'Links não são permitidos no recado.' }[v.reason];
      return { ok: false, message: why };
    }
    if (v.bio !== null && ([...v.bio].length > LOOK_NOTE_MAX || v.bio.split('\n').length > LOOK_NOTE_MAX_LINES)) {
      return { ok: false, message: `O recado pode ter até ${LOOK_NOTE_MAX} caracteres e ${LOOK_NOTE_MAX_LINES} linhas.` };
    }
    note = v.bio;
  }
  return { ok: true, look: { ...base, color, tags, note } };
}

// ------------------------------------------------------------
// Plus do dono (para decidir se o banner aparece)
// ------------------------------------------------------------

type PlusCheck = (uid: string) => Promise<boolean>;

/** Assina o Plus agora? Cacheado na borda por 10 minutos: o status dos amigos é consultado o tempo todo. */
export async function ownerHasPlus(env: ImagesEnv, uid: string, check?: PlusCheck): Promise<boolean> {
  // Uma verificação injetada (testes) fala por si: não passa pelo cache.
  if (check) return check(uid);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(`https://plus-check.internal/${encodeURIComponent(uid)}`);
  try {
    const hit = await cache?.match(key);
    if (hit) return (await hit.text()) === '1';
  } catch { /* sem cache: consulta direto */ }
  const plus = await userHasActiveSubscription(env, uid);
  try {
    await cache?.put(key, new Response(plus ? '1' : '0', { headers: { 'Cache-Control': `public, max-age=${PLUS_CACHE_SECONDS}` } }));
  } catch { /* melhor esforço */ }
  return plus;
}

/** Guarda "tem Plus" no cache da borda (usado logo após um envio de banner, que confere o Plus de verdade). */
async function primePlusCache(uid: string): Promise<void> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  try {
    await cache?.put(new Request(`https://plus-check.internal/${encodeURIComponent(uid)}`), new Response('1', { headers: { 'Cache-Control': `public, max-age=${PLUS_CACHE_SECONDS}` } }));
  } catch { /* melhor esforço */ }
}

/** A aparência que os convidados veem: sem o dono do banner, e sem o banner se o Plus dele acabou. */
export async function publicLook(env: ImagesEnv, look: ServerLook | undefined, check?: PlusCheck): Promise<PublicLook | null> {
  if (!look) return null;
  let bannerHash = look.bannerHash;
  if (bannerHash) {
    const plus = look.bannerOwner ? await ownerHasPlus(env, look.bannerOwner, check) : false;
    if (!plus) bannerHash = null;
  }
  return { color: look.color, tags: look.tags, note: look.note, bannerHash };
}

// ------------------------------------------------------------
// Banner
// ------------------------------------------------------------

export type BannerResult =
  | { ok: true; look: ServerLook; message: string }
  | { ok: false; status: number; message: string };

/** Troca o banner do servidor. A conta (`uid`) tem de ter Plus agora; o arquivo é conferido de verdade. */
export async function putBanner(env: ImagesEnv, server: { uuid: string; look?: ServerLook }, uid: string, bytes: Uint8Array, nowMs = Date.now(), check?: PlusCheck): Promise<BannerResult> {
  if (!env.PROFILE_IMAGES) return { ok: false, status: 503, message: 'Imagens não configuradas neste servidor.' };
  const plus = await (check ?? ((u: string) => userHasActiveSubscription(env, u)))(uid);
  if (!plus) return { ok: false, status: 403, message: 'O banner do servidor é um recurso do Cubicase Plus.' };
  const look = server.look ?? EMPTY_LOOK;
  if (look.bannerAt && nowMs - look.bannerAt < BANNER_COOLDOWN_MS) return { ok: false, status: 429, message: 'Aguarde alguns segundos para enviar outro banner.' };
  const checked = await checkImage('banner', bytes);
  if (!checked.ok) return { ok: false, status: checked.status, message: checked.message };
  await env.PROFILE_IMAGES.put(bannerKey(server.uuid), bytes, { httpMetadata: { contentType: 'image/webp' } });
  // Quem acabou de assinar pode ter um "sem Plus" antigo no cache: sem isso o banner recém-enviado ficaria escondido por até 10 min.
  if (!check) await primePlusCache(uid);
  return { ok: true, message: 'Banner atualizado.', look: { ...look, bannerHash: checked.hash, bannerOwner: uid, bannerAt: nowMs } };
}

/** Tira o banner e apaga o arquivo. */
export async function removeBanner(env: ImagesEnv, server: { uuid: string; look?: ServerLook }): Promise<ServerLook> {
  const look = server.look ?? EMPTY_LOOK;
  try { await env.PROFILE_IMAGES?.delete(bannerKey(server.uuid)); } catch (e) { console.error('Falha ao apagar o banner do servidor:', e); }
  return { ...look, bannerHash: null, bannerOwner: null, bannerAt: null };
}

/** GET público do banner, para quem tem o código do servidor. `?v=<hash>` serve só para o cache do app. */
export async function serveBanner(env: ImagesEnv, server: { uuid: string; look?: ServerLook }, url: URL, cors: Record<string, string>, check?: PlusCheck): Promise<Response> {
  const visible = (await publicLook(env, server.look, check))?.bannerHash;
  if (!visible || !env.PROFILE_IMAGES) return new Response('Not found', { status: 404, headers: cors });
  const object = await env.PROFILE_IMAGES.get(bannerKey(server.uuid));
  if (!object) return new Response('Not found', { status: 404, headers: cors });
  const versioned = url.searchParams.get('v') === visible;
  return new Response(await object.arrayBuffer(), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    },
  });
}

/**
 * Tira o banner de um servidor pelo código (moderação e limpeza). Com `onlyHash`, só tira se o banner atual ainda é
 * esse (o host pode ter trocado). Devolve `removed`, `none` (não tinha banner) ou `changed` (já era outro).
 */
export async function clearServerBanner(env: BannerEnv, shortCode: string, onlyHash?: string): Promise<'removed' | 'none' | 'changed'> {
  const key = `server:${shortCode}`;
  const raw = await env.CUBEFORGE_REGISTRY.get(key);
  if (!raw) return 'none';
  const sv = JSON.parse(raw) as { uuid: string; look?: ServerLook; updatedAt?: string };
  if (!sv.look?.bannerHash) return 'none';
  if (onlyHash && sv.look.bannerHash !== onlyHash) return 'changed';
  const look = await removeBanner(env, sv);
  await env.CUBEFORGE_REGISTRY.put(key, JSON.stringify({ ...sv, look, updatedAt: new Date().toISOString() }));
  return 'removed';
}
