"use client";

import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PackageOpen, X, Loader2, AlertTriangle, CheckCircle2, FolderOpen, ShieldCheck } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/modSync";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import {
  packFileName,
  prepareExport,
  runPreflight,
  runExport,
  cancelPackJob,
  type PackMode,
  type PackPreflight,
  type PackUiProgress,
  type PreparedExport,
  type ExportOutcome,
} from "@/lib/cubicasePack";
import { useT } from "@/i18n";

// ============================================================
// ExportPackModal
// ============================================================
// Fluxo: escolher o modo (completo/leve) → escolher o arquivo de destino →
// verificação ANTES de escrever qualquer coisa (servidor desligado, espaço,
// caminho longo, destino gravável…) → exportar com progresso e cancelamento.
// Toda a lógica pesada e as travas ficam no backend (src-tauri/src/pack.rs);
// aqui só se conduz o usuário e se mostra o motivo de cada bloqueio.
// ============================================================

type Step = "options" | "checking" | "ready" | "running" | "done" | "error";

const PHASE_LABELS = {
  scanning: "pack.phase.scanning",
  writing: "pack.phase.writing",
  verifying: "pack.phase.verifying",
  done: "pack.phase.done",
} as const;

interface ExportPackModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverDir: string;
  serverName: string;
  serverType: string;
  mcVersion: string | null;
  isServerStopped: boolean;
}

function parentDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

function ExportPackModalBody({ onClose, serverDir, serverName, serverType, mcVersion, isServerStopped }: ExportPackModalProps) {
  const { t, rich } = useT();
  useLockBodyScroll(true);

  const [step, setStep] = useState<Step>("options");
  const [mode, setMode] = useState<PackMode>("full");
  const [includeLists, setIncludeLists] = useState(false);
  const [status, setStatus] = useState("");
  const [prepared, setPrepared] = useState<PreparedExport | null>(null);
  const [destPath, setDestPath] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PackPreflight | null>(null);
  const [progress, setProgress] = useState<PackUiProgress | null>(null);
  const [result, setResult] = useState<ExportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const busyRef = useRef(false);


  const canClose = step !== "checking" && step !== "running";

  const handleChooseDest = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    try {
      const fileName = packFileName(serverName);
      let selected = await save({
        title: t("pack.export.saveDialogTitle"),
        defaultPath: await join(await documentDir(), fileName),
        filters: [{ name: "Cubicase", extensions: ["cubicase"] }],
      });
      if (!selected) return;
      if (!selected.toLowerCase().endsWith(".cubicase")) selected = `${selected}.cubicase`;

      setStep("checking");
      setStatus(t("pack.export.checking"));
      const prep = await prepareExport({
        serverDir,
        serverName,
        serverType,
        mcVersion,
        mode,
        includePlayerLists: includeLists,
        onStatus: setStatus,
      });
      // O diálogo nativo já confirmou a substituição de um arquivo existente.
      const pf = await runPreflight({ ...prep.base, destPath: selected, overwrite: true });
      setPrepared(prep);
      setDestPath(selected);
      setPreflight(pf);
      setStep("ready");
    } catch (err) {
      console.error(err);
      setError(String(err instanceof Error ? err.message : err));
      setStep("error");
    } finally {
      busyRef.current = false;
    }
  };

  const handleRun = async () => {
    if (!prepared || !destPath || busyRef.current) return;
    busyRef.current = true;
    setStep("running");
    setProgress({ phase: "scanning", percent: 0, current: "", doneFiles: 0, totalFiles: 0 });
    setCancelling(false);
    try {
      const outcome = await runExport({ ...prepared.base, destPath, overwrite: true }, setProgress);
      setResult(outcome);
      setStep("done");
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

  const hasBlockingProblems = !!preflight && preflight.problems.length > 0;

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
                <h3 className="text-xl font-bold text-theme-primary">{t("pack.export.title")}</h3>
              </div>
              {canClose && (
                <button onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors">
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {step === "options" && (
              <div className="space-y-4">
                <p className="text-sm text-theme-secondary leading-relaxed">
                  {rich("pack.export.intro", { ext: <code className="text-xs bg-theme-muted px-1.5 py-0.5 rounded">.cubicase</code> })}
                </p>

                {!isServerStopped && (
                  <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {t("pack.export.stopFirst")}
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("pack.export.modeLabel")}</label>
                  {(["full", "light"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={cn(
                        "w-full text-left p-3.5 rounded-2xl border transition-colors cursor-pointer",
                        mode === m ? "bg-theme-accent border-indigo-400" : "bg-theme-muted border-theme-card hover:border-slate-300",
                      )}
                    >
                      <p className="text-sm font-bold text-theme-primary">{t(m === "full" ? "pack.mode.full" : "pack.mode.light")}</p>
                      <p className="text-xs text-theme-secondary mt-0.5 leading-relaxed">{t(m === "full" ? "pack.mode.fullDesc" : "pack.mode.lightDesc")}</p>
                    </button>
                  ))}
                </div>

                {mode === "light" && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>{t("pack.mode.lightNote")}</span>
                  </div>
                )}

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeLists}
                    onChange={(e) => setIncludeLists(e.target.checked)}
                    className="mt-0.5 accent-indigo-600"
                  />
                  <span>
                    <span className="text-sm font-semibold text-theme-primary block">{t("pack.export.playerLists")}</span>
                    <span className="text-[11px] text-theme-secondary">{t("pack.export.playerListsHint")}</span>
                  </span>
                </label>

                <p className="text-[11px] text-theme-secondary flex items-start gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-px" />
                  {t("pack.export.neverIncluded")}
                </p>

                <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
                  <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={handleChooseDest}
                    disabled={!isServerStopped}
                    className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 cursor-pointer"
                  >
                    {t("pack.export.chooseDest")}
                  </button>
                </div>
              </div>
            )}

            {step === "checking" && (
              <div className="py-10 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                <span className="text-sm font-semibold text-theme-secondary text-center">{status}</span>
              </div>
            )}

            {step === "ready" && preflight && prepared && (
              <div className="space-y-4">
                {hasBlockingProblems ? (
                  <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl space-y-2">
                    <p className="text-sm font-bold flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" /> {t("pack.export.problemsTitle")}
                    </p>
                    <ul className="list-disc pl-5 space-y-1.5 text-xs leading-relaxed">
                      {preflight.problems.map((p) => (
                        <li key={p.code + p.message}>{p.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="p-4 bg-theme-accent border border-theme-accent rounded-xl space-y-1.5">
                    <p className="text-sm font-bold text-theme-primary break-all">{destPath}</p>
                    <p className="text-xs text-theme-secondary">
                      {t("pack.export.summary", { files: preflight.fileCount, size: formatBytes(preflight.totalBytes) })}
                    </p>
                    {preflight.freeBytes !== null && (
                      <p className="text-[11px] text-theme-secondary">
                        {t("pack.export.space", { free: formatBytes(preflight.freeBytes), need: formatBytes(preflight.requiredBytes) })}
                      </p>
                    )}
                  </div>
                )}

                {mode === "light" && prepared.omittedModCount > 0 && (
                  <p className="text-xs text-theme-secondary">{t("pack.export.omittedSummary", { count: prepared.omittedModCount })}</p>
                )}
                {mode === "light" && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>{t("pack.mode.lightNote")}</span>
                  </div>
                )}
                {mode === "light" && prepared.modsUnidentified && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>{t("pack.export.unidentified")}</span>
                  </div>
                )}
                {!preflight.hasWorld && !hasBlockingProblems && <p className="text-xs text-amber-700 dark:text-amber-300">{t("pack.export.noWorld")}</p>}
                {preflight.skippedLinks > 0 && <p className="text-xs text-theme-secondary">{t("pack.export.linksSkipped", { count: preflight.skippedLinks })}</p>}

                <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
                  <button type="button" onClick={() => setStep("options")} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                    {t("pack.import.back")}
                  </button>
                  {hasBlockingProblems ? (
                    <button type="button" onClick={handleChooseDest} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
                      {t("pack.export.retry")}
                    </button>
                  ) : (
                    <button type="button" onClick={handleRun} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
                      {t("pack.export.run")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {step === "running" && progress && (
              <div className="py-6 space-y-4">
                <div className="flex items-center justify-center gap-3">
                  <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                  <span className="font-bold text-theme-primary text-sm">{t(PHASE_LABELS[progress.phase as keyof typeof PHASE_LABELS] ?? "pack.export.running")}</span>
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
                <p className="text-[11px] text-theme-secondary text-center italic">{t("pack.export.doNotStart")}</p>
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
              </div>
            )}

            {step === "done" && result && (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-2 py-4 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500" />
                  <p className="text-lg font-bold text-theme-primary">{t("pack.export.done")}</p>
                  <p className="text-xs text-theme-secondary break-all">{result.destPath}</p>
                  <p className="text-xs text-theme-secondary">{t("pack.export.doneDetail", { size: formatBytes(result.sizeBytes), files: result.fileCount })}</p>
                </div>
                <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
                  <button
                    type="button"
                    onClick={() => invoke("open_path_in_explorer", { path: parentDirOf(result.destPath) }).catch(() => {})}
                    className="px-5 h-12 rounded-2xl text-indigo-600 hover:bg-theme-accent transition-colors text-sm font-semibold flex items-center gap-2 cursor-pointer"
                  >
                    <FolderOpen className="w-4 h-4" /> {t("pack.export.openFolder")}
                  </button>
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
                  <button type="button" onClick={() => setStep("options")} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
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
export function ExportPackModal(props: ExportPackModalProps) {
  return <AnimatePresence>{props.isOpen && <ExportPackModalBody key="open" {...props} />}</AnimatePresence>;
}
