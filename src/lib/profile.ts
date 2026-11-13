// ============================================================
// Perfil do jogador — cliente do Worker (ver api/src/profile.ts)
// ============================================================
// Nome exibido, avatar e cor da conta logada. Tudo passa pelo Worker, que valida
// e guarda (a tabela tem RLS sem policies). Sem conta não há perfil: o app
// continua funcionando igual, só sem essas personalizações.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "@/lib/supabaseClient";
import { useAppStore } from "@/app/store";
import { getLocale, t } from "@/i18n";
import type { UserProfile } from "@/lib/profileCatalog";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

async function authedFetch<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error(t("err.notAuthenticated"));

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
    throw new Error(json?.message || t("err.operationFailed", { status: res.status }));
  }
  return json.data as T;
}

export interface MyProfileResult {
  profile: UserProfile | null;
  /** Nome vindo do Google/Discord, quando serve de ponto de partida (nunca o e-mail). */
  suggestedName: string | null;
}

export function getMyProfile(): Promise<MyProfileResult> {
  return authedFetch<MyProfileResult>("GET", "/api/v1/profile/me");
}

export async function saveMyProfile(profile: UserProfile): Promise<UserProfile> {
  const data = await authedFetch<{ profile: UserProfile }>("PUT", "/api/v1/profile/me", profile);
  useAppStore.getState().setProfile(data.profile);
  return data.profile;
}

export async function deleteMyProfile(): Promise<void> {
  await authedFetch<unknown>("DELETE", "/api/v1/profile/me");
  useAppStore.getState().setProfile(null);
}

/** Carrega o perfil da conta logada para a store (ou limpa, sem conta). Falha de rede não derruba nada. */
export async function syncProfile(): Promise<void> {
  const { user, setProfile } = useAppStore.getState();
  if (!user) { setProfile(null); return; }
  try {
    const { profile } = await getMyProfile();
    // A conta pode ter trocado enquanto a resposta vinha.
    if (useAppStore.getState().user?.id === user.id) setProfile(profile);
  } catch {
    /* sem rede ou Worker fora: o perfil só não aparece agora */
  }
}
