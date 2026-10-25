"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useAppStore } from "@/app/store";
import { getSubscriptionStatus, isSubscriptionActive, type SubscriptionInfo } from "@/lib/subscription";

// ============================================================
// Cubicase Plus na interface
// ============================================================
// 1) Modal do Plus: qualquer tela abre com `openPlus("wake")` e o modal mostra "isto é um recurso do Plus" já com o
//    benefício em foco. O modal em si fica uma vez só em page.tsx.
// 2) Estado da assinatura compartilhado: vários lugares precisam saber se a pessoa é Plus (para travar ou liberar um
//    botão). Uma só consulta ao Supabase vale para todos, e o modal do Plus a atualiza assim que o pagamento é confirmado.
// O Worker continua sendo quem decide de verdade; isto só controla o que a interface mostra.
// ============================================================

export type PlusFeature = "panel" | "wake" | "link" | "address" | "private" | "team";

interface UiState { open: boolean; feature: PlusFeature | null }
let ui: UiState = { open: false, feature: null };
const uiListeners = new Set<() => void>();
const setUi = (next: UiState) => { ui = next; uiListeners.forEach((l) => l()); };

export function openPlus(feature?: PlusFeature) { setUi({ open: true, feature: feature ?? null }); }
export function closePlus() { setUi({ open: false, feature: null }); }
export function usePlusUi(): UiState {
  return useSyncExternalStore(
    (cb) => { uiListeners.add(cb); return () => { uiListeners.delete(cb); }; },
    () => ui,
    () => ui,
  );
}

// ---------------- assinatura ----------------

interface SubState { info: SubscriptionInfo | null; loaded: boolean; loading: boolean; userId: string | null }
let sub: SubState = { info: null, loaded: false, loading: false, userId: null };
const subListeners = new Set<() => void>();
const setSub = (next: SubState) => { sub = next; subListeners.forEach((l) => l()); };

/** Atualiza o que todo mundo sabe sobre a assinatura (usado também pelo modal do Plus depois do pagamento). */
export function setSubscriptionInfo(info: SubscriptionInfo | null) {
  setSub({ info, loaded: true, loading: false, userId: useAppStore.getState().user?.id ?? null });
}

export async function refreshSubscription(): Promise<SubscriptionInfo | null> {
  const userId = useAppStore.getState().user?.id ?? null;
  setSub({ ...sub, loading: true, userId });
  try {
    const info = await getSubscriptionStatus();
    // Trocou de conta durante a consulta: a resposta é da conta antiga e não vale para a nova.
    if (sub.userId !== userId) return null;
    setSub({ info, loaded: true, loading: false, userId });
    return info;
  } catch {
    if (sub.userId !== userId) return null;
    setSub({ info: null, loaded: true, loading: false, userId });
    return null;
  }
}

export function useSubscriptionInfo(): { info: SubscriptionInfo | null; active: boolean; loading: boolean } {
  const user = useAppStore((s) => s.user);
  const state = useSyncExternalStore(
    (cb) => { subListeners.add(cb); return () => { subListeners.delete(cb); }; },
    () => sub,
    () => sub,
  );
  useEffect(() => {
    if (!user) { if (sub.info || sub.loaded || sub.userId) setSub({ info: null, loaded: false, loading: false, userId: null }); return; }
    // Outra conta (sair de uma e entrar em outra): o que estava guardado era da anterior, então começa do zero.
    if (sub.userId !== user.id) setSub({ info: null, loaded: false, loading: false, userId: user.id });
    if (!sub.loaded && !sub.loading) void refreshSubscription();
  }, [user]);
  const mine = !!user && state.userId === user.id;
  return { info: mine ? state.info : null, active: mine && isSubscriptionActive(state.info), loading: !!user && (!mine || state.loading || !state.loaded) };
}
