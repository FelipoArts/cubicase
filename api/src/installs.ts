// ============================================================
// Contagem de instalações (ping anônimo do app)
// ============================================================
// O app manda, no máximo uma vez por dia, um ID aleatório da instalação (gerado no primeiro uso, sem relação com a
// conta, o nome do computador ou o IP), a versão e o sistema. Nada além disso é guardado. O usuário pode desligar o
// envio nas configurações do app.
//
// Custo no KV: 1 escrita por instalação por dia (e nenhuma leitura extra no painel: os dados ficam nos METADADOS da
// chave, então listar já traz tudo sem um `get` por instalação). No plano pago do Workers (1 milhão de escritas/mês
// incluídas) isso só pesa acima de ~25 mil instalações ativas por dia; o painel avisa quando chegar perto.
// ============================================================

export interface InstallsEnv { CUBEFORGE_REGISTRY: KVNamespace }

export const INSTALL_PREFIX = 'inst:';
const INSTALL_TTL_SECONDS = 400 * 24 * 3600; // some sozinha depois de ~13 meses sem aparecer
const REWRITE_AFTER_MS = 20 * 3600_000;       // não regrava a mesma instalação mais de uma vez por dia
const DAY_MS = 24 * 3600_000;

const ID_RE = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.]{1,16})?$/;
const OS_VALUES = ['windows', 'macos', 'linux'] as const;

/** f = primeira vez, l = última, v = versão, o = sistema, s = marcos alcançados (bits), e = tipos de falha já ocorridos (bits). */
export interface InstallMeta { f: string; l: string; v: string; o: string; s?: number; e?: number }

/** Mesmos bits do app (src/lib/milestones.ts). */
export const MILESTONE_BITS = [
  { key: 'account', bit: 1, label: 'Entrou numa conta' },
  { key: 'server_installed', bit: 2, label: 'Criou/instalou um servidor' },
  { key: 'server_started', bit: 4, label: 'Ligou o servidor' },
  { key: 'invited', bit: 8, label: 'Copiou o convite' },
  { key: 'player_joined', bit: 16, label: 'Teve 2+ jogadores juntos' },
] as const;
export const ERROR_BITS = [
  { key: 'install_failed', bit: 1, label: 'Falha ao criar/instalar o servidor' },
  { key: 'server_start_failed', bit: 2, label: 'Servidor não subiu' },
  { key: 'connection_failed', bit: 4, label: 'Conexão com amigos falhou' },
  { key: 'update_failed', bit: 8, label: 'Atualização do app falhou' },
] as const;
const MASK_MAX = 1 << 8;
function mask(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MASK_MAX ? v : 0;
}

export type PingResult = { ok: true; written: boolean } | { ok: false; message: string };

/** Valida o corpo e grava (no máximo 1 vez por dia por instalação). Nunca guarda nada além de id/versão/sistema. */
export async function recordInstallPing(env: InstallsEnv, body: unknown, nowMs = Date.now()): Promise<PingResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.toLowerCase() : '';
  const v = typeof b.v === 'string' ? b.v : '';
  const o = (OS_VALUES as readonly string[]).includes(String(b.os)) ? String(b.os) : 'other';
  if (!ID_RE.test(id)) return { ok: false, message: 'Identificador inválido.' };
  if (!VERSION_RE.test(v)) return { ok: false, message: 'Versão inválida.' };

  const sNew = mask(b.s), eNew = mask(b.e);
  const key = `${INSTALL_PREFIX}${id.replace(/-/g, '')}`;
  const cur = await env.CUBEFORGE_REGISTRY.getWithMetadata<InstallMeta>(key);
  const meta = cur.metadata;
  // Marcos e falhas só crescem (um bit alcançado nunca some), então juntamos com o que já estava guardado.
  const s = (meta?.s ?? 0) | sNew, e = (meta?.e ?? 0) | eNew;
  if (meta && meta.v === v && meta.o === o && (meta.s ?? 0) === s && (meta.e ?? 0) === e && nowMs - Date.parse(meta.l) < REWRITE_AFTER_MS) return { ok: true, written: false };
  const next: InstallMeta = { f: meta?.f ?? new Date(nowMs).toISOString(), l: new Date(nowMs).toISOString(), v, o, s, e };
  await env.CUBEFORGE_REGISTRY.put(key, '1', { expirationTtl: INSTALL_TTL_SECONDS, metadata: next });
  return { ok: true, written: true };
}

export async function listInstalls(kv: KVNamespace, maxPages = 30): Promise<InstallMeta[]> {
  const out: InstallMeta[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await kv.list<InstallMeta>({ prefix: INSTALL_PREFIX, cursor });
    for (const k of page.keys) if (k.metadata && k.metadata.f && k.metadata.l) out.push(k.metadata);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

function versionKey(v: string): number[] {
  return v.split('-')[0].split('.').map((n) => Number(n) || 0);
}

export function summarizeInstalls(items: InstallMeta[], now: number) {
  const perDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) perDay.set(new Date(now - i * DAY_MS).toISOString().slice(0, 10), 0);
  let active24h = 0, active7d = 0, active30d = 0;
  const byVersion = new Map<string, number>();
  const byOs = new Map<string, number>();
  for (const it of items) {
    const age = now - Date.parse(it.l);
    if (age <= DAY_MS) active24h++;
    if (age <= 7 * DAY_MS) active7d++;
    if (age <= 30 * DAY_MS) active30d++;
    if (age <= 30 * DAY_MS) {
      byVersion.set(it.v, (byVersion.get(it.v) ?? 0) + 1);
      byOs.set(it.o, (byOs.get(it.o) ?? 0) + 1);
    }
    const k = it.f.slice(0, 10);
    if (perDay.has(k)) perDay.set(k, perDay.get(k)! + 1);
  }
  // Funil: quantas instalações (ativas ou não) já alcançaram cada etapa.
  const funnel = [
    { key: 'installed', label: 'Instalou e abriu o app', count: items.length },
    ...MILESTONE_BITS.map((m) => ({ key: m.key, label: m.label, count: items.filter((i) => ((i.s ?? 0) & m.bit) !== 0).length })),
  ];
  // Retenção por semana de chegada: voltou a aparecer pelo menos N dias depois da primeira vez (só coortes já "maduras").
  const weekStart = (t: number) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const cohorts = new Map<string, { size: number; d1: number; d7: number; d14: number; maxAge: number }>();
  for (const it of items) {
    const f = Date.parse(it.f), l = Date.parse(it.l);
    if (!Number.isFinite(f) || !Number.isFinite(l)) continue;
    const wk = weekStart(f);
    const c = cohorts.get(wk) ?? { size: 0, d1: 0, d7: 0, d14: 0, maxAge: 0 };
    c.size++;
    c.maxAge = Math.max(c.maxAge, Math.floor((now - f) / DAY_MS));
    if (l - f >= DAY_MS) c.d1++;
    if (l - f >= 7 * DAY_MS) c.d7++;
    if (l - f >= 14 * DAY_MS) c.d14++;
    cohorts.set(wk, c);
  }
  const retention = [...cohorts].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 8).map(([week, c]) => ({
    week, size: c.size,
    // null = a coorte ainda não tem idade para medir esse ponto
    d1: c.maxAge >= 1 ? c.d1 : null, d7: c.maxAge >= 7 ? c.d7 : null, d14: c.maxAge >= 14 ? c.d14 : null,
  }));
  // "Sumiu": já mandou ping e parou há mais de 14 dias — onde parou (última etapa), versão e falhas.
  const gone = items.filter((i) => now - Date.parse(i.l) > 14 * DAY_MS);
  const lastStage = (i: InstallMeta) => {
    const reached = MILESTONE_BITS.filter((m) => ((i.s ?? 0) & m.bit) !== 0);
    return reached.length ? reached[reached.length - 1].label : 'Só abriu o app';
  };
  const goneByStage = new Map<string, number>();
  const goneByVersion = new Map<string, number>();
  for (const i of gone) {
    goneByStage.set(lastStage(i), (goneByStage.get(lastStage(i)) ?? 0) + 1);
    goneByVersion.set(i.v, (goneByVersion.get(i.v) ?? 0) + 1);
  }
  // Falhas: de quem passou por cada tipo, quantos sumiram (compara com a taxa geral para ver o que mais expulsa).
  const errors = ERROR_BITS.map((m) => {
    const hit = items.filter((i) => ((i.e ?? 0) & m.bit) !== 0);
    return { key: m.key, label: m.label, installs: hit.length, gone: hit.filter((i) => now - Date.parse(i.l) > 14 * DAY_MS).length };
  });
  const versions = [...byVersion].map(([version, count]) => ({ version, count }))
    .sort((a, b) => {
      const x = versionKey(a.version), y = versionKey(b.version);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    });
  return {
    total: items.length,
    active24h, active7d, active30d,
    versions,
    systems: [...byOs].map(([os, count]) => ({ os, count })).sort((a, b) => b.count - a.count),
    newPerDay: [...perDay].map(([date, count]) => ({ date, count })),
    funnel,
    retention,
    gone: {
      total: gone.length,
      share: items.length ? gone.length / items.length : 0,
      byStage: [...goneByStage].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      byVersion: [...goneByVersion].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    },
    errors,
    /** Plano pago do Workers: 1 milhão de escritas/mês no KV incluídas (~33 mil/dia). Perto disso, agrupar os pings. */
    nearKvWriteLimit: active24h >= 25000,
  };
}

export async function installs(env: InstallsEnv, now: number) {
  return summarizeInstalls(await listInstalls(env.CUBEFORGE_REGISTRY), now);
}
