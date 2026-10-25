"use client";

import { useSyncExternalStore } from "react";

// Preferências de interface guardadas só neste computador (localStorage), independentes do store principal.
// Hoje: qual interface usar — a nova (menu lateral + abas) ou a anterior.

const NEW_UI_KEY = "cubicase-new-ui";
const listeners = new Set<() => void>();

export function getNewUi(): boolean {
  try { return localStorage.getItem(NEW_UI_KEY) === "1"; } catch { return false; }
}

export function setNewUi(value: boolean) {
  try { localStorage.setItem(NEW_UI_KEY, value ? "1" : "0"); } catch { /* armazenamento indisponível: vale só até fechar */ }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}

/** true quando a pessoa escolheu a nova interface. */
export function useNewUi(): boolean {
  return useSyncExternalStore(subscribe, getNewUi, () => false);
}
