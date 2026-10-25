"use client";

import { useCallback, useEffect, useState } from "react";

// Servidores de amigos fixados no topo da lista do Convidado. Guardado só neste computador, pelo código do servidor.

const KEY = "cubicase-pinned-servers";

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  } catch {
    return [];
  }
}
function write(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* armazenamento indisponível */ }
}

export function usePinnedServers() {
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  useEffect(() => {
    const t = window.setTimeout(() => setPinned(new Set(read())), 0);
    return () => clearTimeout(t);
  }, []);

  const toggle = useCallback((code: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      write([...next]);
      return next;
    });
  }, []);
  /** Esquece um código (servidor removido da biblioteca). */
  const forget = useCallback((code: string) => {
    setPinned((prev) => {
      if (!prev.has(code)) return prev;
      const next = new Set(prev);
      next.delete(code);
      write([...next]);
      return next;
    });
  }, []);
  return { pinned, toggle, forget };
}
