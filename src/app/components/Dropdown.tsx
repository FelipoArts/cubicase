"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Dropdown estilizado (no lugar do <select> nativo, que não acompanha o tema):
// botão + painel flutuante com o item atual marcado. Fecha ao clicar fora ou
// com Esc; setas + Enter funcionam quando aberto.

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface DropdownProps<T extends string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Rótulo pequeno antes do valor no botão (ex.: "Ordenar:"). */
  prefix?: string;
  disabled?: boolean;
  title?: string;
  /** Lado em que o painel alinha com o botão. */
  align?: "left" | "right";
  className?: string;
}

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  prefix,
  disabled,
  title,
  align = "left",
  className,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen((o) => !o);
  };

  const choose = (v: T) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(options[active].value);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={cn(
          "w-full h-10 pl-3.5 pr-3 border border-theme-card rounded-2xl bg-transparent text-xs font-bold text-theme-primary",
          "flex items-center justify-between gap-2 transition-colors cursor-pointer",
          "hover:border-indigo-400 focus:border-indigo-500 focus:outline-none",
          open && "border-indigo-500",
          disabled && "opacity-40 cursor-not-allowed hover:border-theme-card"
        )}
      >
        <span className="truncate">
          {prefix && <span className="text-theme-secondary font-semibold">{prefix} </span>}
          {selected?.label}
        </span>
        <ChevronDown className={cn("w-4 h-4 text-theme-secondary flex-shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          className={cn(
            "absolute z-50 mt-1 min-w-full w-max max-w-[16rem] max-h-64 overflow-y-auto custom-scrollbar p-1",
            "bg-theme-card border border-theme-card rounded-2xl shadow-xl",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => choose(o.value)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-xs font-semibold text-left transition-colors cursor-pointer",
                o.value === value ? "text-indigo-700 dark:text-indigo-300" : "text-theme-primary",
                i === active && "bg-theme-muted"
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
