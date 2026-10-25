// ============================================================
// Ícone do servidor na central (para os convidados verem a mesma imagem do Minecraft)
// ============================================================
// O ícone mora em `server-icon.png` na pasta do servidor. Aqui ele é enviado para a API Central (PUT .../icon), onde os
// convidados o baixam quando o hash que vem no status do servidor muda (ver src/lib/guestServerIcon.ts). Só o dono
// envia: a rota exige o segredo do servidor, que o Rust guarda (get_owner_secret).
// Melhor esforço: falha de rede nunca atrapalha ligar o servidor ou salvar configurações.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";
const SYNCED_KEY = (shortCode: string) => `cubicase-icon-synced:${shortCode}`;

export type IconSyncResult = "uploaded" | "removed" | "unchanged" | "failed";

/** Hash curto (16 hex) dos bytes — o mesmo cálculo do Worker, para comparar com `iconHash` do status. */
export async function iconHashOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function readSynced(shortCode: string): string | null {
  try { return localStorage.getItem(SYNCED_KEY(shortCode)); } catch { return null; }
}
function writeSynced(shortCode: string, hash: string | null) {
  try {
    if (hash) localStorage.setItem(SYNCED_KEY(shortCode), hash); else localStorage.removeItem(SYNCED_KEY(shortCode));
  } catch { /* armazenamento indisponível: no pior caso reenvia na próxima vez */ }
}

/**
 * Deixa a central igual ao `server-icon.png` local. `force` ignora o "já enviei esta imagem" (ação do usuário no editor).
 * `retries`: o servidor recém-criado pode ainda estar sendo registrado na central, então tenta de novo com folga.
 */
export async function syncServerIcon(serverDir: string, shortCode: string, opts: { force?: boolean; retries?: number } = {}): Promise<IconSyncResult> {
  try {
    const dataUrl = await invoke<string | null>("get_server_icon", { serverDir });
    const bytes = dataUrl ? dataUrlToBytes(dataUrl) : null;
    const previous = readSynced(shortCode);

    if (!bytes) {
      if (!previous && !opts.force) return "unchanged"; // nunca enviamos nada, não há o que apagar
    } else {
      const hash = await iconHashOf(bytes);
      if (!opts.force && previous === hash) return "unchanged";
    }

    const secret = await invoke<string>("get_owner_secret", { shortCode });
    const attempts = Math.max(1, (opts.retries ?? 0) + 1);
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}/icon`, {
        method: bytes ? "PUT" : "DELETE",
        headers: { "X-Owner-Secret": secret, ...(bytes ? { "Content-Type": "image/png" } : {}) },
        body: bytes ? (bytes as unknown as BodyInit) : undefined,
      });
      if (res.ok) {
        writeSynced(shortCode, bytes ? await iconHashOf(bytes) : null);
        return bytes ? "uploaded" : "removed";
      }
      // 404 = o servidor ainda não está na central; 429 = limite. Espera e tenta de novo; o resto não adianta repetir.
      if ((res.status !== 404 && res.status !== 429) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 6000));
    }
    return "failed";
  } catch (err) {
    console.warn("[ícone] não consegui sincronizar o ícone do servidor:", err);
    return "failed";
  }
}
