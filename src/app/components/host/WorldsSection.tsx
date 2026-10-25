"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe2, Loader2, AlertTriangle, CheckCircle2, X, FolderInput, Plus, CheckCircle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/modSync";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useT, getLocale } from "@/i18n";
import {
  createNewWorld,
  importWorldZip,
  inspectWorldZip,
  listWorlds,
  setActiveWorld,
  uniqueWorldName,
  worldIsNewerThanServer,
  worldNameProblem,
  type WorldInfo,
  type WorldZipInfo,
} from "@/lib/worlds";

// ============================================================
// WorldsSection — mundos do servidor (usar, novo, importar .zip)
// ============================================================
// Trocar de mundo só muda o `level-name`; nada é apagado. Importar copia o zip para uma pasta NOVA. As
// defesas (zip-slip, limites, nunca sobrescrever) ficam no backend (src-tauri/src/worlds.rs).
// ============================================================

interface Props {
  serverDir: string;
  /** Versão do Minecraft do servidor (para avisar de mundos mais novos). */
  mcVersion: string | null;
  isServerStopped: boolean;
  /** Avisa que o mundo ativo mudou (backups, datapacks etc. dependem dele). */
  onWorldChanged?: () => void;
}

function formatPlayed(ms: number | null): string | null {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleDateString(getLocale(), { dateStyle: "medium" });
  } catch {
    return null;
  }
}

const errText = (err: unknown) => (typeof err === "string" ? err : err instanceof Error ? err.message : String(err));

export function WorldsSection({ serverDir, mcVersion, isServerStopped, onWorldChanged }: Props) {
  const { t } = useT();
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const reload = useCallback(async () => {
    try {
      setWorlds(await listWorlds(serverDir));
    } catch (err) {
      setWorlds([]);
      setNotice({ kind: "error", text: errText(err) });
    }
  }, [serverDir]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleUse = async (w: WorldInfo) => {
    setBusy(w.folder);
    setNotice(null);
    try {
      await setActiveWorld(serverDir, w.folder);
      await reload();
      onWorldChanged?.();
      setNotice({ kind: "ok", text: t("worlds.switched", { name: w.folder }) });
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-bold text-theme-primary flex items-center gap-2"><Globe2 className="w-4 h-4 text-indigo-600" /> {t("worlds.title")}</h3>
          <p className="text-[11px] text-theme-secondary mt-0.5 max-w-md leading-relaxed">{t("worlds.hint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowNew(true)}
            disabled={!isServerStopped}
            title={isServerStopped ? undefined : t("worlds.stopFirst")}
            className="h-9 px-4 bg-theme-muted hover:bg-theme-card border border-theme-card text-indigo-600 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> {t("worlds.new")}
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            disabled={!isServerStopped}
            title={isServerStopped ? undefined : t("worlds.stopFirst")}
            className="h-9 px-4 bg-theme-muted hover:bg-theme-card border border-theme-card text-indigo-600 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
          >
            <FolderInput className="w-3.5 h-3.5" /> {t("worlds.import")}
          </button>
        </div>
      </div>

      {notice && (
        <div className={cn("p-3 rounded-xl text-xs flex items-start gap-2 leading-relaxed", notice.kind === "ok" ? "bg-theme-accent border border-theme-accent text-theme-primary" : "bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200")}>
          {notice.kind === "ok" ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-px" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" />}
          <span>{notice.text}</span>
        </div>
      )}

      {worlds === null && (
        <div className="py-4 flex items-center justify-center gap-2 text-xs text-theme-secondary"><Loader2 className="w-4 h-4 animate-spin" /> {t("worlds.loading")}</div>
      )}
      {worlds && worlds.length === 0 && <p className="text-xs text-theme-secondary py-3 text-center">{t("worlds.empty")}</p>}

      {worlds && worlds.length > 0 && (
        <div className="space-y-2">
          {worlds.map((w) => {
            const newer = worldIsNewerThanServer(w.mcVersion, mcVersion);
            const played = formatPlayed(w.lastPlayedMs);
            return (
              <div key={w.folder} className={cn("flex items-center justify-between gap-3 border rounded-2xl px-4 py-3", w.isActive ? "bg-theme-accent border-indigo-300 dark:border-indigo-700" : "bg-theme-muted border-theme-card")}>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-theme-primary truncate">{w.folder}</p>
                    {w.isActive && (
                      <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> {t("worlds.badge.active")}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-theme-secondary">
                    {w.mcVersion ? t("worlds.version", { v: w.mcVersion }) : t("worlds.versionUnknown")}
                    {played ? ` · ${t("worlds.lastPlayed", { date: played })}` : ""}
                  </p>
                  {newer && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5 leading-relaxed pt-0.5">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {t("worlds.newerBlocked", { world: w.mcVersion ?? "", server: mcVersion ?? "" })}
                    </p>
                  )}
                </div>
                {!w.isActive && (
                  <button
                    type="button"
                    onClick={() => handleUse(w)}
                    disabled={!isServerStopped || newer || busy !== null}
                    title={isServerStopped ? undefined : t("worlds.stopFirst")}
                    className="h-9 px-4 flex-shrink-0 bg-theme-card hover:bg-theme-accent border border-theme-card text-indigo-600 rounded-xl text-xs font-bold transition-all active:scale-95 disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
                  >
                    {busy === w.folder && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t("worlds.use")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AnimatePresence>
        {showNew && (
          <NewWorldDialog
            key="new"
            serverDir={serverDir}
            taken={(worlds ?? []).map((w) => w.folder)}
            onClose={() => setShowNew(false)}
            onCreated={async (name) => {
              setShowNew(false);
              await reload();
              onWorldChanged?.();
              setNotice({ kind: "ok", text: t("worlds.switched", { name }) });
            }}
          />
        )}
        {showImport && (
          <ImportWorldDialog
            key="import"
            serverDir={serverDir}
            serverVersion={mcVersion}
            taken={(worlds ?? []).map((w) => w.folder)}
            onClose={() => setShowImport(false)}
            onImported={async (switched) => {
              await reload();
              if (switched) onWorldChanged?.();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------
// Estrutura comum dos diálogos
// ------------------------------------------------------------

function DialogShell({ title, canClose, onClose, children }: { title: string; canClose: boolean; onClose: () => void; children: React.ReactNode }) {
  useLockBodyScroll(true);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { if (canClose) onClose(); }} className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ type: "spring", duration: 0.4 }}
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-5"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold text-theme-primary">{title}</h3>
          {canClose && (
            <button onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors"><X className="w-5 h-5" /></button>
          )}
        </div>
        {children}
      </motion.div>
    </div>
  );
}

const inputClass = "w-full h-11 px-3 rounded-xl bg-theme-muted border border-theme-card text-sm text-theme-primary focus:outline-none focus:border-indigo-400";
const primaryBtn = "px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 cursor-pointer";
const ghostBtn = "px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold";

function nameMessage(name: string, taken: string[], t: ReturnType<typeof useT>["t"]): string | null {
  const problem = worldNameProblem(name);
  if (problem === "invalid") return t("worlds.name.invalid");
  if (!problem && taken.some((n) => n.toLowerCase() === name.trim().toLowerCase())) return t("worlds.name.exists");
  return null;
}

// ------------------------------------------------------------
// Novo mundo
// ------------------------------------------------------------

function NewWorldDialog({ serverDir, taken, onClose, onCreated }: { serverDir: string; taken: string[]; onClose: () => void; onCreated: (name: string) => void }) {
  const { t } = useT();
  const [name, setName] = useState(() => uniqueWorldName("Novo mundo", taken));
  const [seed, setSeed] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const message = nameMessage(name, taken, t);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      await createNewWorld(serverDir, name.trim(), seed.trim() || null);
      onCreated(name.trim());
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };

  return (
    <DialogShell title={t("worlds.new.title")} canClose={!saving} onClose={onClose}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("worlds.new.name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className={inputClass} />
          {message && <p className="text-[11px] text-rose-600 dark:text-rose-300">{message}</p>}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("worlds.new.seed")}</label>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} maxLength={64} className={inputClass} />
          <p className="text-[11px] text-theme-secondary">{t("worlds.new.seedHint")}</p>
        </div>
        <p className="text-xs text-theme-secondary leading-relaxed p-3 bg-theme-muted border border-theme-card rounded-xl">{t("worlds.new.info")}</p>
        {error && <p className="text-xs text-rose-600 dark:text-rose-300 flex items-start gap-2"><AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}</p>}
        <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
          <button type="button" onClick={onClose} disabled={saving} className={ghostBtn}>{t("worlds.cancel")}</button>
          <button type="button" onClick={create} disabled={saving || !!message || !name.trim()} className={primaryBtn}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t("worlds.new.create")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

// ------------------------------------------------------------
// Importar mundo (.zip)
// ------------------------------------------------------------

type ImportStep = "pick" | "reading" | "options" | "running" | "done" | "error";

function ImportWorldDialog({ serverDir, serverVersion, taken, onClose, onImported }: { serverDir: string; serverVersion: string | null; taken: string[]; onClose: () => void; onImported: (switched: boolean) => void }) {
  const { t } = useT();
  const [step, setStep] = useState<ImportStep>("pick");
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [info, setInfo] = useState<WorldZipInfo | null>(null);
  const [name, setName] = useState("");
  const [useNow, setUseNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; switched: boolean } | null>(null);
  const busyRef = useRef(false);

  const newer = worldIsNewerThanServer(info?.mcVersion ?? null, serverVersion);
  const message = nameMessage(name, taken, t);

  const pick = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const selected = await openDialog({ multiple: false, directory: false, title: t("worlds.import.dialogTitle"), filters: [{ name: "ZIP", extensions: ["zip"] }] });
      if (!selected || typeof selected !== "string") return;
      setZipPath(selected);
      setStep("reading");
      const i = await inspectWorldZip(selected);
      setInfo(i);
      setName(uniqueWorldName(i.suggestedName, taken));
      setUseNow(!worldIsNewerThanServer(i.mcVersion, serverVersion));
      setStep("options");
    } catch (err) {
      setError(errText(err));
      setStep("error");
    } finally {
      busyRef.current = false;
    }
  };

  const run = async () => {
    if (!zipPath || busyRef.current) return;
    busyRef.current = true;
    setStep("running");
    try {
      const folder = (await importWorldZip(serverDir, zipPath, name.trim())).folder;
      let switched = false;
      if (useNow && !newer) {
        await setActiveWorld(serverDir, folder);
        switched = true;
      }
      setResult({ name: folder, switched });
      setStep("done");
      onImported(switched);
    } catch (err) {
      setError(errText(err));
      setStep("error");
    } finally {
      busyRef.current = false;
    }
  };

  const canClose = step !== "running" && step !== "reading";

  return (
    <DialogShell title={t("worlds.import.title")} canClose={canClose} onClose={onClose}>
      {step === "pick" && (
        <div className="space-y-4">
          <p className="text-sm text-theme-secondary leading-relaxed">{t("worlds.import.intro")}</p>
          <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
            <button type="button" onClick={onClose} className={ghostBtn}>{t("worlds.cancel")}</button>
            <button type="button" onClick={pick} className={primaryBtn}>{t("worlds.import.choose")}</button>
          </div>
        </div>
      )}

      {step === "reading" && (
        <div className="py-8 flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
          <span className="text-sm font-semibold text-theme-secondary">{t("worlds.import.reading")}</span>
        </div>
      )}

      {step === "options" && info && (
        <div className="space-y-4">
          <div className="p-3.5 bg-theme-accent border border-theme-accent rounded-xl space-y-1">
            <p className="text-[11px] font-bold uppercase tracking-wide text-theme-secondary">{t("worlds.import.found")}</p>
            <p className="text-sm font-bold text-theme-primary break-all">{info.levelName ?? info.suggestedName}</p>
            <p className="text-xs text-theme-secondary">
              {info.mcVersion
                ? t("worlds.import.details", { v: info.mcVersion, files: info.fileCount, size: formatBytes(info.unpackedBytes) })
                : t("worlds.import.detailsNoVersion", { files: info.fileCount, size: formatBytes(info.unpackedBytes) })}
            </p>
            {(info.hasNetherFolder || info.hasEndFolder) && <p className="text-[11px] text-theme-secondary">{t("worlds.import.dims")}</p>}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("worlds.import.name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className={inputClass} />
            {message && <p className="text-[11px] text-rose-600 dark:text-rose-300">{message}</p>}
          </div>

          {newer ? (
            <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2 leading-relaxed">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" /> {t("worlds.import.useNowNewer", { world: info.mcVersion ?? "", server: serverVersion ?? "" })}
            </p>
          ) : (
            <label className="flex items-start gap-2.5 cursor-pointer p-3 bg-theme-muted border border-theme-card rounded-2xl">
              <input type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} className="mt-0.5 accent-indigo-600" />
              <span>
                <span className="text-sm font-semibold text-theme-primary block">{t("worlds.import.useNow")}</span>
                <span className="text-[11px] text-theme-secondary">{t("worlds.import.useNowHint")}</span>
              </span>
            </label>
          )}

          <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
            <button type="button" onClick={() => setStep("pick")} className={ghostBtn}>{t("worlds.back")}</button>
            <button type="button" onClick={run} disabled={!!message || !name.trim()} className={primaryBtn}>{t("worlds.import.run")}</button>
          </div>
        </div>
      )}

      {step === "running" && (
        <div className="py-8 flex flex-col items-center gap-3 text-center">
          <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
          <span className="text-sm font-semibold text-theme-secondary">{t("worlds.import.running")}</span>
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2 py-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-lg font-bold text-theme-primary">{t("worlds.import.done")}</p>
            <p className="text-xs text-theme-secondary leading-relaxed">{result.switched ? t("worlds.import.doneUse", { name: result.name }) : t("worlds.import.doneKeep", { name: result.name })}</p>
          </div>
          <div className="flex justify-end pt-3 border-t border-theme-card">
            <button type="button" onClick={onClose} className={primaryBtn}>{t("worlds.close")}</button>
          </div>
        </div>
      )}

      {step === "error" && (
        <div className="space-y-4">
          <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs leading-relaxed flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{error}</span>
          </div>
          <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
            <button type="button" onClick={onClose} className={ghostBtn}>{t("worlds.close")}</button>
            <button type="button" onClick={() => { setError(null); setStep("pick"); }} className={primaryBtn}>{t("worlds.back")}</button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}
