"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/errorMessage";
import { getBackupsSettings, isInsideOneDrive, setBackupsRoot, type BackupsSettings } from "@/lib/backupsFolder";

// Onde ficam os backups do mundo: mostra a pasta em uso, deixa trocar (ou voltar à padrão) e abrir.
export function BackupFolderSettings() {
  const { t } = useT();
  const [settings, setSettings] = useState<BackupsSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await getBackupsSettings());
    } catch (err) {
      setError(errorMessage(err) || String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (path: string | null) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await setBackupsRoot(path));
    } catch (err) {
      setError(errorMessage(err) || String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const selected = await open({ directory: true, multiple: false, defaultPath: settings?.path });
    if (typeof selected === "string") await change(selected);
  };

  const openFolder = (path: string) => void invoke("open_path_in_explorer", { path }).catch((err) => setError(errorMessage(err) || String(err)));
  const btn = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed bg-theme-card border-theme-card text-theme-primary hover:border-indigo-400";

  if (!settings) return error ? <p className="text-xs text-rose-500">{error}</p> : null;

  return (
    <div className="space-y-3">
      <p className="text-xs font-mono text-theme-secondary break-all bg-theme-card border border-theme-card rounded-lg p-2.5" title={settings.path}>{settings.path}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy} onClick={pick}><FolderOpen className="w-3.5 h-3.5" />{t("settings.backups.folder.change")}</button>
        <button type="button" className={btn} disabled={!settings.available} onClick={() => openFolder(settings.path)}>{t("settings.backups.folder.open")}</button>
        {settings.isCustom && (
          <button type="button" className={btn} disabled={busy} onClick={() => void change(null)}><RotateCcw className="w-3.5 h-3.5" />{t("settings.backups.folder.reset")}</button>
        )}
      </div>
      {!settings.available && <p className="text-xs text-amber-600 dark:text-amber-400">{t("settings.backups.folder.unavailable")}</p>}
      {isInsideOneDrive(settings.path) && <p className="text-xs text-amber-600 dark:text-amber-400">{t("settings.backups.folder.onedrive")}</p>}
      {settings.previous && (
        <p className="text-xs text-theme-secondary">
          {t("settings.backups.folder.previous", { path: settings.previous })}{" "}
          <button type="button" className="font-bold text-indigo-600 dark:text-indigo-400 cursor-pointer" onClick={() => openFolder(settings.previous!)}>{t("settings.backups.folder.openPrevious")}</button>
        </p>
      )}
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </div>
  );
}
