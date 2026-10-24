"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUpCircle, X, Loader2, AlertTriangle, CheckCircle2, ShieldCheck, ChevronDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/modSync";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { getBackupsDir, type ServerInfo } from "@/lib/server";
import {
  ROLLBACK_FAILED_MARK,
  TYPE_LABELS,
  analyzeMods,
  installedLoaderVersion,
  loadUpgradeOptions,
  modsFolderFor,
  resolveLoaderTarget,
  runServerUpgrade,
  summarizeModPlan,
  type LoaderTarget,
  type ModPlan,
  type UpgradableType,
  type UpgradeOptions,
  type UpgradeOutcome,
  type UpgradeProgress,
} from "@/lib/serverUpgrade";
import { useT } from "@/i18n";

// ============================================================
// ServerUpgradeWizard — assistente de atualização de versão
// ============================================================
// Passos: escolher (build nova do loader × versão nova do Minecraft) → conferir os mods/plugins → confirmar
// (com o backup completo opcional) → executar → resultado. Toda a lógica e as travas ficam em
// src/lib/serverUpgrade.ts e no backend (src-tauri/src/upgrade.rs); aqui só se conduz a pessoa e se explica,
// em linguagem simples, o que vai acontecer — e que, se algo falhar, o servidor fica como estava.
// ============================================================

type Step = "choose" | "mods" | "confirm" | "running" | "done" | "error";

interface WizardProps {
  isOpen: boolean;
  onClose: () => void;
  serverInfo: ServerInfo;
  isServerStopped: boolean;
  /** Chamado depois de uma atualização concluída (a lista de servidores precisa ser relida). */
  onUpgraded: (target: LoaderTarget) => void;
}

interface BackupEstimate {
  bytes: number;
  freeBytes: number | null;
}

function currentLabel(info: ServerInfo): string {
  const type = info.serverType as UpgradableType;
  const name = TYPE_LABELS[type] ?? info.serverType;
  const loader = installedLoaderVersion(info);
  const mc = info.version ?? "";
  if (type === "vanilla" || !loader) return `${name} ${mc}`;
  return type === "paper" ? `${name} ${mc} (build ${loader})` : `${name} ${mc} (${loader})`;
}

function WizardBody({ onClose, serverInfo, isServerStopped, onUpgraded }: WizardProps) {
  const { t } = useT();
  useLockBodyScroll(true);

  const type = serverInfo.serverType as UpgradableType;
  const itemsFolder = modsFolderFor(type);
  const itemsLabel = itemsFolder === "plugins" ? "plugins" : "mods";

  const [step, setStep] = useState<Step>("choose");
  const [options, setOptions] = useState<UpgradeOptions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [choice, setChoice] = useState<"same" | "newer">("same");
  const [pickedVersion, setPickedVersion] = useState<string>("");
  const [target, setTarget] = useState<LoaderTarget | null>(null);
  const [resolving, setResolving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const [modPlan, setModPlan] = useState<ModPlan | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [disableIncompatible, setDisableIncompatible] = useState(true);

  const [fullBackup, setFullBackup] = useState(true);
  const [estimate, setEstimate] = useState<BackupEstimate | null>(null);

  const [progress, setProgress] = useState<UpgradeProgress | null>(null);
  const [outcome, setOutcome] = useState<UpgradeOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** O desfazer automático não conseguiu voltar tudo: aí NÃO se pode dizer que o servidor está intacto. */
  const [partial, setPartial] = useState(false);
  const busyRef = useRef(false);

  const canClose = step !== "running";

  // Procura as opções ao abrir.
  useEffect(() => {
    let cancelled = false;
    loadUpgradeOptions(serverInfo)
      .then((o) => {
        if (cancelled) return;
        setOptions(o);
        if (!o.sameVersion && o.newerVersions.length > 0) setChoice("newer");
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [serverInfo]);

  // Ao escolher "versão nova" (ou trocar a versão), confere se o loader existe para ela.
  useEffect(() => {
    if (choice !== "newer" || !pickedVersion) return;
    let cancelled = false;
    setResolving(true);
    setUnavailable(false);
    setTarget(null);
    resolveLoaderTarget(type, pickedVersion)
      .then((tg) => {
        if (cancelled) return;
        setTarget(tg);
        setUnavailable(!tg);
      })
      .catch(() => { if (!cancelled) setUnavailable(true); })
      .finally(() => { if (!cancelled) setResolving(false); });
    return () => { cancelled = true; };
  }, [choice, pickedVersion, type]);

  const chosenTarget: LoaderTarget | null = choice === "same" ? options?.sameVersion ?? null : target;
  const changesMinecraft = choice === "newer";
  const nothingToDo = !!options && !options.sameVersion && options.newerVersions.length === 0;

  const goNextFromChoose = async () => {
    if (!chosenTarget) return;
    // Só ao mudar o Minecraft os mods/plugins precisam ser conferidos (numa build nova do mesmo Minecraft eles seguem valendo).
    if (changesMinecraft && itemsFolder) {
      setStep("mods");
      setAnalyzing(true);
      setModPlan(null);
      try {
        const plan = await analyzeMods(serverInfo, chosenTarget);
        setModPlan(plan);
        setDisableIncompatible(true);
      } catch {
        setModPlan({ folder: itemsFolder, items: [], extras: [], missingDeps: [], analysisFailed: true });
      } finally {
        setAnalyzing(false);
      }
    } else {
      setModPlan(null);
      await goToConfirm();
    }
  };

  const goToConfirm = async () => {
    setStep("confirm");
    setEstimate(null);
    try {
      const backupsDir = await getBackupsDir(serverInfo.name);
      const e = await invoke<{ bytes: number; freeBytes: number | null }>("estimate_server_backup", { serverDir: serverInfo.path, backupsDir });
      setEstimate({ bytes: e.bytes, freeBytes: e.freeBytes });
    } catch {
      setEstimate(null);
    }
  };

  const lowSpace = !!estimate && estimate.freeBytes !== null && estimate.freeBytes < estimate.bytes * 1.1;

  const handleRun = async () => {
    if (busyRef.current || !chosenTarget) return;
    busyRef.current = true;
    setError(null);
    setProgress({ step: "prepare", percent: 2, message: t("upgrade.step.prepare") });
    setStep("running");
    try {
      const out = await runServerUpgrade(
        { info: serverInfo, target: chosenTarget, modPlan: changesMinecraft ? modPlan : null, disableIncompatible, fullBackup },
        setProgress
      );
      setOutcome(out);
      setStep("done");
      onUpgraded(chosenTarget);
    } catch (err) {
      const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      const isPartial = raw.startsWith(ROLLBACK_FAILED_MARK);
      setPartial(isPartial);
      setError(isPartial ? raw.slice(ROLLBACK_FAILED_MARK.length) : raw);
      setStep("error");
    } finally {
      busyRef.current = false;
    }
  };

  const summary = summarizeModPlan(changesMinecraft ? modPlan : null);

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
              <ArrowUpCircle className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
            </div>
            <h3 className="text-xl font-bold text-theme-primary">{t("upgrade.title")}</h3>
          </div>
          {canClose && (
            <button onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Indicador de passos */}
        {(step === "choose" || step === "mods" || step === "confirm") && (
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-theme-secondary">
            {(["choose", ...(changesMinecraft && itemsFolder ? ["mods"] : []), "confirm"] as Step[]).map((s, i, arr) => (
              <span key={s} className="flex items-center gap-2">
                <span className={cn("px-2 py-0.5 rounded-full", step === s ? "bg-indigo-600 text-white" : "bg-theme-muted")}>
                  {i + 1}. {t(`upgrade.stepName.${s}` as "upgrade.stepName.choose")}
                </span>
                {i < arr.length - 1 && <span>›</span>}
              </span>
            ))}
          </div>
        )}

        {!isServerStopped && step !== "running" && step !== "done" && (
          <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {t("upgrade.stopFirst")}
          </div>
        )}

        {/* ---------- 1. Escolher ---------- */}
        {step === "choose" && (
          <div className="space-y-4">
            <div className="p-3.5 bg-theme-muted border border-theme-card rounded-2xl">
              <p className="text-[11px] font-bold uppercase tracking-wide text-theme-secondary">{t("upgrade.current")}</p>
              <p className="text-sm font-bold text-theme-primary mt-0.5">{currentLabel(serverInfo)}</p>
            </div>

            {!options && !loadError && (
              <div className="py-8 flex flex-col items-center gap-3">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                <span className="text-sm font-semibold text-theme-secondary">{t("upgrade.searching")}</span>
              </div>
            )}
            {loadError && (
              <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {t("upgrade.offline")}
              </div>
            )}
            {nothingToDo && (
              <div className="p-4 bg-theme-accent border border-theme-accent rounded-xl flex items-center gap-2.5 text-sm text-theme-primary">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" /> {t("upgrade.upToDate")}
              </div>
            )}

            {options && !nothingToDo && (
              <div className="space-y-2.5">
                {options.sameVersion && (
                  <button
                    type="button"
                    onClick={() => setChoice("same")}
                    className={cn("w-full text-left p-3.5 rounded-2xl border transition-colors cursor-pointer", choice === "same" ? "bg-theme-accent border-indigo-400" : "bg-theme-muted border-theme-card hover:border-slate-300")}
                  >
                    <p className="text-sm font-bold text-theme-primary">{t("upgrade.opt.same.title", { loader: TYPE_LABELS[type] })}</p>
                    <p className="text-xs text-theme-secondary mt-0.5 leading-relaxed">
                      {t("upgrade.opt.same.desc", { from: installedLoaderVersion(serverInfo) ?? "?", to: options.sameVersion.loaderVersion ?? "?", mc: serverInfo.version ?? "", items: itemsLabel })}
                    </p>
                  </button>
                )}
                {options.newerVersions.length > 0 && (
                  <div
                    onClick={() => setChoice("newer")}
                    className={cn("w-full p-3.5 rounded-2xl border transition-colors cursor-pointer", choice === "newer" ? "bg-theme-accent border-indigo-400" : "bg-theme-muted border-theme-card hover:border-slate-300")}
                  >
                    <p className="text-sm font-bold text-theme-primary">{t("upgrade.opt.newer.title")}</p>
                    <p className="text-xs text-theme-secondary mt-0.5 leading-relaxed">
                      {itemsFolder ? t("upgrade.opt.newer.descMods", { items: itemsLabel }) : t("upgrade.opt.newer.desc")}
                    </p>
                    {choice === "newer" && (
                      <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                        <div className="relative">
                          <select
                            value={pickedVersion}
                            onChange={(e) => setPickedVersion(e.target.value)}
                            className="w-full h-11 pl-3 pr-9 rounded-xl bg-theme-card border border-theme-card text-sm font-semibold text-theme-primary appearance-none cursor-pointer"
                          >
                            <option value="" disabled>{t("upgrade.opt.newer.placeholder")}</option>
                            {options.newerVersions.slice(0, 60).map((v, i) => (
                              <option key={v} value={v}>{i === 0 ? t("upgrade.opt.newer.latest", { v }) : v}</option>
                            ))}
                          </select>
                          <ChevronDown className="w-4 h-4 text-theme-secondary absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
                        {resolving && (
                          <p className="text-xs text-theme-secondary flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("upgrade.checkingLoader", { loader: TYPE_LABELS[type], v: pickedVersion })}
                          </p>
                        )}
                        {unavailable && !resolving && (
                          <p className="text-xs text-rose-600 dark:text-rose-300 flex items-start gap-2">
                            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {t("upgrade.loaderMissing", { loader: TYPE_LABELS[type], v: pickedVersion })}
                          </p>
                        )}
                        {target && !resolving && (
                          <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5" /> {t("upgrade.willInstall", { what: target.label })}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
              <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={goNextFromChoose}
                disabled={!isServerStopped || !chosenTarget || resolving}
                className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 cursor-pointer"
              >
                {t("upgrade.continue")}
              </button>
            </div>
          </div>
        )}

        {/* ---------- 2. Mods / plugins ---------- */}
        {step === "mods" && (
          <div className="space-y-4">
            {analyzing && (
              <div className="py-8 flex flex-col items-center gap-3">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                <span className="text-sm font-semibold text-theme-secondary text-center">{t("upgrade.mods.checking", { items: itemsLabel, mc: chosenTarget?.mcVersion ?? "" })}</span>
              </div>
            )}

            {!analyzing && modPlan && (
              <>
                {modPlan.analysisFailed && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2 leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" /> {t("upgrade.mods.failed", { items: itemsLabel })}
                  </div>
                )}
                {!modPlan.analysisFailed && modPlan.items.length === 0 && (
                  <p className="text-sm text-theme-secondary">{t("upgrade.mods.none", { items: itemsLabel })}</p>
                )}

                {modPlan.items.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm text-theme-primary font-semibold">{t("upgrade.mods.intro", { n: modPlan.items.length, items: itemsLabel, mc: chosenTarget?.mcVersion ?? "" })}</p>
                    <ModGroup tone="ok" title={t("upgrade.mods.ok", { n: summary.ok })} files={modPlan.items.filter((i) => i.verdict === "ok").map((i) => i.displayName)} hint={t("upgrade.mods.okHint")} />
                    <ModGroup tone="update" title={t("upgrade.mods.update", { n: summary.update })} files={modPlan.items.filter((i) => i.verdict === "update").map((i) => i.displayName)} hint={t("upgrade.mods.updateHint")} />
                    <ModGroup tone="warn" title={t("upgrade.mods.incompatible", { n: summary.incompatible, v: chosenTarget?.mcVersion ?? "" })} files={modPlan.items.filter((i) => i.verdict === "incompatible").map((i) => i.displayName)} hint={t("upgrade.mods.incompatibleHint")} defaultOpen />
                    <ModGroup tone="muted" title={t("upgrade.mods.unknown", { n: summary.unknown })} files={modPlan.items.filter((i) => i.verdict === "unknown").map((i) => i.displayName)} hint={t("upgrade.mods.unknownHint")} />
                  </div>
                )}

                {modPlan.extras.length > 0 && (
                  <p className="text-xs text-theme-secondary leading-relaxed">
                    {t("upgrade.mods.extras", { n: modPlan.extras.length, names: modPlan.extras.map((e) => e.title).join(", ") })}
                  </p>
                )}
                {modPlan.missingDeps.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                    {t("upgrade.mods.missingDeps", { names: modPlan.missingDeps.join(", ") })}
                  </p>
                )}

                {summary.incompatible > 0 && (
                  <label className="flex items-start gap-2.5 cursor-pointer p-3 bg-theme-muted border border-theme-card rounded-2xl">
                    <input type="checkbox" checked={disableIncompatible} onChange={(e) => setDisableIncompatible(e.target.checked)} className="mt-0.5 accent-indigo-600" />
                    <span>
                      <span className="text-sm font-semibold text-theme-primary block">{t("upgrade.mods.disable", { items: itemsLabel })}</span>
                      <span className="text-[11px] text-theme-secondary">{t("upgrade.mods.disableHint")}</span>
                    </span>
                  </label>
                )}
              </>
            )}

            <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
              <button type="button" onClick={() => setStep("choose")} disabled={analyzing} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold disabled:opacity-40">
                {t("upgrade.back")}
              </button>
              <button type="button" onClick={goToConfirm} disabled={analyzing} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 cursor-pointer">
                {t("upgrade.continue")}
              </button>
            </div>
          </div>
        )}

        {/* ---------- 3. Confirmar ---------- */}
        {step === "confirm" && chosenTarget && (
          <div className="space-y-4">
            <div className="p-4 bg-theme-accent border border-theme-accent rounded-xl space-y-1">
              <p className="text-xs text-theme-secondary">{currentLabel(serverInfo)}</p>
              <p className="text-base font-bold text-theme-primary">→ {chosenTarget.label}</p>
              {changesMinecraft && modPlan && !modPlan.analysisFailed && (
                <p className="text-xs text-theme-secondary pt-1">
                  {t("upgrade.confirm.mods", { update: summary.update + summary.extras, disabled: disableIncompatible ? summary.incompatible : 0, items: itemsLabel })}
                </p>
              )}
            </div>

            {changesMinecraft && (
              <p className="text-xs text-theme-secondary leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" /> {t("upgrade.confirm.worldWarning")}
              </p>
            )}

            <label className="flex items-start gap-2.5 cursor-pointer p-3.5 bg-theme-muted border border-theme-card rounded-2xl">
              <input type="checkbox" checked={fullBackup} onChange={(e) => setFullBackup(e.target.checked)} className="mt-0.5 accent-indigo-600" />
              <span className="space-y-0.5">
                <span className="text-sm font-semibold text-theme-primary block">{t("upgrade.backup.label")}</span>
                <span className="text-[11px] text-theme-secondary block leading-relaxed">
                  {t("upgrade.backup.hint")}
                  {estimate && ` ${t("upgrade.backup.size", { size: formatBytes(estimate.bytes) })}`}
                </span>
              </span>
            </label>
            {fullBackup && lowSpace && estimate && (
              <p className="text-xs text-rose-600 dark:text-rose-300 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {t("upgrade.backup.lowSpace", { free: formatBytes(estimate.freeBytes ?? 0), need: formatBytes(estimate.bytes) })}
              </p>
            )}
            {!fullBackup && (
              <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {t("upgrade.backup.warnOff")}
              </p>
            )}
            <p className="text-[11px] text-theme-secondary flex items-start gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-px" /> {t("upgrade.confirm.safe")}
            </p>

            <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
              <button type="button" onClick={() => setStep(changesMinecraft && itemsFolder ? "mods" : "choose")} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                {t("upgrade.back")}
              </button>
              <button
                type="button"
                onClick={handleRun}
                disabled={!isServerStopped || (fullBackup && lowSpace)}
                className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 cursor-pointer"
              >
                {t("upgrade.run")}
              </button>
            </div>
          </div>
        )}

        {/* ---------- 4. Executando ---------- */}
        {step === "running" && progress && (
          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-3">
              <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
              <span className="font-bold text-theme-primary text-sm text-center">{progress.message}</span>
            </div>
            <div className="w-full h-3 bg-theme-muted rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${progress.percent}%` }} className="h-full bg-indigo-600 rounded-full" />
            </div>
            <p className="text-[11px] text-theme-secondary text-center italic">{t("upgrade.doNotClose")}</p>
          </div>
        )}

        {/* ---------- 5. Pronto ---------- */}
        {step === "done" && outcome && chosenTarget && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-3 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-500" />
              <p className="text-lg font-bold text-theme-primary">{t("upgrade.done.title")}</p>
              <p className="text-sm text-theme-secondary">{chosenTarget.label}</p>
            </div>
            <ul className="text-xs text-theme-secondary space-y-1 list-disc pl-5">
              {outcome.updatedMods > 0 && <li>{t("upgrade.done.updated", { n: outcome.updatedMods })}</li>}
              {outcome.addedMods > 0 && <li>{t("upgrade.done.added", { n: outcome.addedMods })}</li>}
              {outcome.disabledMods > 0 && <li>{t("upgrade.done.disabled", { n: outcome.disabledMods })}</li>}
              {outcome.backupFile && <li className="break-all">{t("upgrade.done.backup", { file: outcome.backupFile })}</li>}
            </ul>
            <p className="text-xs text-theme-secondary leading-relaxed p-3 bg-theme-muted border border-theme-card rounded-xl">{t("upgrade.done.next")}</p>
            {outcome.backupFile && <p className="text-[11px] text-theme-secondary leading-relaxed">{t("upgrade.done.howToUndo")}</p>}
            <div className="flex justify-end pt-3 border-t border-theme-card">
              <button type="button" onClick={onClose} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
                {t("upgrade.close")}
              </button>
            </div>
          </div>
        )}

        {/* ---------- Erro ---------- */}
        {step === "error" && (
          <div className="space-y-4">
            <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs leading-relaxed flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            <p className="text-xs text-theme-secondary leading-relaxed">{partial ? t("upgrade.error.partial") : t("upgrade.error.safe")}</p>
            <div className="flex justify-end gap-3 pt-3 border-t border-theme-card">
              <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold">
                {t("upgrade.close")}
              </button>
              <button type="button" onClick={() => setStep("confirm")} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">
                {t("upgrade.retry")}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function ModGroup({ tone, title, files, hint, defaultOpen }: { tone: "ok" | "update" | "warn" | "muted"; title: string; files: string[]; hint: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (files.length === 0) return null;
  const color =
    tone === "ok" ? "text-emerald-700 dark:text-emerald-300"
    : tone === "update" ? "text-indigo-700 dark:text-indigo-300"
    : tone === "warn" ? "text-amber-700 dark:text-amber-300"
    : "text-theme-secondary";
  return (
    <div className="bg-theme-muted border border-theme-card rounded-2xl overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-left cursor-pointer">
        <span className={cn("text-sm font-semibold", color)}>{title}</span>
        <ChevronDown className={cn("w-4 h-4 text-theme-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3.5 pb-3 space-y-1.5">
          <p className="text-[11px] text-theme-secondary leading-relaxed">{hint}</p>
          <ul className="text-xs text-theme-primary space-y-0.5 max-h-40 overflow-y-auto">
            {files.map((f) => <li key={f} className="truncate">• {f}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Wrapper: o corpo só existe com o modal aberto, então todo o estado recomeça do zero a cada abertura. */
export function ServerUpgradeWizard(props: WizardProps) {
  return <AnimatePresence>{props.isOpen && <WizardBody key="open" {...props} />}</AnimatePresence>;
}
