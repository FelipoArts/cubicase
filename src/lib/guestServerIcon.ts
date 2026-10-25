"use client";

import { useEffect, useState } from "react";
import { fetch } from "@tauri-apps/plugin-http";

// Ícone dos servidores de amigos. O status de cada servidor (consultado a cada ~30 s) traz só um hash curto do ícone
// (`iconHash`); a imagem é baixada da API Central apenas quando o hash muda e guardada neste computador, então o
// download é raro. Sem hash = o host não definiu ícone.

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";
const STORE_KEY = (shortCode: string) => `cubicase-guest-icon:${shortCode}`;
const MAX_BYTES = 32 * 1024;

interface Cached { hash: string; url: string }
const memory = new Map<string, Cached | null>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function readStored(shortCode: string): Cached | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY(shortCode)) ?? "null");
    return v && typeof v.hash === "string" && typeof v.url === "string" && v.url.startsWith("data:image/png;base64,") ? v : null;
  } catch {
    return null;
  }
}
function writeStored(shortCode: string, value: Cached | null) {
  try {
    if (value) localStorage.setItem(STORE_KEY(shortCode), JSON.stringify(value)); else localStorage.removeItem(STORE_KEY(shortCode));
  } catch { /* armazenamento cheio ou indisponível: vale só nesta sessão */ }
}
function current(shortCode: string): Cached | null {
  if (!memory.has(shortCode)) memory.set(shortCode, readStored(shortCode));
  return memory.get(shortCode) ?? null;
}

function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > 33 && sig.every((b, i) => bytes[i] === b);
}
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function download(shortCode: string, hash: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}/icon?v=${hash}`);
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A imagem vem de fora: só entra se for mesmo um PNG pequeno (e é exibida só numa tag de imagem).
    if (bytes.length > MAX_BYTES || !isPng(bytes)) return;
    const value = { hash, url: `data:image/png;base64,${toBase64(bytes)}` };
    memory.set(shortCode, value);
    writeStored(shortCode, value);
    notify();
  } catch {
    /* sem rede agora: tenta de novo no próximo status */
  } finally {
    inflight.delete(shortCode);
  }
}

/** Chamado a cada status recebido do servidor: baixa o ícone se o hash mudou, ou esquece o ícone se o host o removeu. */
export function noteServerIconHash(shortCode: string, hash: unknown) {
  const valid = typeof hash === "string" && /^[a-f0-9]{16}$/.test(hash) ? hash : null;
  const have = current(shortCode);
  if (!valid) {
    if (have) { memory.set(shortCode, null); writeStored(shortCode, null); notify(); }
    return;
  }
  if (have?.hash === valid || inflight.has(shortCode)) return;
  inflight.set(shortCode, download(shortCode, valid));
}

/** Ícone guardado do servidor de um amigo (data URL) ou null. */
export function useGuestServerIcon(shortCode: string | null | undefined): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return shortCode ? current(shortCode)?.url ?? null : null;
}
