"use client";

import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PackageOpen, X, Loader2, AlertTriangle, CheckCircle2, FileArchive, ShieldAlert } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { formatBytes } from "@/lib/modSync";
import {
  inspectPack,
  importPackWithProgress,
  cancelPackJob,
  getServersRoot,
  uniqueServerName,
  type PackInspection,
  type PackUiProgress,
  type ImportPackResult,
} from "@/lib/cubicasePack";
import { getJavaVersion } from "@/lib/server";
import { useT } from "@/i18n";

// ============================================================
// ImportPackModal
// ============================================================
// Fluxo: escolher o .cubicase → ler e validar o pacote (o backend rejeita
// caminhos inseguros, manifesto divergente, versão futura etc. ANTES de
// extrair qualquer coisa) → confirmar nome → importar com progresso →
// relatório final (Java/mods: o que veio, o que foi baixado, o que ficou pendente).
// ============================================================

type Step = "pick" | "reading" | "confirm" | "running" | "done" | "error";

// Limite de caracteres do caminho final (mesmo valor de MAX_PATH_CHARS em pack.rs).
const MAX_PATH_CHARS = 240;

const PHASE_LABELS = {
  reading: "pack.phase.reading",
  extracting: "pack.phase.extracting",
  finalizing: "pack.phase.finalizing",
  downloadingMods: "pack.phase.downloadingMods",
  installingJre: "pack.phase.installingJre",
  done: "pack.phase.done",
} as const;

interface ImportPackModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingNames: string[];
  /** Chamado assim que o servidor foi importado (atualiza a lista e seleciona o novo). */
  onImported: (name: string) => Promise<void> | void;
}

function ImportPackModalBody({ onClose, existingNames, onImported }: ImportPackModalProps) {
  const { t, rich } = useT();
  useLockBodyScroll(true);

  const [step, setStep] = useState<Step>("pick");
  const [packPath, setPackPath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PackInspection | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameMax, setNameMax] = useState(64);
  const [progress, setProgress] = useState<PackUiProgress | null>(null);
  const [result, setResult] = useState<ImportPackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const busyRef = useRef(false);


  const canClose = step !== "reading" && step !== "running";

  const handlePick = async () => {
    if (busyRef.current) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Cubicase", extensions: ["cubicase"] }],
      title: t("pack.import.dialogTitle"),
    });
    if (!selected || Array.isArray(selected)) return;

    busyRef.current = true;
    setStep("reading");
    setPickError(null);
    try {
      const info = await inspectPack(selected);
      const root = await getServersRoot();
      setPackPath(selected);
      setInspection(info);
      setName(uniqueServerName(info.manifest.name, existingNames));
      setNameMax(Math.max(1, MAX_PATH_CHARS - (root.length + 2 + info.longestPath)));
      setStep("confirm");
    } catch (err) {
      console.error(err);
      setPickError(String(err instanceof Error ? err.message : err));
      setStep("pick");
    } finally {
      busyRef.current = false;
    }
  };

  const nameTaken = existingNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());
  const nameTooLong = name.trim().length > nameMax;
  const nameInvalid = !name.trim() || nameTaken || nameTooLong;

  const handleImport = async () => {
    if (!packPath || !inspection || nameInvalid || busyRef.current) return;
    busyRef.current = true;
    setStep("running");
    setProgress({ phase: "reading", percent: 0, current: "", doneFiles: 0, totalFiles: 0 });
    setCancelling(false);
    try {
      const res = await importPackWithProgress({
        packPath,
        folderName: name.trim(),
        manifest: inspection.manifest,
        onProgress: setProgress,
      });
      setResult(res);
      setStep("done");
      await onImported(res.name);
    } catch (err) {
      console.error(err);
      setError(String(err instanceof Error ? err.message : err));
      setStep("error");
    } finally {
      busyRef.current = false;
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    await cancelPackJob();
  };

  const manifest = inspection?.manifest;
  const downloadItems: string[] = [];
  if (manifest && manifest.mode === "light") {
    if (!manifest.includesJre) {
      downloadItems.push(t("pack.import.jreItem", { java: manifest.javaVersion ?? getJavaVersion(manifest.meta?.version || "1.20.1") }));
    }
    if (manifest.omittedMods.length > 0) {
      downloadItems.push(t("pack.import.modsItem", { count: manifest.omittedMods.length }));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { if (canClose) onClose(); }}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-5"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center">
                  <PackageOpen className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                </div>
                <h3 className="text-xl font-bold text-theme-primary">{t("pack.import.title")}</h3>
              </div>
              {canClose && (
                <button onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors">
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {step === "pick" && (
              <div className="space-y-4">
                <p className="text-sm text-theme-secondary leading-relaxed">
                  {rich("pack.import.intro", { ext: <code className="text-xs bg-theme-muted px-1.5 py-0.5 rounded">.cubicase</code> })}
                </p>
                {pickError && (
                  <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{pickError}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handlePick}
                  className="w-full h-32 border-2 border-dashed border-theme-card rounded-2xl flex flex-col items-center justify-center gap-2 text-theme-secondary hover:border-indigo-400 hover:text-indigo-600 transition-colors cursor-pointer"
                >
                  <FileArchive className="w-8 h-8" />
                  <span className="text-sm font-semibold">{t("pack.import.pickButton")}</span>
                </button>
                <div className="flex justify-end pt-2 border-t border-theme-card">
                  <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}

            {step === "reading" && (
              <div className="py-10 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                <span className="text-sm font-semibold text-theme-secondary">{t("pack.import.reading")}</span>
              </div>
            )}

            {step === "confirm" && manifest && inspection && (
              <div className="space-y-4">
                <div className="p-4 bg-theme-accent border border-theme-accent rounded-xl space-y-1">
                  <p className="text-sm font-bold text-theme-primary">{manifest.name}</p>
                  <p className="text-xs text-theme-secondary">
                    {t("pack.import.summary", {
                      mc: manifest.meta?.version ?? "?",
                      type: manifest.meta?.serverType ?? "vanilla",
                      files: inspection.fileCount,
                      size: formatBytes(inspection.totalBytes),
                    })}
                  </p>
                  <p className="text-xs font-semibold text-theme-primary">
                    {manifest.mode === "full" ? t("pack.import.modeFull") : t("pack.import.modeLight")}
                  </p>
                  {manifest.includesJre && manifest.javaVersion && (
                    <p className="text-[11px] text-theme-secondary">{t("pack.import.jreBundled", { java: manifest.javaVersion })}</p>
                  )}
                </div>

                {downloadItems.length > 0 && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>
                      {t("pack.import.needsDownload", { items: downloadItems.join(", ") })}
                      <br />
                      {t("pack.mode.lightNote")}
                    </span>
                  </div>
                )}

                <div className="p-3 bg-theme-muted border border-theme-card text-theme-secondary text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                  <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <span>{t("pack.import.trustWarning")}</span>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("pack.import.serverName")}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                  />
                  <p className="text-[11px] text-theme-secondary">{t("pack.import.nameHint", { max: nameMax })}</p>
                  {nameTaken && <p className="text-[11px] font-semibold text-rose-600">{t("pack.import.nameTaken")}</p>}
                </div>

                <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
                  <button type="button" onClick={() => setStep("pick")} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                    {t("pack.import.back")}
                  </button>
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={nameInvalid}
                    className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 cursor-pointer"
                  >
                    {t("pack.import.run")}
                  </button>
                </div>
              </div>
            )}

            {step === "running" && progress && (
              <div className="py-6 space-y-4">
                <div className="flex items-center justify-center gap-3">
                  <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                  <span className="font-bold text-theme-primary text-sm">{t(PHASE_LABELS[progress.phase as keyof typeof PHASE_LABELS] ?? "pack.import.running")}</span>
                </div>
                <div className="space-y-2">
                  <div className="w-full h-3 bg-theme-muted rounded-full overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${progress.percent}%` }} className="h-full bg-indigo-600 rounded-full" />
                  </div>
                  <div className="flex justify-between text-[10px] font-bold text-theme-secondary">
                    <span className="truncate max-w-[75%]" title={progress.current}>{progress.current}</span>
                    <span>{progress.percent}%</span>
                  </div>
                </div>
                {(progress.phase === "reading" || progress.phase === "extracting") && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={cancelling}
                      className="px-5 h-10 rounded-2xl text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors text-sm font-semibold disabled:opacity-50 cursor-pointer"
                    >
                      {cancelling ? t("pack.cancelling") : t("pack.cancel")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {step === "done" && result && (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-2 py-3 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500" />
                  <p className="text-lg font-bold text-theme-primary">{t("pack.import.done")}</p>
                  <p className="text-xs text-theme-secondary">{t("pack.import.doneServer", { name: result.name })}</p>
                </div>
                <ul className="text-xs text-theme-secondary space-y-1.5 leading-relaxed">
                  <li>
                    {result.jre === "included" && t("pack.import.jreIncluded")}
                    {result.jre === "present" && t("pack.import.jrePresent")}
                    {result.jre === "downloaded" && t("pack.import.jreDownloaded")}
                    {result.jre === "pending" && t("pack.import.jrePending")}
                    {result.jreWarning && <span className="block text-amber-700 dark:text-amber-300">{result.jreWarning}</span>}
                  </li>
                  {result.modsOmitted > 0 && (
                    <li>{t("pack.import.modsDownloaded", { done: result.modsDownloaded, total: result.modsOmitted })}</li>
                  )}
                </ul>
                {result.modsPending > 0 && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>{t("pack.import.modsPending", { count: result.modsPending })}</span>
                  </div>
                )}
                <div className="flex justify-end pt-3 border-t border-theme-card">
                  <button type="button" onClick={onClose} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
                    {t("pack.export.close")}
                  </button>
                </div>
              </div>
            )}

            {step === "error" && (
              <div className="space-y-4">
                <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs leading-relaxed flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
                <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
                  <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                    {t("pack.export.close")}
                  </button>
                  <button type="button" onClick={() => setStep(inspection ? "confirm" : "pick")} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
                    {t("pack.export.retry")}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
    </div>
  );
}

/**
 * Wrapper: o corpo só existe enquanto o modal está aberto, então todo o estado
 * (passo, arquivo escolhido, progresso…) recomeça do zero a cada abertura — sem
 * precisar de um efeito que zere os estados ao fechar.
 */
export function ImportPackModal(props: ImportPackModalProps) {
  return <AnimatePresence>{props.isOpen && <ImportPackModalBody key="open" {...props} />}</AnimatePresence>;
}
