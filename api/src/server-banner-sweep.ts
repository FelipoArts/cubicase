// ============================================================
// Limpeza diária dos banners de servidor cujo dono ficou 90 dias sem Plus
// ============================================================
// Mesma regra das fotos e banners de perfil (profile-images-sweep.ts): sem Plus o banner fica escondido; passados
// 90 dias do fim, o arquivo é apagado do R2 e o servidor perde o banner (cor, etiquetas e recado ficam). Na dúvida
// (consulta falhou, dado estranho), NUNCA apaga.
// ============================================================

import { IMAGE_GRACE_DAYS, staleAccounts } from './profile-images-sweep';
import { clearServerBanner, type BannerEnv, type ServerLook } from './server-look';

const DAY_MS = 24 * 3600 * 1000;
const KEYS_PER_PAGE = 1000;
const MAX_PAGES = 5;
const MAX_CLEARED = 100;

interface Found { shortCode: string; owner: string | null; at: number | null }

/** Percorre os servidores guardados e acha os que têm banner, com a conta que o enviou e quando. */
async function serversWithBanner(env: BannerEnv): Promise<Found[]> {
  const out: Found[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await env.CUBEFORGE_REGISTRY.list({ prefix: 'server:', cursor, limit: KEYS_PER_PAGE });
    for (const key of list.keys) {
      const raw = await env.CUBEFORGE_REGISTRY.get(key.name);
      if (!raw) continue;
      let sv: { look?: ServerLook };
      try { sv = JSON.parse(raw); } catch { continue; }
      if (!sv.look?.bannerHash) continue;
      out.push({ shortCode: key.name.slice('server:'.length), owner: sv.look.bannerOwner, at: sv.look.bannerAt });
    }
    if (list.list_complete) break;
    cursor = (list as { cursor?: string }).cursor;
    if (!cursor) break;
  }
  return out;
}

export async function sweepStaleServerBanners(env: BannerEnv, nowMs = Date.now()): Promise<{ checked: number; cleared: number }> {
  const out = { checked: 0, cleared: 0 };
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.PROFILE_IMAGES) return out;
  const found = await serversWithBanner(env);
  out.checked = found.length;
  if (found.length === 0) return out;

  const withOwner = found.filter((f) => f.owner);
  const stale = await staleAccounts(env, withOwner.map((f) => ({ uid: f.owner as string, fallbackMs: f.at })), nowMs);
  if (!stale) return out; // sem os dados, não dá para saber quem ainda assina: não apaga nada
  const limit = nowMs - IMAGE_GRACE_DAYS * DAY_MS;

  for (const f of found) {
    if (out.cleared >= MAX_CLEARED) break;
    // Sem conta registrada o banner já está escondido; vale a data do envio. Sem data nenhuma, não se mexe.
    const isStale = f.owner ? stale.has(f.owner) : f.at !== null && f.at <= limit;
    if (!isStale) continue;
    if ((await clearServerBanner(env, f.shortCode)) === 'removed') out.cleared++;
  }
  return out;
}
