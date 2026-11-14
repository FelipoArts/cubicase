// ============================================================
// Chamada autenticada à API Central (Worker) com a conta logada
// ============================================================
// Usa o token atual da sessão do Supabase e entende o envelope padrão da API ({ success, message, data }). Lança um
// erro com a mensagem da API (ou um erro genérico com o status HTTP) quando a resposta não é de sucesso.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "@/lib/supabaseClient";
import { getLocale, t } from "@/i18n";
import { API_BASE } from "@/lib/apiBase";

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

/** Erro de uma chamada à API, com o status HTTP (ex.: 403 = "não é membro"). */
export class ApiCallError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiCallError";
  }
}

/** Como `authedFetch`, mas com um corpo binário (ex.: uma imagem) em vez de JSON. */
export async function authedBinary<T>(method: "PUT" | "POST", path: string, body: Uint8Array, contentType: string): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new ApiCallError(t("err.notAuthenticated"), 401);

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": contentType, Authorization: `Bearer ${session.access_token}`, "Accept-Language": getLocale() },
    body: body as unknown as BodyInit,
  });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !json?.success) {
    throw new ApiCallError(json?.message || t("err.operationFailed", { status: res.status }), res.status);
  }
  return json.data as T;
}

export async function authedFetch<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new ApiCallError(t("err.notAuthenticated"), 401);

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      "Accept-Language": getLocale(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !json?.success) {
    throw new ApiCallError(json?.message || t("err.operationFailed", { status: res.status }), res.status);
  }
  return json.data as T;
}
