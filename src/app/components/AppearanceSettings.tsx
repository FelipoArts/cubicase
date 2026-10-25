"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { AlertTriangle, Check, Copy, FileDown, Moon, Pencil, Plus, Sun, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppearanceContext } from "@/app/providers/AppearanceProvider";
import { exportPaletteToFile, importPaletteFromFile } from "@/lib/theme/paletteFile";
import {
  BUILTIN_PALETTES, contrastIssues, deriveTokens, hslToHex, isHex, newPaletteId,
  type Mode, type Palette, type TokenKey,
} from "@/lib/theme/palette";
import { useT, type TKey } from "@/i18n";
import { inputCls, MiniButton } from "@/app/shell/ui";

// "Aparência" das configurações do app: tema (claro/escuro), paletas prontas e paletas próprias.
// Escolher uma paleta aplica na hora; no editor, cada ajuste aparece ao vivo e só vale ao salvar.

function Swatch({ palette, mode }: { palette: Palette; mode: Mode }) {
  const t = deriveTokens(palette, mode);
  return (
    <span className="block rounded-lg overflow-hidden border border-black/10 h-14 p-1.5" style={{ background: t["--background"] }} aria-hidden>
      <span className="block h-full rounded-md p-1.5 space-y-1" style={{ background: t["--card-bg"], border: `1px solid ${t["--card-border"]}` }}>
        <span className="block h-1.5 w-2/3 rounded-full" style={{ background: t["--text-primary"], opacity: 0.85 }} />
        <span className="block h-1.5 w-1/3 rounded-full" style={{ background: t["--text-secondary"], opacity: 0.6 }} />
        <span className="block h-2 w-6 rounded-md" style={{ background: t["--color-indigo-600"] }} />
      </span>
    </span>
  );
}

function ColorField({ label, value, onChange, onClear, placeholder }: { label: string; value: string; onChange: (hex: string) => void; onClear?: () => void; placeholder?: string }) {
  const { t } = useT();
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) { setSynced(value); setText(value); } // o valor mudou por fora (ex.: outro controle)
  return (
    <div className="flex items-center gap-2">
      <input type="color" aria-label={label} value={isHex(value) ? value : placeholder && isHex(placeholder) ? placeholder : "#000000"} onChange={(e) => onChange(e.target.value)} className="w-9 h-9 rounded-lg border border-theme-card bg-transparent cursor-pointer p-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold">{label}</p>
        <input
          className={`${inputCls} py-1 font-mono text-xs`}
          value={text}
          placeholder={placeholder ?? "#rrggbb"}
          maxLength={7}
          onChange={(e) => { setText(e.target.value); if (isHex(e.target.value)) onChange(e.target.value.toLowerCase()); }}
          aria-label={t("appearance.hexLabel", { label })}
        />
      </div>
      {onClear && <MiniButton onClick={onClear} title={t("appearance.autoTitle")}>{t("appearance.auto")}</MiniButton>}
    </div>
  );
}

export function AppearanceSettings() {
  const { t } = useT();
  const ap = useAppearanceContext();
  const { theme, setTheme } = useTheme();
  const [draft, setDraft] = useState<Palette | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyFile, setBusyFile] = useState(false);

  const all = [...BUILTIN_PALETTES, ...ap.custom];
  const nameOf = (p: Palette) => (p.builtin ? t(`appearance.palette.${p.id}` as TKey) : p.name);
  const issues = draft ? contrastIssues(draft, ap.mode) : [];
  const isNew = !!draft && !ap.custom.some((c) => c.id === draft.id);

  function edit(p: Palette) { setDraft(p); ap.setPreview(p); setConfirmDelete(false); setMessage(null); }
  function patch(next: Partial<Palette>) { if (!draft) return; const d = { ...draft, ...next }; setDraft(d); ap.setPreview(d); }
  function setOverride(key: TokenKey, hex: string | null) {
    if (!draft) return;
    const mode = ap.mode;
    const cur = { ...(draft.overrides?.[mode] ?? {}) };
    if (hex) cur[key] = hex; else delete cur[key];
    const overrides = { ...(draft.overrides ?? {}), [mode]: cur };
    if (!Object.keys(cur).length) delete overrides[mode];
    patch({ overrides: Object.keys(overrides).length ? overrides : undefined });
  }
  function close() { ap.setPreview(null); setDraft(null); setConfirmDelete(false); }
  function save() { if (!draft?.name.trim()) return; ap.savePalette({ ...draft, name: draft.name.trim() }); close(); setMessage(t("appearance.msg.saved")); }
  function startNew(from?: Palette) {
    const base = from ?? ap.active;
    const baseName = from ? nameOf(from) : t("appearance.defaultName");
    edit({ id: newPaletteId(), name: from ? `${baseName} ${t("appearance.copySuffix")}` : baseName, accent: base.accent, hue: base.hue, tint: base.tint, overrides: base.overrides });
  }
  async function importFile() {
    setBusyFile(true);
    setMessage(null);
    const r = await importPaletteFromFile();
    setBusyFile(false);
    if (r.ok) { edit({ ...r.palette, id: newPaletteId() }); setMessage(t("appearance.msg.imported")); return; }
    if (r.reason === "invalid") setMessage(t("appearance.msg.notPalette"));
    else if (r.reason === "too-big") setMessage(t("appearance.msg.tooBig"));
    else if (r.reason === "error") setMessage(t("appearance.msg.openFailed"));
  }
  async function exportFile() {
    if (!draft) return;
    try {
      const r = await exportPaletteToFile({ ...draft, name: draft.name.trim() || t("appearance.defaultName") });
      if (r === "saved") setMessage(t("appearance.msg.exported"));
    } catch {
      setMessage(t("appearance.msg.exportFailed"));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-theme-secondary mb-2">{t("appearance.theme")}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-xl px-4 py-3">
          <p className="text-sm text-theme-secondary">{t("appearance.theme.hint")}</p>
          <div className="inline-flex bg-theme-card p-1 rounded-xl border border-theme-card" role="radiogroup" aria-label={t("appearance.theme")}>
            {([["light", t("appearance.theme.light"), Sun], ["dark", t("appearance.theme.dark"), Moon]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" role="radio" aria-checked={theme === id} onClick={() => setTheme(id)}
                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer", theme === id ? "bg-indigo-600 text-white" : "text-theme-secondary hover:text-theme-primary")}>
                <Icon className="w-3.5 h-3.5" />{label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-theme-secondary">{t("appearance.palettes")}</p>
          <div className="flex gap-2">
            <MiniButton onClick={importFile} disabled={busyFile || !!draft} title={t("appearance.import.title")}><Upload className="w-3.5 h-3.5" />{t("appearance.import")}</MiniButton>
            <MiniButton tone="primary" disabled={!ap.canAddMore || !!draft} onClick={() => startNew()}><Plus className="w-3.5 h-3.5" />{t("appearance.new")}</MiniButton>
          </div>
        </div>

        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3" role="radiogroup" aria-label={t("appearance.palettes")}>
          {all.map((p) => {
            const selected = ap.state.activeId === p.id && !draft;
            return (
              <li key={p.id} className="relative">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!!draft}
                  onClick={() => ap.select(p.id)}
                  className={cn("w-full text-left rounded-xl border p-2 space-y-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60", selected ? "border-indigo-500 ring-2 ring-indigo-500/30" : "border-theme-card hover:border-indigo-400")}
                >
                  <Swatch palette={p} mode={ap.mode} />
                  <span className="flex items-center justify-between gap-2 px-0.5">
                    <span className="text-xs font-bold truncate">{nameOf(p)}</span>
                    {selected && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                  </span>
                </button>
                {!p.builtin && !draft && (
                  <button type="button" onClick={() => edit(p)} title={t("appearance.edit", { name: p.name })} aria-label={t("appearance.edit", { name: p.name })} className="absolute top-3.5 right-3.5 p-1 rounded-md bg-black/40 text-white hover:bg-black/60 cursor-pointer"><Pencil className="w-3 h-3" /></button>
                )}
              </li>
            );
          })}
        </ul>
        {!ap.canAddMore && <p className="text-xs text-theme-secondary mt-2">{t("appearance.limit")}</p>}
        {message && <p className="text-xs text-indigo-600 font-bold mt-2" role="status">{message}</p>}
      </div>

      {draft && (
        <div className="rounded-2xl border border-indigo-500/40 bg-theme-accent p-4 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-bold">{isNew ? t("appearance.editor.new") : t("appearance.editor.edit")}</h3>
            <span className="text-[11px] text-theme-secondary">{t("appearance.editor.preview")}</span>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-bold">{t("appearance.name")}</span>
            <input className={inputCls} value={draft.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} />
          </label>

          <ColorField
            label={t("appearance.accent")}
            value={draft.overrides?.[ap.mode]?.accent ?? draft.accent}
            onChange={(hex) => patch({ accent: hex, overrides: draft.overrides && (Object.fromEntries(Object.entries(draft.overrides).map(([m, v]) => [m, { ...v, accent: undefined }])) as Palette["overrides"]) })}
          />

          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-xs font-bold">{t("appearance.background")}</span>
              <input type="range" min={0} max={359} value={draft.hue} onChange={(e) => patch({ hue: Number(e.target.value) })} aria-label={t("appearance.hue")}
                className="w-full h-2 rounded-full appearance-none cursor-pointer" style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-bold">{t("appearance.intensity")} <span className="font-normal text-theme-secondary">({draft.tint === 0 ? t("appearance.gray") : `${Math.round(draft.tint * 100)}%`})</span></span>
              <input type="range" min={0} max={100} value={Math.round(draft.tint * 100)} onChange={(e) => patch({ tint: Number(e.target.value) / 100 })} aria-label={t("appearance.tint")} className="w-full accent-indigo-600" />
            </label>
          </div>
          <div className="flex gap-2 flex-wrap">
            {[0, 30, 90, 150, 200, 260, 320].map((h) => (
              <button key={h} type="button" aria-label={`${t("appearance.hue")} ${h}`} onClick={() => patch({ hue: h })} className="w-6 h-6 rounded-full border border-black/20 cursor-pointer" style={{ background: hslToHex(h, 0.6, 0.45) }} />
            ))}
          </div>

          <div>
            <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-xs font-bold text-indigo-600 hover:underline cursor-pointer" aria-expanded={advanced}>
              {advanced ? t("appearance.advanced.hide") : t("appearance.advanced.show")}
            </button>
            {advanced && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-theme-secondary">{t("appearance.advanced.hint", { mode: ap.mode === "dark" ? t("appearance.mode.dark") : t("appearance.mode.light") })}</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  {(["background", "surface", "text", "accent"] as const).map((key) => (
                    <ColorField
                      key={key}
                      label={t(`appearance.override.${key}` as TKey)}
                      value={draft.overrides?.[ap.mode]?.[key] ?? (key === "accent" ? draft.accent : deriveTokens(draft, ap.mode)[key === "background" ? "--background" : key === "surface" ? "--card-bg" : "--text-primary"])}
                      onChange={(hex) => setOverride(key, hex)}
                      onClear={draft.overrides?.[ap.mode]?.[key] ? () => setOverride(key, null) : undefined}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {issues.length > 0 && (
            <ul className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-1" role="status">
              {issues.map((i) => (
                <li key={i.id} className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{t(`appearance.issue.${i.id}` as TKey)} <span className="opacity-70">{t("appearance.issue.contrast", { ratio: i.ratio, min: i.min })}</span></li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <MiniButton tone="primary" onClick={save} disabled={!draft.name.trim()}><Check className="w-3.5 h-3.5" />{t("appearance.save")}</MiniButton>
            <MiniButton onClick={close}>{t("appearance.cancel")}</MiniButton>
            <MiniButton onClick={exportFile}><FileDown className="w-3.5 h-3.5" />{t("appearance.export")}</MiniButton>
            {!isNew && (confirmDelete ? (
              <>
                <MiniButton onClick={() => setConfirmDelete(false)}>{t("appearance.deleteKeep")}</MiniButton>
                <MiniButton tone="danger" onClick={() => { ap.remove(draft.id); close(); }}><Trash2 className="w-3.5 h-3.5" />{t("appearance.deleteConfirm")}</MiniButton>
              </>
            ) : (
              <>
                <MiniButton onClick={() => startNew(draft)}><Copy className="w-3.5 h-3.5" />{t("appearance.duplicate")}</MiniButton>
                <MiniButton tone="danger" className="ml-auto" onClick={() => setConfirmDelete(true)}><Trash2 className="w-3.5 h-3.5" />{t("appearance.delete")}</MiniButton>
              </>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-theme-secondary">{t("appearance.statusColors")}</p>
    </div>
  );
}
