"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/apiBase";
import { authedFetch } from "@/lib/authedApi";
import type { TKey } from "@/i18n";

// ============================================================
// Aparência do servidor para os amigos: cor, etiquetas, recado e banner
// ============================================================
// O host escolhe (ver ServerLookEditor); a API Central entrega junto com o status do servidor (data.server.look) e
// este módulo guarda a última aparência vista de cada servidor neste computador, para a tela dos amigos já abrir
// colorida. Tudo o que vem da rede é conferido contra as listas fechadas daqui antes de ser usado.
// ============================================================

export const LOOK_COLORS = [
  { id: "indigo", hex: "#6366f1", labelKey: "look.color.indigo" },
  { id: "violet", hex: "#8b5cf6", labelKey: "look.color.violet" },
  { id: "pink", hex: "#ec4899", labelKey: "look.color.pink" },
  { id: "rose", hex: "#f43f5e", labelKey: "look.color.rose" },
  { id: "red", hex: "#ef4444", labelKey: "look.color.red" },
  { id: "orange", hex: "#f97316", labelKey: "look.color.orange" },
  { id: "amber", hex: "#f59e0b", labelKey: "look.color.amber" },
  { id: "lime", hex: "#84cc16", labelKey: "look.color.lime" },
  { id: "emerald", hex: "#10b981", labelKey: "look.color.emerald" },
  { id: "teal", hex: "#14b8a6", labelKey: "look.color.teal" },
  { id: "sky", hex: "#0ea5e9", labelKey: "look.color.sky" },
  { id: "slate", hex: "#64748b", labelKey: "look.color.slate" },
] as const satisfies readonly { id: string; hex: string; labelKey: TKey }[];

export const LOOK_TAGS = [
  { id: "survival", labelKey: "look.tag.survival" },
  { id: "creative", labelKey: "look.tag.creative" },
  { id: "modded", labelKey: "look.tag.modded" },
  { id: "vanilla", labelKey: "look.tag.vanilla" },
  { id: "ptbr", labelKey: "look.tag.ptbr" },
  { id: "english", labelKey: "look.tag.english" },
  { id: "casual", labelKey: "look.tag.casual" },
  { id: "hardcore", labelKey: "look.tag.hardcore" },
  { id: "pvp", labelKey: "look.tag.pvp" },
  { id: "minigames", labelKey: "look.tag.minigames" },
  { id: "roleplay", labelKey: "look.tag.roleplay" },
  { id: "building", labelKey: "look.tag.building" },
] as const satisfies readonly { id: string; labelKey: TKey }[];

export const LOOK_TAGS_MAX = 3;
export const LOOK_NOTE_MAX = 140;
export const LOOK_NOTE_MAX_LINES = 2;

export interface ServerLookView {
  color: string | null;
  tags: string[];
  note: string | null;
  bannerHash: string | null;
}

export const EMPTY_SERVER_LOOK: ServerLookView = { color: null, tags: [], note: null, bannerHash: null };

export function lookColorHex(id: string | null | undefined): string | null {
  return LOOK_COLORS.find((c) => c.id === id)?.hex ?? null;
}

export function lookTagKey(id: string): TKey | null {
  return LOOK_TAGS.find((t) => t.id === id)?.labelKey ?? null;
}

/** Banner do servidor. O `?v=` é o hash: muda quando o banner muda, então o cache nunca mostra um banner velho. */
export function serverBannerUrl(shortCode: string, hash: string): string {
  return `${API_BASE}/api/v1/servers/${encodeURIComponent(shortCode)}/banner?v=${hash}`;
}

/** Denuncia o banner do servidor (o Worker confere que quem denuncia também é membro dele). */
export async function reportServerBanner(shortCode: string, reason: "image" | "other", note: string): Promise<void> {
  await authedFetch("POST", `/api/v1/servers/${encodeURIComponent(shortCode.toUpperCase())}/banner/report`, { reason, note: note.trim() || undefined });
}

/** Aceita só o que a gente conhece. Qualquer coisa fora do formato vira "sem aparência". */
export function sanitizeLook(raw: unknown): ServerLookView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const color = typeof r.color === "string" && LOOK_COLORS.some((c) => c.id === r.color) ? r.color : null;
  const tags = Array.isArray(r.tags)
    ? [...new Set(r.tags.filter((t): t is string => typeof t === "string" && LOOK_TAGS.some((x) => x.id === t)))].slice(0, LOOK_TAGS_MAX)
    : [];
  const note = typeof r.note === "string" && r.note.trim() !== "" ? r.note.slice(0, LOOK_NOTE_MAX) : null;
  const bannerHash = typeof r.bannerHash === "string" && /^[a-f0-9]{32}$/.test(r.bannerHash) ? r.bannerHash : null;
  return { color, tags, note, bannerHash };
}

// ------------------------------------------------------------
// Guardado dos servidores dos amigos
// ------------------------------------------------------------

const STORE_KEY = (shortCode: string) => `cubicase-guest-look:${shortCode}`;
const memory = new Map<string, ServerLookView | null>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function readStored(shortCode: string): ServerLookView | null {
  try { return sanitizeLook(JSON.parse(localStorage.getItem(STORE_KEY(shortCode)) ?? "null")); } catch { return null; }
}
function writeStored(shortCode: string, value: ServerLookView | null) {
  try {
    if (value) localStorage.setItem(STORE_KEY(shortCode), JSON.stringify(value)); else localStorage.removeItem(STORE_KEY(shortCode));
  } catch { /* armazenamento indisponível: vale só nesta sessão */ }
}
function current(shortCode: string): ServerLookView | null {
  if (!memory.has(shortCode)) memory.set(shortCode, readStored(shortCode));
  return memory.get(shortCode) ?? null;
}

/** Chamado a cada status recebido do servidor com o `look` que a API mandou (ou nada, se o host nunca definiu). */
export function noteServerLook(shortCode: string, raw: unknown) {
  const next = sanitizeLook(raw);
  if (JSON.stringify(next) === JSON.stringify(current(shortCode))) return;
  memory.set(shortCode, next);
  writeStored(shortCode, next);
  notify();
}

/** Lê a aparência guardada sem se inscrever (para usar dentro de um .map; combine com `useServerLookVersion`). */
export function peekServerLook(shortCode: string): ServerLookView | null {
  return current(shortCode);
}

/** Faz o componente redesenhar quando a aparência de qualquer servidor muda. */
export function useServerLookVersion(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
}

/** A aparência guardada do servidor de um amigo, ou null. */
export function useServerLook(shortCode: string | null | undefined): ServerLookView | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return shortCode ? current(shortCode) : null;
}
