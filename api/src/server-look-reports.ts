// ============================================================
// Denúncia e moderação de banner de servidor
// ============================================================
// Um membro do servidor denuncia o banner (imagem imprópria ou outro motivo) pela tela do servidor; a denúncia vai para
// a tabela server_banner_reports e o dono decide no painel /admin: remover o banner ou arquivar. Tudo exige conta; quem
// decide exige ADMIN_TOKEN (admin.ts confere antes de chegar aqui). A conta do host nunca sai do Worker.
// ============================================================

import { resolveSupabaseUser, supabaseService, type SupabaseEnv } from './supabase';
import { clearServerBanner, publicLook, type BannerEnv } from './server-look';
import type { PanelResult } from './panel-members';

export type BannerReportsEnv = SupabaseEnv & BannerEnv & { ADMIN_DISCORD_WEBHOOK?: string };

export const BANNER_REPORT_REASONS = ['image', 'other'] as const;
export const MAX_BANNER_REPORTS_PER_DAY = 10;
const LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;

const res = (status: number, code: string, message: string, data?: unknown): PanelResult => ({ status, code, message, data });
const OK = (message: string) => res(200, 'SUCCESS', message);

async function rows<T>(resp: Response): Promise<T[]> {
  if (!resp.ok) return [];
  const data: unknown = await resp.json().catch(() => []);
  return Array.isArray(data) ? (data as T[]) : [];
}

async function loadServer(env: BannerEnv, shortCode: string): Promise<{ name?: string; uuid: string; look?: import('./server-look').ServerLook } | null> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  return sj ? JSON.parse(sj) : null;
}

/** POST /api/v1/servers/{sc}/banner/report — só quem também é membro do servidor, e só o banner que está aparecendo. */
export async function handleBannerReport(req: Request, env: BannerReportsEnv, shortCode: string, isPlus?: (uid: string) => Promise<boolean>): Promise<PanelResult> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return res(503, 'INTERNAL_ERROR', 'Denúncias não configuradas neste servidor.');
  const user = await resolveSupabaseUser(req);
  if (!user) return res(401, 'BAD_REQUEST', 'Sessão inválida ou expirada. Faça login novamente.');

  const body: any = await req.json().catch(() => null);
  const reason = BANNER_REPORT_REASONS.find((r) => r === body?.reason);
  if (!reason) return res(400, 'BAD_REQUEST', 'Motivo inválido.');
  const note = typeof body?.note === 'string' ? body.note.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';

  const sv = await loadServer(env, shortCode);
  if (!sv) return res(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
  const bannerHash = (await publicLook(env, sv.look, isPlus))?.bannerHash;
  if (!bannerHash) return res(404, 'NOT_FOUND', 'Este servidor não tem banner.');

  const member = await rows<{ user_id: string }>(await supabaseService(env, `/rest/v1/server_members?server_short_code=eq.${enc(shortCode)}&user_id=eq.${enc(user.id)}&select=user_id&limit=1`));
  if (member.length === 0) return res(403, 'FORBIDDEN', 'Só quem é membro do servidor pode denunciar.');

  // Já há uma denúncia aberta sua contra este servidor: não duplica (e não conta no limite do dia)
  const open = await rows<{ id: string }>(await supabaseService(env, `/rest/v1/server_banner_reports?reporter_id=eq.${enc(user.id)}&server_short_code=eq.${enc(shortCode)}&status=eq.open&select=id&limit=1`));
  if (open.length > 0) return OK('Denúncia enviada.');

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const countResp = await supabaseService(env, `/rest/v1/server_banner_reports?reporter_id=eq.${enc(user.id)}&created_at=gte.${enc(since)}&select=id&limit=1`, { headers: { Prefer: 'count=exact' } });
  const sent = Number(countResp.headers.get('content-range')?.split('/')[1]);
  if (Number.isFinite(sent) && sent >= MAX_BANNER_REPORTS_PER_DAY) return res(429, 'RATE_LIMITED', 'Muitas denúncias hoje. Tente novamente amanhã.');

  const insert = await supabaseService(env, '/rest/v1/server_banner_reports', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ reporter_id: user.id, server_short_code: shortCode, banner_hash: bannerHash, reason, note: note || null }),
  });
  if (!insert.ok && insert.status !== 409) return res(502, 'INTERNAL_ERROR', 'Não foi possível enviar a denúncia.');
  if (env.ADMIN_DISCORD_WEBHOOK) {
    try {
      await fetch(env.ADMIN_DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Cubicase — denúncias', content: '🚩 Nova denúncia de banner de servidor. Veja e decida no painel: /admin' }),
      });
    } catch { /* o aviso é um extra: a denúncia já está guardada */ }
  }
  return OK('Denúncia enviada.');
}

// ------------------------------------------------------------
// Painel do dono
// ------------------------------------------------------------

export const BANNER_ACTIONS = ['remove_banner', 'dismiss'] as const;
export type BannerAction = (typeof BANNER_ACTIONS)[number];

interface ReportRow { id: string; server_short_code: string; banner_hash: string; reason: string; note: string | null; created_at: string }

export interface BannerReportItem {
  id: string;
  reason: string;
  note: string | null;
  serverShortCode: string;
  serverName: string | null;
  createdAt: string;
  /** Quantas denúncias abertas este servidor tem (as repetidas somam). */
  openForServer: number;
  /** O banner denunciado ainda é o que está no servidor? Se o host trocou, a denúncia é sobre um banner que já saiu. */
  current: boolean;
  /** O banner como está agora no servidor (null se já foi tirado). */
  bannerHash: string | null;
}

/** As denúncias abertas, da mais antiga para a mais nova. */
export async function listBannerReports(env: BannerReportsEnv): Promise<BannerReportItem[]> {
  const reports = await rows<ReportRow>(await supabaseService(
    env,
    `/rest/v1/server_banner_reports?status=eq.open&order=created_at.asc&limit=${LIST_LIMIT}&select=id,server_short_code,banner_hash,reason,note,created_at`,
  ));
  const perServer = new Map<string, number>();
  for (const r of reports) perServer.set(r.server_short_code, (perServer.get(r.server_short_code) ?? 0) + 1);
  const servers = new Map<string, Awaited<ReturnType<typeof loadServer>>>();
  for (const code of perServer.keys()) servers.set(code, await loadServer(env, code));
  return reports.map((r) => {
    const sv = servers.get(r.server_short_code) ?? null;
    const now = sv?.look?.bannerHash ?? null;
    return {
      id: r.id,
      reason: r.reason,
      note: r.note,
      serverShortCode: r.server_short_code,
      serverName: sv?.name ?? null,
      createdAt: r.created_at,
      openForServer: perServer.get(r.server_short_code) ?? 1,
      current: now !== null && now === r.banner_hash,
      bannerHash: now,
    };
  });
}

export type BannerResolveResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * Aplica a decisão do dono. Remover só mexe no banner se ele ainda é o denunciado (se o host já trocou, o banner novo
 * não paga pelo antigo). Fecha as denúncias abertas daquele servidor: a decisão vale para o servidor.
 */
export async function resolveBannerReport(env: BannerReportsEnv, id: string, action: unknown, nowMs = Date.now()): Promise<BannerResolveResult> {
  if (!UUID.test(id)) return { ok: false, status: 400, message: 'Identificador inválido.' };
  if (typeof action !== 'string' || !(BANNER_ACTIONS as readonly string[]).includes(action)) return { ok: false, status: 400, message: 'Ação inválida.' };
  const found = await rows<{ id: string; server_short_code: string; banner_hash: string; status: string }>(await supabaseService(
    env, `/rest/v1/server_banner_reports?id=eq.${id}&select=id,server_short_code,banner_hash,status`,
  ));
  const report = found[0];
  if (!report) return { ok: false, status: 404, message: 'Denúncia não encontrada.' };
  if (report.status !== 'open') return { ok: false, status: 409, message: 'Esta denúncia já foi resolvida.' };

  if (action === 'remove_banner') {
    await clearServerBanner(env, report.server_short_code, report.banner_hash);
  }
  const closed = await supabaseService(env, `/rest/v1/server_banner_reports?server_short_code=eq.${enc(report.server_short_code)}&status=eq.open`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: action === 'dismiss' ? 'dismissed' : 'resolved', action, resolved_at: new Date(nowMs).toISOString() }),
  });
  if (!closed.ok) return { ok: false, status: 502, message: 'A ação foi aplicada, mas não consegui fechar a denúncia.' };
  return { ok: true };
}
