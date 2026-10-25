"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  DEFAULT_APPEARANCE, DEFAULT_PALETTE_ID, MAX_CUSTOM_PALETTES, deriveTokens, findPalette, newPaletteId, sanitizeAppearance,
  type AppearanceState, type Mode, type Palette,
} from "./palette";

// Aplica a paleta ativa nas variáveis CSS da raiz e guarda a escolha neste computador (localStorage). Sem
// armazenamento disponível, a paleta vale só até fechar o app — nunca quebra nada.

const STORE_KEY = "cubicase-appearance";

function load(): AppearanceState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? sanitizeAppearance(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}
function save(state: AppearanceState) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* armazenamento indisponível */ }
}

/** Escreve (ou limpa, no padrão) as variáveis da paleta na raiz. `applied` lembra o que escrevemos para limpar depois. */
export function applyPalette(palette: Palette, mode: Mode, root: HTMLElement, applied: { keys: string[] }) {
  for (const k of applied.keys) root.style.removeProperty(k);
  applied.keys = [];
  if (palette.id === DEFAULT_PALETTE_ID) return; // o padrão é exatamente o que está em globals.css
  const tokens = deriveTokens(palette, mode);
  for (const [k, v] of Object.entries(tokens)) { root.style.setProperty(k, v); applied.keys.push(k); }
}

export function useAppearance() {
  const { resolvedTheme } = useTheme();
  const mode: Mode = resolvedTheme === "light" ? "light" : "dark";
  const [state, setState] = useState<AppearanceState>(DEFAULT_APPEARANCE);
  /** Paleta em edição (prévia ao vivo, ainda não salva). */
  const [preview, setPreview] = useState<Palette | null>(null);
  const applied = useRef<{ keys: string[] }>({ keys: [] });
  const loaded = useRef(false);

  useEffect(() => {
    const t = window.setTimeout(() => { setState(load()); loaded.current = true; }, 0);
    return () => clearTimeout(t);
  }, []);

  const active = findPalette(state, state.activeId);
  const shown = preview ?? active;
  useEffect(() => { applyPalette(shown, mode, document.documentElement, applied.current); }, [shown, mode]);
  // Ao sair da tela que usa as paletas, devolve o app às cores originais.
  useEffect(() => {
    const keys = applied.current;
    return () => { for (const k of keys.keys) document.documentElement.style.removeProperty(k); keys.keys = []; };
  }, []);

  const commit = useCallback((next: AppearanceState) => { setState(next); if (loaded.current) save(next); }, []);

  return {
    state, mode, active, preview, setPreview,
    custom: state.custom,
    canAddMore: state.custom.length < MAX_CUSTOM_PALETTES,
    select: (id: string) => commit({ ...state, activeId: id }),
    /** Cria (sem id) ou atualiza uma paleta própria e a ativa. */
    savePalette: (p: Palette) => {
      const id = p.id && state.custom.some((c) => c.id === p.id) ? p.id : newPaletteId();
      const saved = { ...p, id, builtin: undefined };
      const custom = state.custom.some((c) => c.id === id) ? state.custom.map((c) => (c.id === id ? saved : c)) : [...state.custom, saved];
      commit({ activeId: id, custom });
      return id;
    },
    remove: (id: string) => commit({ activeId: state.activeId === id ? DEFAULT_PALETTE_ID : state.activeId, custom: state.custom.filter((c) => c.id !== id) }),
    reset: () => commit(DEFAULT_APPEARANCE),
  };
}
