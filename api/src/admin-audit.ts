// ============================================================
// Registro de ações do painel do dono
// ============================================================
// Cada ação que muda algo (dar/tirar Plus, limpar imagem, trocar nome...) deixa uma linha aqui: quando, o quê e em qual
// conta. Guardado no KV com a entrada inteira nos METADADOS da chave (listar já traz tudo, sem um `get` por linha) e
// uma chave "invertida" no tempo, para a listagem sair da mais nova para a mais antiga. Some sozinho em 1 ano.
// ============================================================

export interface AuditEnv { CUBEFORGE_REGISTRY: KVNamespace }

export interface AuditEntry {
  at: string;
  action: string;
  /** Quem sofreu a ação (id da conta) e um rótulo legível (e-mail ou nome) na hora da ação. */
  target: string;
  label: string;
  detail?: string;
}

const AUDIT_PREFIX = 'audit:';
const AUDIT_TTL_SECONDS = 365 * 24 * 3600;
const MAX_MS = 9_999_999_999_999;

function clip(s: string | undefined, n: number): string | undefined {
  return s === undefined ? undefined : s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, n);
}

export async function recordAudit(env: AuditEnv, entry: Omit<AuditEntry, 'at'>, nowMs = Date.now()): Promise<void> {
  const full: AuditEntry = { at: new Date(nowMs).toISOString(), action: clip(entry.action, 40)!, target: clip(entry.target, 64)!, label: clip(entry.label, 120)!, detail: clip(entry.detail, 160) };
  const rand = crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  const key = `${AUDIT_PREFIX}${String(MAX_MS - nowMs).padStart(13, '0')}:${rand}`;
  await env.CUBEFORGE_REGISTRY.put(key, '1', { expirationTtl: AUDIT_TTL_SECONDS, metadata: full });
}

export async function listAudit(env: AuditEnv, limit = 50): Promise<AuditEntry[]> {
  const page = await env.CUBEFORGE_REGISTRY.list<AuditEntry>({ prefix: AUDIT_PREFIX, limit });
  return page.keys.map((k) => k.metadata).filter((m): m is AuditEntry => !!m && typeof m.at === 'string');
}
