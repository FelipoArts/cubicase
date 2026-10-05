"use client";

import { cn } from "@/lib/utils";

// Interruptor liga/desliga estilizado (role="switch", acessível por teclado).

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  title?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, title, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-6 w-10 rounded-full flex-shrink-0 border transition-colors duration-200 cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent",
        checked
          ? "bg-indigo-600 border-indigo-600 shadow-inner shadow-indigo-900/30"
          : "bg-slate-200 dark:bg-slate-700 border-slate-300 dark:border-slate-600 hover:border-indigo-400",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 -translate-y-1/2 left-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-md shadow-black/20",
          "transition-transform duration-200 ease-out",
          checked ? "translate-x-[16px]" : "translate-x-0"
        )}
      />
    </button>
  );
}
