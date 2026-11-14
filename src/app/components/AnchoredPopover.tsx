"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";

interface Props {
  /** O elemento clicado: o cartão abre colado nele (acima, se houver espaço; senão abaixo). */
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label: string;
}

const GAP = 8;
const MARGIN = 8;
/** Espaço mínimo acima do elemento para abrir para cima. */
const NEEDED_ABOVE = 360;

function place(anchor: HTMLElement, width: number) {
  const r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - width - MARGIN));
  return r.top > NEEDED_ABOVE
    ? { left, bottom: window.innerHeight - r.top + GAP, top: undefined as number | undefined, above: true }
    : { left, top: r.bottom + GAP, bottom: undefined as number | undefined, above: false };
}

/**
 * Cartão flutuante colado a um elemento, levado ao body (não é cortado por painéis com overflow). Fecha com Esc,
 * com um clique fora dele ou ao rolar/redimensionar a janela. Clicar no próprio elemento de origem não o fecha por
 * este caminho: quem abre decide se o clique alterna (ver `anchor`).
 */
export function AnchoredPopover({ anchor, onClose, children, width = 296, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos] = useState(() => place(anchor, width));

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    ref.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      initial={{ opacity: 0, scale: 0.96, y: pos.above ? 8 : -8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", duration: 0.3 }}
      style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width, zIndex: 80, transformOrigin: pos.above ? "bottom left" : "top left" }}
      className="outline-none"
    >
      {children}
    </motion.div>,
    document.body,
  );
}
