import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { API_BASE } from "@/lib/apiBase";
import { supabase } from "@/lib/supabaseClient";
import { getLocale } from "@/i18n";
import { sanitizeLook, type ServerLookView } from "@/lib/serverLook";

// ============================================================
// Chamadas do host para a aparência do servidor (cor, etiquetas, recado e banner)
// ============================================================
// Só o dono altera: a API exige o segredo do servidor, que o Rust guarda (get_owner_secret). O banner exige também a
// conta logada com Plus (o Worker confere os dois). A leitura é pública, como o resto do status do servidor.
// ============================================================

export class LookApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LookApiError";
  }
}

export interface LookEditInput {
  color: string | null;
  tags: string[];
  note: string | null;
}

async function call(shortCode: string, path: string, init: { method: string; body?: BodyInit; headers?: Record<string, string>; auth?: boolean }): Promise<ServerLookView | null> {
  const secret = await invoke<string>("get_owner_secret", { shortCode });
  const headers: Record<string, string> = { "X-Owner-Secret": secret, "Accept-Language": getLocale(), ...(init.headers ?? {}) };
  if (init.auth) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new LookApiError("", 401);
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}/${path}`, { method: init.method, headers, body: init.body });
  const json = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: { look?: unknown } } | null;
  if (!res.ok || !json?.success) throw new LookApiError(json?.message ?? "", res.status);
  return sanitizeLook(json.data?.look);
}

/** A aparência atual (a API só mostra o banner enquanto a conta que o enviou assina o Plus). */
export async function fetchServerLook(shortCode: string): Promise<ServerLookView | null> {
  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}`);
  if (!res.ok) throw new LookApiError("", res.status);
  const json = (await res.json().catch(() => null)) as { data?: { server?: { look?: unknown } } } | null;
  return sanitizeLook(json?.data?.server?.look);
}

export const saveServerLook = (shortCode: string, edit: LookEditInput) =>
  call(shortCode, "look", { method: "PUT", body: JSON.stringify(edit), headers: { "Content-Type": "application/json" } });

export async function uploadServerBanner(shortCode: string, blob: Blob): Promise<ServerLookView | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return call(shortCode, "banner", { method: "PUT", body: bytes as unknown as BodyInit, headers: { "Content-Type": "image/webp" }, auth: true });
}

export const removeServerBanner = (shortCode: string) => call(shortCode, "banner", { method: "DELETE" });
