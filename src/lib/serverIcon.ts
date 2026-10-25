"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Ícone (server-icon.png) de cada servidor local, lido uma vez e guardado em memória. O editor de configurações avisa
// (invalidateServerIcon) quando a imagem muda, e todo lugar que mostra o ícone se atualiza sozinho.

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();

function load(path: string): Promise<string | null> {
  const pending = inflight.get(path);
  if (pending) return pending;
  const p = invoke<string | null>("get_server_icon", { serverDir: path })
    .catch(() => null)
    .then((icon) => {
      cache.set(path, icon);
      inflight.delete(path);
      listeners.forEach((l) => l());
      return icon;
    });
  inflight.set(path, p);
  return p;
}

/** Esquece o ícone guardado: a imagem do servidor mudou (ou foi removida) e deve ser lida de novo. */
export function invalidateServerIcon(path: string) {
  cache.delete(path);
  inflight.delete(path);
  listeners.forEach((l) => l());
}

/** Data URL do ícone do servidor, ou null (sem imagem, ainda carregando ou sem acesso). */
export function useServerIcon(path: string | null | undefined): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (path && !cache.has(path)) void load(path);
  }, [path, tick]);
  return path ? cache.get(path) ?? null : null;
}
