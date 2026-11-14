// ============================================================
// Perfil do jogador — cliente do Worker (ver api/src/profile.ts)
// ============================================================
// Nome exibido, avatar e cor da conta logada. Tudo passa pelo Worker, que valida
// e guarda (a tabela tem RLS sem policies). Sem conta não há perfil: o app
// continua funcionando igual, só sem essas personalizações.
// ============================================================

import { useAppStore } from "@/app/store";
import type { PlusStreakView, UserProfile } from "@/lib/profileCatalog";
import { authedFetch } from "@/lib/authedApi";

export interface MyProfileResult {
  profile: UserProfile | null;
  /** Nível do badge de tempo de assinatura do Plus (ou o prazo para não perdê-lo). */
  plusStreak: PlusStreakView;
  /** Nome vindo do Google/Discord, quando serve de ponto de partida (nunca o e-mail). */
  suggestedName: string | null;
}

export function getMyProfile(): Promise<MyProfileResult> {
  return authedFetch<MyProfileResult>("GET", "/api/v1/profile/me");
}

/** O que a pessoa edita no perfil (as imagens têm o próprio caminho de envio: ver profileImages.ts). */
export type ProfileEdit = Pick<UserProfile, "displayName" | "avatarId" | "nameColor" | "bio">;

export async function saveMyProfile(profile: ProfileEdit): Promise<UserProfile> {
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
  const { user, setProfile, setPlusStreak } = useAppStore.getState();
  if (!user) { setProfile(null); setPlusStreak(null); return; }
  try {
    const { profile, plusStreak } = await getMyProfile();
    // A conta pode ter trocado enquanto a resposta vinha.
    if (useAppStore.getState().user?.id === user.id) { setProfile(profile); setPlusStreak(plusStreak ?? null); }
  } catch {
    /* sem rede ou Worker fora: o perfil só não aparece agora */
  }
}
