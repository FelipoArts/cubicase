"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Checkbox estilizado. Mantém o <input type="checkbox"> nativo (transparente) por
// cima da caixa, então teclado, foco e leitores de tela funcionam como o padrão; só a
// caixa visual é nossa.

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  title?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, title, disabled, className }: CheckboxProps) {
  return (
    <span title={title} className={cn("relative inline-flex flex-shrink-0", disabled && "opacity-50", className)}>
      {/* Input nativo transparente por cima da caixa: recebe o clique/foco e funciona também dentro de um <label>. */}
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        className={cn(
          "h-5 w-5 rounded-md border-2 flex items-center justify-center transition-all duration-150",
          "border-slate-300 dark:border-slate-600 bg-theme-card hover:border-indigo-400",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500/50 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-transparent",
          "peer-checked:bg-indigo-600 peer-checked:border-indigo-600 peer-checked:shadow-sm peer-checked:shadow-indigo-600/30",
          "[&>svg]:scale-50 [&>svg]:opacity-0 peer-checked:[&>svg]:scale-100 peer-checked:[&>svg]:opacity-100"
        )}
      >
        <Check strokeWidth={3.5} className="w-3 h-3 text-white transition-all duration-150" />
      </span>
    </span>
  );
}
