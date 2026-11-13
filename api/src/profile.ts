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

import { resolveSupabaseUser, supabaseService, type SupabaseEnv } from './supabase';
import type { PanelResult } from './panel-members';

export interface ProfileDeps {
  env: SupabaseEnv;
  /** Rate limit por chave (KV do index.ts) — true se ainda dentro do limite. */
  rateLimit: (bucket: string, key: string, limit: number) => Promise<boolean>;
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
}

export interface PublicProfile {
  displayName: string;
  avatarId: string;
  nameColor: string | null;
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

export function toPublic(row: ProfileRow): PublicProfile {
  return { displayName: row.display_name, avatarId: row.avatar_id, nameColor: row.name_color };
}

async function getRow(env: SupabaseEnv, userId: string): Promise<ProfileRow | null> {
  const resp = await supabaseService(
    env,
    `/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id,display_name,avatar_id,name_color`,
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
      return OK('Perfil.', { profile: row ? toPublic(row) : null, suggestedName: suggestName(user.displayName) });
    }

    if (method === 'DELETE') {
      const resp = await supabaseService(env, `/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível apagar o perfil.');
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

    const resp = await supabaseService(env, '/rest/v1/profiles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        display_name: name.name,
        avatar_id: body.avatarId,
        name_color: nameColor,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!resp.ok) return res(502, 'INTERNAL_ERROR', 'Não foi possível salvar o perfil.');
    const saved: unknown = await resp.json().catch(() => null);
    const row = Array.isArray(saved) ? (saved[0] as ProfileRow | undefined) : undefined;
    return OK('Perfil salvo.', { profile: row ? toPublic(row) : { displayName: name.name, avatarId: body.avatarId, nameColor } });
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
    return OK('Perfil.', { profile: toPublic(row) });
  }

  return null;
}
