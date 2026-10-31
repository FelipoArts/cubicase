// ============================================================
// Painel do dono (/admin) — métricas, saúde dos serviços e relatos de suporte
// ============================================================
// Só o dono acessa: tudo exige ADMIN_TOKEN (wrangler secret put ADMIN_TOKEN). Sem o segredo configurado, as rotas
// respondem 404 como se não existissem. Este módulo concentra a coleta de dados e as regras de alerta; o roteamento
// fica em handleAdminRequest e a página em admin-page.ts.
//
// A cota de escrita do KV é escassa, então a rotina agendada só grava quando algo muda (um serviço cai ou volta) e, no
// máximo, uma vez por hora para marcar que continua rodando. As listagens do KV (cota própria) só acontecem quando o
// painel é aberto, com cache de alguns minutos.
// ============================================================

import { connect } from 'cloudflare:sockets';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, supabaseService, type SupabaseEnv } from './supabase';
import { ADMIN_HTML } from './admin-page';

export interface AdminEnv extends SupabaseEnv {
  CUBEFORGE_REGISTRY: KVNamespace;
  ADMIN_TOKEN?: string;
  /** URL de um webhook do Discord (canal só seu) para os alertas de serviço fora do ar. */
  ADMIN_DISCORD_WEBHOOK?: string;
  TURN_URLS?: string;
}

export const GITHUB_REPO = 'FelipoArts/cubicase';
const HEALTH_KEY = 'admin:health';
const FEEDBACK_PREFIX = 'fbk:';
export const FEEDBACK_TTL_SECONDS = 120 * 24 * 3600;
const DOWN_AFTER_FAILS = 2; // duas checagens seguidas (≈10 min) com falha antes de declarar o serviço fora do ar
const HEALTH_REFRESH_MS = 60 * 60_000;
const OVERVIEW_CACHE_MS = 5 * 60_000;
const MC_STALE_MS = 5 * 60_000;
const ADMIN_FAIL_LIMIT = 10; // tentativas erradas por IP/min

// ---------------- autenticação ----------------

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Comparação sem vazar o tamanho nem o ponto da diferença. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function adminAuthorized(req: Request, env: AdminEnv): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  return !!m && (await sameSecret(m[1].trim(), env.ADMIN_TOKEN));
}

// ---------------- saúde dos serviços ----------------

export interface CheckResult { id: string; label: string; ok: boolean; detail: string; ms: number }
export interface HealthEntry { label: string; ok: boolean; since: string; last: string; detail: string; fails: number; ms: number }
export interface HealthEvent { at: string; id: string; label: string; ok: boolean; detail: string }
export interface HealthState { checks: Record<string, HealthEntry>; events: HealthEvent[]; updatedAt: string; cronAt: string }

export interface Probes {
  fetch: typeof fetch;
  tcp: (host: string, port: number, timeoutMs: number) => Promise<void>;
}

// `fetch` chamado como método de outro objeto dá "Illegal invocation" no Workers: por isso o invólucro.
export const defaultProbes: Probes = { fetch: (input, init) => fetch(input, init), tcp: (host, port, ms) => tcpProbe(host, port, ms) };

export async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  const socket = connect({ hostname: host, port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('sem resposta')), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try { await socket.close(); } catch { /* já fechado */ }
  }
}

async function timed(id: string, label: string, run: () => Promise<string>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    return { id, label, ok: true, detail: await run(), ms: Date.now() - t0 };
  } catch (e) {
    return { id, label, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

async function expectOk(p: Probes, url: string, init?: RequestInit): Promise<string> {
  const res = await p.fetch(url, { ...init, signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `HTTP ${res.status}`;
}

function turnHost(env: AdminEnv): { host: string; port: number } | null {
  const first = (env.TURN_URLS ?? '').split(',').map((s) => s.trim()).find((u) => u.startsWith('turn:') && !u.includes('transport=udp'));
  const m = first ? /^turns?:([^:?]+):?(\d+)?/.exec(first) : null;
  return m ? { host: m[1], port: Number(m[2] ?? 3478) } : null;
}

export async function runHealthChecks(env: AdminEnv, p: Probes): Promise<CheckResult[]> {
  const turn = turnHost(env);
  const jobs: Promise<CheckResult>[] = [
    timed('kv', 'Registro de servidores (KV)', async () => {
      await env.CUBEFORGE_REGISTRY.get('admin:ping');
      return 'leitura ok';
    }),
    timed('supabase', 'Contas e assinaturas (Supabase)', () => expectOk(p, `${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } })),
    timed('updates', 'Atualizações do app (GitHub)', () => expectOk(p, `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json`)),
    timed('discord', 'Discord', () => expectOk(p, 'https://discord.com/api/v10/gateway')),
  ];
  if (turn) jobs.push(timed('relay', 'Relay de conexão (TURN)', async () => { await p.tcp(turn.host, turn.port, 5000); return `${turn.host}:${turn.port} aceitando conexões`; }));
  return Promise.all(jobs);
}

export interface HealthAlert { id: string; label: string; ok: boolean; detail: string }

/** Atualiza o estado com o resultado de uma rodada e diz o que merece aviso. Pura, para testar sem rede. */
export function nextHealthState(prev: HealthState | null, results: CheckResult[], nowIso: string): { state: HealthState; alerts: HealthAlert[]; changed: boolean } {
  const checks: Record<string, HealthEntry> = {};
  const events = [...(prev?.events ?? [])];
  const alerts: HealthAlert[] = [];
  let changed = !prev;
  for (const r of results) {
    const old = prev?.checks[r.id];
    const fails = r.ok ? 0 : (old?.fails ?? 0) + 1;
    const wasOk = old ? old.ok : true;
    const ok = r.ok ? true : fails >= DOWN_AFTER_FAILS ? false : wasOk;
    if (!old || old.ok !== ok) {
      if (old || !ok) {
        events.unshift({ at: nowIso, id: r.id, label: r.label, ok, detail: r.detail });
        alerts.push({ id: r.id, label: r.label, ok, detail: r.detail });
      }
      changed = true;
    }
    if (old && old.fails !== fails) changed = true;
    checks[r.id] = { label: r.label, ok, since: !old || old.ok !== ok ? nowIso : old.since, last: nowIso, detail: r.detail, fails, ms: r.ms };
  }
  const refresh = !prev || Date.parse(nowIso) - Date.parse(prev.updatedAt) >= HEALTH_REFRESH_MS;
  const state: HealthState = { checks, events: events.slice(0, 50), updatedAt: changed || refresh ? nowIso : prev!.updatedAt, cronAt: nowIso };
  return { state, alerts, changed: changed || refresh };
}

export async function sendAdminAlerts(env: AdminEnv, alerts: HealthAlert[], f: typeof fetch = defaultProbes.fetch): Promise<void> {
  if (!env.ADMIN_DISCORD_WEBHOOK || !alerts.length) return;
  const embeds = alerts.map((a) => ({
    title: a.ok ? `✅ Voltou: ${a.label}` : `🔴 Fora do ar: ${a.label}`,
    description: a.detail.slice(0, 500),
    color: a.ok ? 0x2ecc71 : 0xe74c3c,
  }));
  try {
    await f(env.ADMIN_DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Cubicase — monitor', embeds: embeds.slice(0, 10) }) });
  } catch (e) {
    console.error('[admin] aviso no Discord falhou:', e);
  }
}

export async function loadHealth(env: AdminEnv): Promise<HealthState | null> {
  const raw = await env.CUBEFORGE_REGISTRY.get(HEALTH_KEY);
  try { return raw ? (JSON.parse(raw) as HealthState) : null; } catch { return null; }
}

/** Rotina agendada: confere os serviços, guarda só o que mudou e avisa no Discord. */
export async function healthCron(env: AdminEnv, probes: Probes = defaultProbes, nowIso = new Date().toISOString()): Promise<HealthState> {
  const prev = await loadHealth(env);
  const results = await runHealthChecks(env, probes);
  const { state, alerts, changed } = nextHealthState(prev, results, nowIso);
  if (changed) await env.CUBEFORGE_REGISTRY.put(HEALTH_KEY, JSON.stringify(state));
  await sendAdminAlerts(env, alerts, probes.fetch);
  return state;
}

// ---------------- métricas ----------------

type Section<T> = ({ ok: true } & T) | { ok: false; error: string };

async function section<T extends object>(run: () => Promise<T>): Promise<Section<T>> {
  try { return { ok: true, ...(await run()) }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

interface GhAsset { name: string; download_count: number }
interface GhRelease { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; assets: GhAsset[] }

export function summarizeReleases(releases: GhRelease[]) {
  const published = releases.filter((r) => !r.draft);
  const rows = published.map((r) => {
    const installers = r.assets.filter((a) => /\.(exe|msi)$/i.test(a.name)).reduce((s, a) => s + a.download_count, 0);
    const checks = r.assets.filter((a) => a.name === 'latest.json').reduce((s, a) => s + a.download_count, 0);
    return { tag: r.tag_name, publishedAt: r.published_at, installers, updateChecks: checks };
  });
  return {
    latest: rows[0]?.tag ?? null,
    installers: rows.reduce((s, r) => s + r.installers, 0),
    updateChecks: rows.reduce((s, r) => s + r.updateChecks, 0),
    releases: rows.slice(0, 12),
  };
}

async function downloads(f: typeof fetch) {
  const res = await f(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`, { headers: { 'User-Agent': 'cubicase-admin', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return summarizeReleases((await res.json()) as GhRelease[]);
}

interface AuthUser { email?: string; created_at: string; last_sign_in_at?: string | null; app_metadata?: { provider?: string } }

export function summarizeUsers(users: AuthUser[], now: number) {
  const day = 24 * 3600_000;
  const perDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) perDay.set(new Date(now - i * day).toISOString().slice(0, 10), 0);
  let last24h = 0, last7d = 0, last30d = 0;
  for (const u of users) {
    const t = Date.parse(u.created_at);
    if (now - t <= day) last24h++;
    if (now - t <= 7 * day) last7d++;
    if (now - t <= 30 * day) last30d++;
    const k = u.created_at.slice(0, 10);
    if (perDay.has(k)) perDay.set(k, perDay.get(k)! + 1);
  }
  const recent = [...users].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50)
    .map((u) => ({ email: u.email ?? '(sem e-mail)', createdAt: u.created_at, lastSignIn: u.last_sign_in_at ?? null, provider: u.app_metadata?.provider ?? '?' }));
  return { total: users.length, last24h, last7d, last30d, perDay: [...perDay].map(([date, count]) => ({ date, count })), recent };
}

async function accounts(env: AdminEnv, now: number) {
  const users: AuthUser[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await supabaseService(env, `/auth/v1/admin/users?page=${page}&per_page=1000`);
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    const body = (await res.json()) as { users?: AuthUser[] };
    users.push(...(body.users ?? []));
    if ((body.users ?? []).length < 1000) break;
  }
  return summarizeUsers(users, now);
}

async function subscriptions(env: AdminEnv) {
  const res = await supabaseService(env, '/rest/v1/subscriptions?select=status&limit=10000');
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  const rows = (await res.json()) as { status: string }[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { total: rows.length, active: (byStatus.active ?? 0) + (byStatus.trialing ?? 0), byStatus };
}

async function listKeys(kv: KVNamespace, prefix: string, maxPages = 20): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await kv.list({ prefix, cursor });
    names.push(...page.keys.map((k) => k.name));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return names;
}

async function servers(env: AdminEnv, now: number) {
  const registered = await listKeys(env.CUBEFORGE_REGISTRY, 'server:');
  const sessions = (await listKeys(env.CUBEFORGE_REGISTRY, 'session:')).slice(0, 500);
  const byStatus: Record<string, number> = {};
  let live = 0;
  for (const key of sessions) {
    const raw = await env.CUBEFORGE_REGISTRY.get(key);
    if (!raw) continue;
    try {
      const s = JSON.parse(raw) as { status?: string; lastHeartbeat?: string };
      if (!s.lastHeartbeat || now - Date.parse(s.lastHeartbeat) > MC_STALE_MS) continue;
      live++;
      byStatus[s.status ?? '?'] = (byStatus[s.status ?? '?'] ?? 0) + 1;
    } catch { /* registro corrompido: ignora */ }
  }
  return { registered: registered.length, live, byStatus };
}

async function relay(env: AdminEnv, now: number) {
  const d = new Date(now);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const keys = (await listKeys(env.CUBEFORGE_REGISTRY, 'relayuse:', 5)).filter((k) => k.endsWith(`:${month}`)).slice(0, 500);
  const rows: { shortCode: string; bytes: number }[] = [];
  for (const k of keys) rows.push({ shortCode: k.split(':')[1], bytes: Number(await env.CUBEFORGE_REGISTRY.get(k)) || 0 });
  rows.sort((a, b) => b.bytes - a.bytes);
  return { month, servers: rows.length, totalBytes: rows.reduce((s, r) => s + r.bytes, 0), top: rows.slice(0, 10) };
}

let overviewCache: { at: number; value: unknown } | null = null;
export function resetOverviewCache(): void { overviewCache = null; }

export async function collectOverview(env: AdminEnv, f: typeof fetch = defaultProbes.fetch, now = Date.now(), force = false) {
  if (!force && overviewCache && now - overviewCache.at < OVERVIEW_CACHE_MS) return overviewCache.value;
  const [dl, acc, sub, srv, rly] = await Promise.all([
    section(() => downloads(f)),
    section(() => accounts(env, now)),
    section(() => subscriptions(env)),
    section(() => servers(env, now)),
    section(() => relay(env, now)),
  ]);
  const value = { generatedAt: new Date(now).toISOString(), downloads: dl, accounts: acc, subscriptions: sub, servers: srv, relay: rly };
  overviewCache = { at: now, value };
  return value;
}

// ---------------- relatos de suporte ----------------

export interface StoredFeedback {
  id: string; category: string; subject: string; message: string; email: string;
  appVersion: string; os: string; locale: string; createdAt: string; emailed: boolean;
}

export async function storeFeedback(env: AdminEnv, f: Omit<StoredFeedback, 'id' | 'createdAt' | 'emailed'>, fingerprint: string, emailed: boolean): Promise<void> {
  const id = fingerprint;
  const entry: StoredFeedback = { ...f, id, createdAt: new Date().toISOString(), emailed };
  await env.CUBEFORGE_REGISTRY.put(`${FEEDBACK_PREFIX}${id}`, JSON.stringify(entry), { expirationTtl: FEEDBACK_TTL_SECONDS });
}

async function listFeedback(env: AdminEnv): Promise<StoredFeedback[]> {
  const keys = (await listKeys(env.CUBEFORGE_REGISTRY, FEEDBACK_PREFIX, 3)).slice(0, 200);
  const out: StoredFeedback[] = [];
  for (const k of keys) {
    const raw = await env.CUBEFORGE_REGISTRY.get(k);
    if (raw) try { out.push(JSON.parse(raw)); } catch { /* ignora */ }
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ---------------- rotas ----------------

function respond(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...extra },
  });
}

/** Devolve null quando a rota não é do painel. */
export async function handleAdminRequest(
  req: Request, env: AdminEnv, ip: string,
  failedAttempt: () => Promise<boolean>,
  probes: Probes = defaultProbes,
): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p !== '/admin' && !p.startsWith('/api/v1/admin/')) return null;
  if (!env.ADMIN_TOKEN) return respond({ success: false, message: 'Not found' }, 404);

  // A página em si não tem dado nenhum: o token é pedido nela e só vai nas chamadas à API.
  if (p === '/admin' && req.method === 'GET') {
    return respond(ADMIN_HTML, 200, { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
  }

  if (!(await adminAuthorized(req, env))) {
    if (!(await failedAttempt())) return respond({ success: false, message: 'Muitas tentativas.' }, 429);
    return respond({ success: false, message: 'Não autorizado.' }, 401);
  }

  if (req.method === 'GET' && p === '/api/v1/admin/overview') {
    return respond(await collectOverview(env, probes.fetch, Date.now(), url.searchParams.get('refresh') === '1'));
  }
  if (req.method === 'GET' && p === '/api/v1/admin/health') {
    const state = url.searchParams.get('refresh') === '1' ? await healthCron(env, probes) : await loadHealth(env);
    return respond({ state, now: new Date().toISOString() });
  }
  if (req.method === 'GET' && p === '/api/v1/admin/feedback') {
    return respond({ items: await listFeedback(env) });
  }
  const del = /^\/api\/v1\/admin\/feedback\/([a-f0-9]{8,64})$/.exec(p);
  if (req.method === 'DELETE' && del) {
    await env.CUBEFORGE_REGISTRY.delete(`${FEEDBACK_PREFIX}${del[1]}`);
    return respond({ success: true });
  }
  return respond({ success: false, message: 'Not found' }, 404);
}
