// ============================================================
// Perfil do jogador (Fase 1) — nome exibido, avatar e cor
// ============================================================
// Endpoints REST do Worker para a conta ter um perfil público simples. O perfil
// básico é grátis para qualquer conta; o que o Plus vai adicionar por cima
// (badges, molduras, temas) vem em fases seguintes (plans/player-profile-plan.md).
//
// A validação é toda aqui: o cliente nunca é confiável para dizer o que é um
// nome válido ou um avatar existente. A tabela tem RLS ligado sem policies, então
// só este módulo (service role) lê e escreve (ver scripts/supabase-profiles.sql).
//
// Como panel-members.ts, não conhece json()/ok()/fail() do index.ts: devolve um
// PanelResult simples e o roteador embrulha.
// ============================================================

import { resolveSupabaseUser, supabaseService, userHasActiveSubscription, type SupabaseEnv } from './supabase';
import type { PanelResult } from './panel-members';
import { getStreaks } from './plus-streak';
import { viewOf } from './plus-tier';

export interface ProfileDeps {
  env: SupabaseEnv;
  /** Rate limit por chave (KV do index.ts) — true se ainda dentro do limite. */
  rateLimit: (bucket: string, key: string, limit: number) => Promise<boolean>;
  /** Apaga do R2 as imagens (hashes) que ficaram sem dono, ao apagar o perfil. Opcional (testes). */
  purgeImages?: (hashes: string[]) => Promise<void>;
}

// ------------------------------------------------------------
// Catálogo grátis (só ids: o visual de cada item mora no app, src/lib/profileCatalog.ts)
// ------------------------------------------------------------

export const AVATAR_IDS = ['cube', 'pickaxe', 'sword', 'heart', 'flame', 'leaf', 'star', 'moon'] as const;
export const COLOR_IDS = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet'] as const;
export const DEFAULT_AVATAR_ID = 'cube';

export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 20;

const SAVE_RATE_LIMIT = 10;   // por conta/min
const PUBLIC_RATE_LIMIT = 60; // leituras do perfil público por IP/min

// ------------------------------------------------------------
// Validação do nome exibido
// ------------------------------------------------------------

export type DisplayNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'length' | 'chars' | 'blocked' | 'reserved' };

// Lista curta e propositalmente conservadora. Compara palavra inteira (e o nome inteiro sem
// separadores), nunca trecho, para não barrar nomes legítimos que contenham a sequência por acaso
// (o problema de Scunthorpe). Cresce conforme os relatos chegarem.
const BLOCKED_WORDS = new Set([
  'nazi', 'hitler', 'nigger', 'nigga', 'fuck', 'shit', 'puta', 'caralho', 'porra', 'merda', 'viado', 'estupro',
]);
// Impedem se passar pelo projeto ou pela equipe.
const RESERVED_FRAGMENTS = ['cubicase', 'cubeforge', 'felipoarts'];
const RESERVED_WORDS = new Set(['admin', 'administrador', 'staff', 'suporte', 'support', 'moderador', 'moderator', 'oficial', 'official']);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '@': 'a', '$': 's' };

/** Minúsculas, sem acento e com os "leet" mais comuns trocados por letras. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[01345@$]/g, (c) => LEET[c] ?? c);
}

export function validateDisplayName(raw: unknown): DisplayNameResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'length' };
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...name].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) return { ok: false, reason: 'length' };
  // Começa com letra ou número; depois letras, números, espaço e . _ ' -
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name)) return { ok: false, reason: 'chars' };

  const folded = fold(name);
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = folded.replace(/[^a-z0-9]/g, '');
  if (RESERVED_FRAGMENTS.some((f) => compact.includes(f)) || words.some((w) => RESERVED_WORDS.has(w))) {
    return { ok: false, reason: 'reserved' };
  }
  if (BLOCKED_WORDS.has(compact) || words.some((w) => BLOCKED_WORDS.has(w))) return { ok: false, reason: 'blocked' };
  return { ok: true, name };
}

// ------------------------------------------------------------
// Validação da bio ("sobre você")
// ------------------------------------------------------------

export const BIO_MAX = 160;
/** Quantas linhas a bio pode ter (quebras de linha são permitidas, mas poucas). */
export const BIO_MAX_LINES = 3;

/** Arruma a bio: espaços repetidos viram um, cada linha é aparada e linhas em branco somem. */
export function normalizeBio(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

export type BioResult =
  | { ok: true; bio: string | null }
  | { ok: false; reason: 'length' | 'lines' | 'chars' | 'blocked' | 'links' };

// Endereço de internet na bio (spam e golpe): link completo, "www." ou algo que termina em domínio comum.
const LINK = /(https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|gg|io|br|me|xyz|co|tv|ly)\b|discord\.gg|\bt\.me\b)/i;

/**
 * Normaliza e valida a bio: até 3 linhas (sem linhas em branco), sem espaços repetidos, até 160 caracteres, sem links e sem as
 * palavras da mesma lista dos nomes. Vazia (ou só espaços) vira `null`, que é "sem bio".
 */
export function validateBio(raw: unknown): BioResult {
  if (raw === null || raw === undefined) return { ok: true, bio: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'chars' };
  const bio = normalizeBio(raw);
  if (bio === '') return { ok: true, bio: null };
  if (bio.split('\n').length > BIO_MAX_LINES) return { ok: false, reason: 'lines' };
  if ([...bio].length > BIO_MAX) return { ok: false, reason: 'length' };
  // Letras, números, pontuação, símbolos e emojis; nada de caracteres de controle ou invisíveis.
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u.test(bio.replace(/[\n‍️]/g, ''))) return { ok: false, reason: 'chars' };
  if (LINK.test(bio)) return { ok: false, reason: 'links' };
  const words = fold(bio).split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => BLOCKED_WORDS.has(w))) return { ok: false, reason: 'blocked' };
  return { ok: true, bio };
}

export function isAvatarId(v: unknown): v is (typeof AVATAR_IDS)[number] {
  return typeof v === 'string' && (AVATAR_IDS as readonly string[]).includes(v);
}

export function isColorId(v: unknown): v is (typeof COLOR_IDS)[number] {
  return typeof v === 'string' && (COLOR_IDS as readonly string[]).includes(v);
}

// ------------------------------------------------------------
// Rotas
// ------------------------------------------------------------

interface ProfileRow {
  user_id: string;
  display_name: string;
  avatar_id: string;
  name_color: string | null;
  bio?: string | null;
  avatar_hash?: string | null;
  banner_hash?: string | null;
}

export interface PublicProfile {
  displayName: string;
  avatarId: string;
  nameColor: string | null;
  /** A frase "sobre você" (até 160 caracteres), ou null. */
  bio: string | null;
  /** Foto de perfil enviada (hash do conteúdo, ver profile-images.ts). Só chega a outras pessoas se a conta tem Plus. */
  avatarHash: string | null;
  /** Imagem de banner enviada. Mesma regra da foto. */
  bannerHash: string | null;
}

/** O perfil sem as imagens enviadas: é o que os outros veem de quem não assina (ou deixou de assinar) o Plus. */
export function withoutImages(p: PublicProfile): PublicProfile {
  return { ...p, avatarHash: null, bannerHash: null };
}

const res = (status: number, code: string, message: string, data?: unknown): PanelResult => ({ status, code, message, data });
const OK = (message: string, data?: unknown) => res(200, 'SUCCESS', message, data);
const UNAUTHORIZED = res(401, 'BAD_REQUEST', 'Sessão inválida ou expirada. Faça login novamente.');
const NOT_CONFIGURED = res(503, 'INTERNAL_ERROR', 'Perfil não configurado neste servidor.');
const TOO_MANY = res(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde um instante.');

const NAME_ERRORS: Record<'length' | 'chars' | 'blocked' | 'reserved', string> = {
  length: `O nome precisa ter de ${DISPLAY_NAME_MIN} a ${DISPLAY_NAME_MAX} caracteres.`,
  chars: "Use só letras, números, espaço e . _ ' - (começando por letra ou número).",
  blocked: 'Esse nome não pode ser usado. Escolha outro.',
  reserved: 'Esse nome é reservado. Escolha outro.',
};

const BIO_ERRORS: Record<'length' | 'lines' | 'chars' | 'blocked' | 'links', string> = {
  length: `A bio pode ter até ${BIO_MAX} caracteres.`,
  lines: `A bio pode ter até ${BIO_MAX_LINES} linhas.`,
  chars: 'A bio tem caracteres que não são permitidos.',
  blocked: 'Essa bio tem palavras que não podem ser usadas. Reescreva.',
  links: 'Links não são permitidos na bio.',
};

export function toPublic(row: ProfileRow): PublicProfile {
  return { displayName: row.display_name, avatarId: row.avatar_id, nameColor: row.name_color, bio: row.bio ?? null, avatarHash: row.avatar_hash ?? null, bannerHash: row.banner_hash ?? null };
}

async function getRow(env: SupabaseEnv, userId: string): Promise<ProfileRow | null> {
  const resp = await supabaseService(
    env,
    `/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id,display_name,avatar_id,name_color,bio,avatar_hash,banner_hash`,
  );
  if (!resp.ok) return null;
  const list: unknown = await resp.json().catch(() => []);
  return Array.isArray(list) ? ((list[0] as ProfileRow | undefined) ?? null) : null;
}

/** O nome que veio do Google/Discord, quando serve de sugestão (nunca o e-mail). */
function suggestName(displayName: string): string | null {
  if (!displayName || displayName.includes('@')) return null;
  const cut = [...displayName.trim()].slice(0, DISPLAY_NAME_MAX).join('');
  const r = validateDisplayName(cut);
  return r.ok ? r.name : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleProfileRoute(req: Request, deps: ProfileDeps, method: string, path: string): Promise<PanelResult | null> {
  const { env } = deps;

  if (path === '/api/v1/profile/me') {
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return null;
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return NOT_CONFIGURED;
    const user = await resolveSupabaseUser(req);
    if (!user) return UNAUTHORIZED;

    if (method === 'GET') {
      const row = await getRow(env, user.id);
      // O estado da própria sequência do Plus (nível, ou o prazo para não perdê-lo): só o dono vê.
      const streak = (await getStreaks(env, [user.id])).get(user.id) ?? null;
      let plusStreak = viewOf(streak, Date.now());
      // Assina o Plus mas ainda não há registro de sequência (assinatura anterior ao badge, ou o webhook ainda não
      // chegou): mostra o nível inicial, como a lista de membros já faz, em vez de esconder o badge.
      if (plusStreak.phase === 'none' && (await userHasActiveSubscription(env, user.id))) {
        plusStreak = { phase: 'active', tier: 'wood', days: 0, graceEndsAt: null };
      }
      return OK('Perfil.', {
        profile: row ? toPublic(row) : null,
        suggestedName: suggestName(user.displayName),
        plusStreak,
      });
    }

    if (method === 'DELETE') {
      const old = await getRow(env, user.id); // para apagar também as imagens enviadas
      const resp = await supabaseService(env, `/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível apagar o perfil.');
      const hashes = [old?.avatar_hash, old?.banner_hash].filter((h): h is string => !!h);
      if (hashes.length) await deps.purgeImages?.(hashes);
      return OK('Perfil apagado.');
    }

    // PUT
    if (!(await deps.rateLimit('profile-save', user.id, SAVE_RATE_LIMIT))) return TOO_MANY;
    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return res(400, 'BAD_REQUEST', 'Corpo inválido.');

    const name = validateDisplayName(body.displayName);
    if (!name.ok) return res(400, 'BAD_REQUEST', NAME_ERRORS[name.reason], { field: 'displayName', reason: name.reason });
    if (!isAvatarId(body.avatarId)) return res(400, 'BAD_REQUEST', 'Avatar inválido.', { field: 'avatarId' });
    const nameColor = body.nameColor ?? null;
    if (nameColor !== null && !isColorId(nameColor)) return res(400, 'BAD_REQUEST', 'Cor inválida.', { field: 'nameColor' });
    // A bio é opcional: se o corpo nem a mencionar, a que já existe fica como está.
    const bio = body.bio === undefined ? undefined : validateBio(body.bio);
    if (bio && !bio.ok) return res(400, 'BAD_REQUEST', BIO_ERRORS[bio.reason], { field: 'bio', reason: bio.reason });

    const resp = await supabaseService(env, '/rest/v1/profiles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        display_name: name.name,
        avatar_id: body.avatarId,
        name_color: nameColor,
        ...(bio ? { bio: bio.bio } : {}),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível salvar o perfil.');
    const saved: unknown = await resp.json().catch(() => null);
    const row = Array.isArray(saved) ? (saved[0] as ProfileRow | undefined) : undefined;
    return OK('Perfil salvo.', { profile: row ? toPublic(row) : { displayName: name.name, avatarId: body.avatarId, nameColor, bio: bio?.ok ? bio.bio : null, avatarHash: null, bannerHash: null } });
  }

  // GET /api/v1/profile/{userId} — perfil público (só nome, avatar e cor; nunca o e-mail)
  const mPublic = path.match(/^\/api\/v1\/profile\/([^/]+)$/);
  if (method === 'GET' && mPublic) {
    if (!UUID.test(mPublic[1])) return res(400, 'BAD_REQUEST', 'Identificador inválido.');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return NOT_CONFIGURED;
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await deps.rateLimit('profile-public', ip, PUBLIC_RATE_LIMIT))) return TOO_MANY;
    const row = await getRow(env, mPublic[1].toLowerCase());
    if (!row) return res(404, 'NOT_FOUND', 'Perfil não encontrado.');
    const pub = toPublic(row);
    // Foto e banner enviados só aparecem para os outros enquanto a conta assina o Plus.
    const visible = pub.avatarHash || pub.bannerHash
      ? ((await userHasActiveSubscription(env, mPublic[1].toLowerCase())) ? pub : withoutImages(pub))
      : pub;
    return OK('Perfil.', { profile: visible });
  }

  return null;
}
