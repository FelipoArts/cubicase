"use client";

import { useSyncExternalStore } from "react";

// Pedido para abrir uma aba da área de trabalho do host a partir de outro lugar (a engrenagem do menu lateral, o modal do
// Plus). A aba em si é estado da própria tela do host; aqui só fica o pedido, numerado para que pedir a mesma aba duas
// vezes seguidas também conte.

export type HostTab = "overview" | "players" | "world" | "mods" | "performance" | "settings";

interface Request { tab: HostTab; n: number }

let request: Request | null = null;
let counter = 0;
const listeners = new Set<() => void>();

export function goToHostTab(tab: HostTab) {
  request = { tab, n: ++counter };
  listeners.forEach((l) => l());
}

/** O pedido foi atendido pela tela do host. */
export function clearHostTabRequest() {
  if (request === null) return;
  request = null;
  listeners.forEach((l) => l());
}

export function useHostTabRequest(): Request | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => request,
    () => request,
  );
}
