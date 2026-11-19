// ============================================================
// Contagem anônima de instalações
// ============================================================
// No máximo uma vez por dia (ou a cada hora, se um marco novo apareceu) o app manda: um ID aleatório desta instalação
// (gerado aqui, sem relação com a conta, o nome do computador ou o IP), a versão do app, o sistema e dois números com as
// etapas alcançadas e os tipos de falha já ocorridos (lib/milestones.ts). Nada mais. O envio pode ser desligado em Configurações.
// Falha de rede é silenciosa: tenta de novo na próxima abertura.
// ============================================================

import { getMilestoneMask, getErrorMask } from "./milestones";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";
const ID_KEY = "cubicase-install-id";
const LAST_KEY = "cubicase-install-ping-at";
const SENT_KEY = "cubicase-install-ping-sent"; // "marcos:falhas" do último envio
const MIN_RESEND_MS = 55 * 60_000;
const ONE_DAY_MS = 20 * 3600_000; // alinhado ao Worker (que só regrava depois de ~20 h)

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* sem storage: não conta, sem problema */ }
}

export function getInstallId(): string | null {
  const cur = read(ID_KEY);
  if (cur && /^[0-9a-f-]{32,36}$/i.test(cur)) return cur;
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") return null;
  const id = crypto.randomUUID();
  write(ID_KEY, id);
  return read(ID_KEY) === id ? id : null; // sem como guardar o ID, não manda (senão contaria a mesma pessoa várias vezes)
}

export function detectOs(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): "windows" | "macos" | "linux" | "other" {
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

/** Manda o ping se estiver ligado e se já passou um dia desde o último. Devolve true se mandou. */
export async function sendInstallPing(enabled: boolean, version: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  if (!enabled || !/^\d+\.\d+\.\d+/.test(version)) return false;
  const last = Number(read(LAST_KEY) ?? 0);
  const s = getMilestoneMask(), e = getErrorMask();
  const changed = read(SENT_KEY) !== `${s}:${e}`;
  if (last && now - last < (changed ? MIN_RESEND_MS : ONE_DAY_MS)) return false;
  const id = getInstallId();
  if (!id) return false;
  try {
    const res = await fetchImpl(`${API_BASE}/api/v1/installs/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, v: version, os: detectOs(), s, e }),
    });
    if (!res.ok) return false;
    write(LAST_KEY, String(now));
    write(SENT_KEY, `${s}:${e}`);
    return true;
  } catch {
    return false;
  }
}
