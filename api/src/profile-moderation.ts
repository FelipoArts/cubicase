// ============================================================
// Denúncias de perfil e moderação (painel do dono, /admin)
// ============================================================
// Um membro denuncia o perfil de outro (imagem, nome ou bio) pelo mini perfil: a denúncia vai para a tabela
// profile_reports (ver members.ts) e o dono decide aqui, no painel: tirar as imagens, tirar a bio, trocar o nome ou
// arquivar. Tudo exige ADMIN_TOKEN (admin.ts já confere antes de chegar aqui).
//
// A conta do denunciado nunca sai do Worker: o painel só vê o que é público do perfil (nome, bio, imagens).
// ============================================================

import { supabaseService, type SupabaseEnv } from './supabase';
import { purgeImage, type ImagesEnv } from './profile-images';

export type ModerationEnv = SupabaseEnv & { PROFILE_IMAGES?: R2Bucket };

export const MODERATION_ACTIONS = ['clear_images', 'clear_bio', 'rename', 'dismiss'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 50;

interface ReportRow { id: string; target_id: string; reason: string; note: string | null; server_short_code: string | null; created_at: string }
interface TargetRow { user_id: string; display_name: string; bio: string | null; avatar_hash: string | null; banner_hash: string | null }

export interface ReportItem {
  id: string;
  reason: string;
  note: string | null;
  serverShortCode: string | null;
  createdAt: string;
  /** Quantas denúncias abertas esta pessoa tem (as repetidas somam). */
  openForTarget: number;
  /** O perfil público como está agora (null se a pessoa apagou o perfil). */
  target: { displayName: string; bio: string | null; avatarHash: string | null; bannerHash: string | null } | null;
}

async function rows<T>(resp: Response): Promise<T[]> {
  if (!resp.ok) return [];
  const data: unknown = await resp.json().catch(() => []);
  return Array.isArray(data) ? (data as T[]) : [];
}

/** As denúncias abertas, da mais antiga para a mais nova, com o perfil denunciado como está agora. */
export async function listProfileReports(env: ModerationEnv): Promise<ReportItem[]> {
  const reports = await rows<ReportRow>(await supabaseService(
    env,
    `/rest/v1/profile_reports?status=eq.open&order=created_at.asc&limit=${LIST_LIMIT}&select=id,target_id,reason,note,server_short_code,created_at`,
  ));
  const ids = [...new Set(reports.map((r) => r.target_id))].filter((u) => UUID.test(u));
  const targets = new Map<string, TargetRow>();
  if (ids.length) {
    for (const t of await rows<TargetRow>(await supabaseService(env, `/rest/v1/profiles?user_id=in.(${ids.join(',')})&select=user_id,display_name,bio,avatar_hash,banner_hash`))) {
      targets.set(t.user_id, t);
    }
  }
  const perTarget = new Map<string, number>();
  for (const r of reports) perTarget.set(r.target_id, (perTarget.get(r.target_id) ?? 0) + 1);
  return reports.map((r) => {
    const t = targets.get(r.target_id);
    return {
      id: r.id,
      reason: r.reason,
      note: r.note,
      serverShortCode: r.server_short_code,
      createdAt: r.created_at,
      openForTarget: perTarget.get(r.target_id) ?? 1,
      target: t ? { displayName: t.display_name, bio: t.bio, avatarHash: t.avatar_hash, bannerHash: t.banner_hash } : null,
    };
  });
}

export type ResolveResult = { ok: true } | { ok: false; status: number; message: string };

/** Aplica a decisão do dono e fecha TODAS as denúncias abertas daquela pessoa (a decisão vale para o perfil). */
export async function resolveProfileReport(env: ModerationEnv, id: string, action: unknown, nowMs = Date.now()): Promise<ResolveResult> {
  if (!UUID.test(id)) return { ok: false, status: 400, message: 'Identificador inválido.' };
  if (typeof action !== 'string' || !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, status: 400, message: 'Ação inválida.' };
  }
  const found = await rows<{ id: string; target_id: string; status: string }>(await supabaseService(
    env, `/rest/v1/profile_reports?id=eq.${id}&select=id,target_id,status`,
  ));
  const report = found[0];
  if (!report) return { ok: false, status: 404, message: 'Denúncia não encontrada.' };
  if (report.status !== 'open') return { ok: false, status: 409, message: 'Esta denúncia já foi resolvida.' };
  const target = report.target_id;
  const patch = (body: Record<string, unknown>) => supabaseService(env, `/rest/v1/profiles?user_id=eq.${target}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...body, updated_at: new Date(nowMs).toISOString() }),
  });

  if (action === 'clear_images') {
    const before = await rows<TargetRow>(await supabaseService(env, `/rest/v1/profiles?user_id=eq.${target}&select=user_id,display_name,bio,avatar_hash,banner_hash`));
    const resp = await patch({ avatar_hash: null, banner_hash: null });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não foi possível remover as imagens.' };
    // Apaga os arquivos de verdade (mesmo que outra conta use bytes idênticos): é conteúdo denunciado.
    if (env.PROFILE_IMAGES) {
      for (const hash of [before[0]?.avatar_hash, before[0]?.banner_hash]) await purgeImage(env as ImagesEnv, hash, true);
    }
  } else if (action === 'clear_bio') {
    const resp = await patch({ bio: null });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não foi possível remover a bio.' };
  } else if (action === 'rename') {
    const suffix = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const resp = await patch({ display_name: `Jogador-${suffix}` });
    if (!resp.ok) return { ok: false, status: 502, message: 'Não foi possível trocar o nome.' };
  }

  const closed = await supabaseService(env, `/rest/v1/profile_reports?target_id=eq.${target}&status=eq.open`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: action === 'dismiss' ? 'dismissed' : 'resolved', action, resolved_at: new Date(nowMs).toISOString() }),
  });
  if (!closed.ok) return { ok: false, status: 502, message: 'A ação foi aplicada, mas não consegui fechar a denúncia.' };
  return { ok: true };
}
