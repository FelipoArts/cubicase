"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Painéis laterais retráteis e redimensionáveis: arraste a borda para mudar a largura, clique no botão (ou dê dois
// cliques na borda) para recolher/expandir. A largura e o estado ficam guardados neste computador.

export interface PanelSpec {
  /** Chave de armazenamento. */
  key: string;
  def: number;
  min: number;
  max: number;
  /** Largura quando recolhido (0 = some por completo). */
  collapsedWidth: number;
}

const STORE_PREFIX = "cubicase-v2-panel-";
/** Arrastar abaixo disto recolhe o painel. */
const SNAP_COLLAPSE_BELOW = 0.7;

function readStored(key: string): { width?: number; collapsed?: boolean } {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function writeStored(key: string, value: { width: number; collapsed: boolean }) {
  try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* armazenamento indisponível */ }
}

export function usePanel(spec: PanelSpec) {
  const [width, setWidth] = useState(spec.def);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const loaded = useRef(false);

  // Lê o que foi guardado depois de montar (evita diferença entre servidor e cliente na hidratação).
  useEffect(() => {
    const s = readStored(spec.key);
    const t = window.setTimeout(() => {
      if (typeof s.width === "number") setWidth(Math.min(spec.max, Math.max(spec.min, s.width)));
      if (typeof s.collapsed === "boolean") setCollapsed(s.collapsed);
      loaded.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, [spec.key, spec.min, spec.max]);

  useEffect(() => { if (loaded.current) writeStored(spec.key, { width, collapsed }); }, [spec.key, width, collapsed]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  const reset = useCallback(() => { setWidth(spec.def); setCollapsed(false); }, [spec.def]);

  /** Eventos da alça da borda. `edge`: a borda onde ela fica ("right" = painel à esquerda da tela). */
  const handleProps = useCallback((edge: "right" | "left" = "right") => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = collapsed ? spec.collapsedWidth : width;
      setDragging(true);
      const move = (ev: PointerEvent) => {
        const delta = (ev.clientX - startX) * (edge === "right" ? 1 : -1);
        const w = startW + delta;
        if (w < spec.min * SNAP_COLLAPSE_BELOW) { setCollapsed(true); return; }
        setCollapsed(false);
        setWidth(Math.min(spec.max, Math.max(spec.min, w)));
      };
      const up = () => {
        setDragging(false);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    onDoubleClick: reset,
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      const dir = edge === "right" ? 1 : -1;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = (e.key === "ArrowRight" ? 1 : -1) * dir * 16;
        setCollapsed(false);
        setWidth((w) => Math.min(spec.max, Math.max(spec.min, (collapsed ? spec.min : w) + step)));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Home") { e.preventDefault(); reset(); }
    },
  }), [collapsed, reset, spec.collapsedWidth, spec.max, spec.min, toggle, width]);

  return { width: collapsed ? spec.collapsedWidth : width, collapsed, dragging, toggle, reset, handleProps };
}

/** Alça fina na borda do painel (precisa de um pai com `position: relative`). */
export function ResizeHandle({ panel, edge = "right", label }: { panel: ReturnType<typeof usePanel>; edge?: "right" | "left"; label: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(panel.width)}
      tabIndex={0}
      title="Arraste para ajustar a largura · duplo clique restaura"
      {...panel.handleProps(edge)}
      className={cn(
        "group/handle absolute top-0 bottom-0 z-30 w-2 cursor-col-resize touch-none outline-none",
        edge === "right" ? "-right-1" : "-left-1",
      )}
    >
      <span className={cn("absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 rounded-full transition-colors", panel.dragging ? "bg-indigo-500" : "bg-transparent group-hover/handle:bg-indigo-400/70 group-focus-visible/handle:bg-indigo-500")} />
    </div>
  );
}
