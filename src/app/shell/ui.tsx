"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Peças visuais compartilhadas pelas abas do protótipo /v2.

export function Card({ title, hint, action, children, className }: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("bg-theme-card border-theme-card shadow-theme-card rounded-2xl p-5", className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-bold text-theme-primary">{title}</h3>}
            {hint && <p className="text-xs text-theme-secondary mt-0.5">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="inline-flex bg-theme-muted p-1 rounded-xl border border-theme-card" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "px-3.5 py-1.5 rounded-lg text-xs font-bold cursor-pointer flex items-center gap-1.5",
            value === o.id ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="text-[10px] opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative w-9 h-5 rounded-full shrink-0 border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-indigo-600 border-indigo-600" : "bg-theme-muted border-theme-card",
      )}
    >
      <span className={cn("absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export const inputCls =
  "w-full bg-theme-input border border-theme-input rounded-xl px-3 py-2 text-sm text-theme-primary outline-none focus:border-indigo-500 disabled:opacity-60";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-bold text-theme-primary">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-theme-secondary">{hint}</span>}
    </label>
  );
}

export function ToggleRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-bold text-theme-primary">{label}</p>
        {hint && <p className="text-xs text-theme-secondary mt-0.5">{hint}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

export function Notice({ tone = "info", children, action }: { tone?: "info" | "warning" | "danger"; children: ReactNode; action?: ReactNode }) {
  const style =
    tone === "warning" ? "bg-theme-warning border-theme-warning text-amber-700 dark:text-amber-300"
    : tone === "danger" ? "bg-theme-danger border-theme-danger text-rose-700 dark:text-rose-300"
    : "bg-theme-accent border-theme-accent text-theme-primary";
  return (
    <div className={cn("flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm", style)}>
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  return <span className="w-8 h-8 rounded-lg bg-theme-muted border border-theme-card grid place-items-center text-xs font-bold shrink-0">{name[0]?.toUpperCase()}</span>;
}

export function MiniButton({ children, tone = "default", ...rest }: { children: ReactNode; tone?: "default" | "danger" | "primary" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const style =
    tone === "danger" ? "border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
    : tone === "primary" ? "bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700"
    : "bg-theme-muted border-theme-card text-theme-primary hover:border-indigo-400";
  return (
    <button type="button" {...rest} className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed", style, rest.className)}>
      {children}
    </button>
  );
}
