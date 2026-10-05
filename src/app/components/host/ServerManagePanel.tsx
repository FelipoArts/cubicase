"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Blocks,
  Globe2,
  Trash2,
  FolderOpen,
  Archive,
  RotateCcw,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Save,
  CheckSquare,
  Square,
  PackagePlus,
  PackageOpen,
  Search,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { cn } from "@/lib/utils";
import { pushDiagnostic } from "@/app/diagnostics";
import { getBackupsDir } from "@/lib/server";
import type { ServerStatus } from "@/app/store";
import { ConfirmActionModal } from "./ConfirmActionModal";
import { ModBrowserModal } from "./ModBrowserModal";
import { Checkbox } from "@/app/components/Checkbox";
import { Switch } from "@/app/components/Switch";
import { ExportPackModal } from "./ExportPackModal";
import { readPending, completePending, type PackPending } from "@/lib/cubicasePack";
import { loaderForServerType } from "@/lib/modrinth";
import { readModIdentities, findDuplicates, type ModIdentity } from "@/lib/modIdentity";
import { reconcilePendingMods, dismissPendingMods, pendingModPageUrl, type PendingMod } from "@/lib/pendingMods";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useT, t as tn, getLocale } from "@/i18n";

// ============================================================
// ServerManagePanel
// ============================================================
// Painel inline com abas para gerenciar os mods (Forge/Fabric/NeoForge)
// e o mundo (backup/restaurar/resetar) do servidor selecionado, sem
// precisar abrir a pasta do servidor manualmente.
// ============================================================

interface ModInfo {
  file_name: string;
  display_name: string;
  size_bytes: number;
  enabled: boolean;
}

interface BackupInfo {
  file_name: string;
  size_bytes: number;
  created_at: string;
}

interface ServerManagePanelProps {
  serverDir: string;
  serverName: string;
  serverType: string;
  serverStatus: ServerStatus;
  mcVersion: string | null;
  /** Abre o navegador de mods logo ao montar (servidor recém-criado). */
  autoOpenModBrowser?: boolean;
  onAutoOpenHandled?: () => void;
}

type PendingAction =
  | { kind: "delete-mod"; fileName: string; displayName: string }
  | { kind: "delete-mods-bulk"; fileNames: string[] }
  | { kind: "delete-backup"; fileName: string }
  | { kind: "restore-backup"; fileName: string }
  | { kind: "reset-world" };

/** Minúsculas e sem acento, para "acao" achar "Ação". */
const normalizeSearch = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Todas as palavras digitadas precisam aparecer no nome do arquivo ou no id interno do mod. */
function filterMods(mods: ModInfo[], idByFile: Map<string, string>, query: string): ModInfo[] {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return mods;
  return mods.filter((m) => {
    const haystack = normalizeSearch(`${m.display_name} ${idByFile.get(m.file_name) ?? ""}`);
    return tokens.every((tok) => haystack.includes(tok));
  });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  if (!iso) return tn("manage.unknownDate");
  try {
    return new Date(iso).toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function ServerManagePanel({ serverDir, serverName, serverType, serverStatus, mcVersion, autoOpenModBrowser, onAutoOpenHandled }: ServerManagePanelProps) {
  const { t, rich } = useT();
  // Forge/NeoForge/Fabric usam pasta "mods"; Paper (e derivados como Spigot/Purpur)
  // usam pasta "plugins" — mesmo conceito de gerenciamento, pasta e rótulo diferentes.
  const isPluginBased = serverType === "paper" || serverType === "spigot" || serverType === "purpur" || serverType === "bukkit";
  const modsCapable = serverType === "forge" || serverType === "neoforge" || serverType === "fabric" || isPluginBased;
  const itemsFolder = isPluginBased ? "plugins" : "mods";
  const itemsLabel = isPluginBased ? "Plugins" : "Mods";
  const itemWord = isPluginBased ? "plugin" : "mod";
  // A Modrinth só cobre esse mesmo conjunto de loaders (ver loaderForServerType em
  // src/lib/modrinth.ts); precisamos também saber a versão do MC pra filtrar por
  // compatibilidade, que nem sempre está disponível (ex: servidor importado sem meta).
  const modBrowserAvailable = modsCapable && !!loaderForServerType(serverType) && !!mcVersion;
  const [activeTab, setActiveTab] = useState<"mods" | "mundo">(modsCapable ? "mods" : "mundo");
  const [showModBrowser, setShowModBrowser] = useState(() => !!autoOpenModBrowser && modBrowserAvailable);
  const [showExportPack, setShowExportPack] = useState(false);
  // Importação de um pacote leve sem internet deixa mods pendentes (ver cubicasePack.ts).
  const [pendingPack, setPendingPack] = useState<PackPending | null>(null);
  const [completing, setCompleting] = useState<{ done: number; total: number } | null>(null);
  const [completeNote, setCompleteNote] = useState<string | null>(null);

  const [mods, setMods] = useState<ModInfo[]>([]);
  const [identities, setIdentities] = useState<ModIdentity[]>([]);
  // Mods de modpacks bloqueados em todas as fontes: o host baixa à mão (ver lib/pendingMods.ts).
  const [pendingMods, setPendingMods] = useState<PendingMod[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loadingMods, setLoadingMods] = useState(false);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());
  const [modQuery, setModQuery] = useState("");

  const isServerStopped = serverStatus === "offline" || serverStatus === "crashed";

  // O mesmo mod (mesmo id interno) em mais de um arquivo ativo, mesmo com nomes/versões diferentes.
  const duplicateByFile = useMemo(() => {
    const map = new Map<string, { modId: string; others: string[] }>();
    for (const group of findDuplicates(identities)) {
      for (const f of group.files) {
        map.set(f.file_name, { modId: group.modId, others: group.files.filter((o) => o !== f).map((o) => o.file_name) });
      }
    }
    return map;
  }, [identities]);
  const duplicateCount = useMemo(() => new Set([...duplicateByFile.values()].map((d) => d.modId)).size, [duplicateByFile]);

  // Servidor recém-criado: avisa o HostView que o pedido de abrir o navegador de mods foi atendido.
  useEffect(() => {
    if (autoOpenModBrowser) onAutoOpenHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Some mensagens de erro (ex: aviso de backup sem mundo) somem sozinhas depois de um tempo.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    readPending(serverDir).then((p) => { if (!cancelled) setPendingPack(p); });
    return () => { cancelled = true; };
  }, [serverDir]);

  const handleCompletePending = async () => {
    setCompleteNote(null);
    setCompleting({ done: 0, total: pendingPack?.mods.length ?? 0 });
    try {
      const res = await completePending(serverDir, (done, total) => setCompleting({ done, total }));
      setPendingPack(await readPending(serverDir));
      if (res.remaining.length > 0) setCompleteNote(tn("pack.pending.stillMissing", { count: res.remaining.length }));
      await loadMods();
    } finally {
      setCompleting(null);
    }
  };

  const loadMods = useCallback(async () => {
    if (!modsCapable) return;
    setLoadingMods(true);
    try {
      const list = await invoke<ModInfo[]>("list_mods", { serverDir, folderName: itemsFolder });
      setMods(list);
      // Identidade lida dos jars: serve só para apontar mods duplicados — se falhar, a lista segue normal.
      readModIdentities(serverDir, itemsFolder).then(setIdentities).catch(() => setIdentities([]));
      // Tira da lista de pendentes o que o host já colocou na pasta.
      reconcilePendingMods(serverDir).then(setPendingMods).catch(() => {});
      setSelectedMods((prev) => {
        const stillPresent = new Set([...prev].filter((fileName) => list.some((m) => m.file_name === fileName)));
        return stillPresent.size === prev.size ? prev : stillPresent;
      });
    } catch (err) {
      console.error("Erro ao listar mods:", err);
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("manage.err.listMods"), message: String(err) });
    } finally {
      setLoadingMods(false);
    }
  }, [serverDir, modsCapable, itemsFolder]);

  // O host baixa o mod no navegador e volta ao app: ao recuperar o foco, relê a pasta para a pendência sumir sozinha.
  useEffect(() => {
    if (pendingMods.length === 0) return;
    const onFocus = () => { loadMods(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pendingMods.length, loadMods]);

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const backupsDir = await getBackupsDir(serverName);
      const list = await invoke<BackupInfo[]>("list_world_backups", { serverDir, backupsDir });
      setBackups(list);
    } catch (err) {
      console.error("Erro ao listar backups:", err);
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("manage.err.listBackups"), message: String(err) });
    } finally {
      setLoadingBackups(false);
    }
  }, [serverDir, serverName]);

  // Nota: HostView monta este componente com `key={serverDir}`, então trocar de
  // servidor remonta o componente e reinicia todo o estado local automaticamente.
  useEffect(() => {
    (async () => {
      await loadMods();
      await loadBackups();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleMod = async (mod: ModInfo) => {
    try {
      await invoke("toggle_mod", { serverDir, fileName: mod.file_name, folderName: itemsFolder });
      await loadMods();
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("manage.err.toggle", { item: itemWord }), message: String(err) });
    }
  };

  const toggleModSelection = (fileName: string) => {
    setSelectedMods((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  };

  // Id interno de cada jar (lido por read_mod_identities): a busca acha o mod por ele também.
  const idByFile = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of identities) if (i.mod_id) map.set(i.file_name, i.mod_id);
    return map;
  }, [identities]);
  const visibleMods = useMemo(() => filterMods(mods, idByFile, modQuery), [mods, idByFile, modQuery]);

  // "Selecionar todos" e a exclusão em lote valem só para o que está visível: nunca
  // apagar em lote algo que a busca escondeu.
  const allModsSelected = visibleMods.length > 0 && visibleMods.every((m) => selectedMods.has(m.file_name));

  const toggleSelectAllMods = () => {
    setSelectedMods((prev) => {
      const next = new Set(prev);
      for (const m of visibleMods) {
        if (allModsSelected) next.delete(m.file_name);
        else next.add(m.file_name);
      }
      return next;
    });
  };

  const handleModQueryChange = (query: string) => {
    setModQuery(query);
    const stillVisible = new Set(filterMods(mods, idByFile, query).map((m) => m.file_name));
    setSelectedMods((prev) => {
      const kept = new Set([...prev].filter((f) => stillVisible.has(f)));
      return kept.size === prev.size ? prev : kept;
    });
  };

  const handleOpenModsFolder = async () => {
    try {
      const modsPath = await join(serverDir, itemsFolder);
      await invoke("open_path_in_explorer", { path: modsPath });
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("manage.source.system"), title: tn("manage.err.openFolder", { items: itemsLabel.toLowerCase() }), message: String(err) });
    }
  };

  const handleBackupNow = async () => {
    try {
      setIsBackingUp(true);
      setError(null);
      const backupsDir = await getBackupsDir(serverName);
      await invoke("backup_world", { serverDir, backupsDir });
      await loadBackups();
    } catch (err) {
      console.error(err);
      setError(String(err));
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("manage.err.backup"), message: String(err) });
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    try {
      if (pendingAction.kind === "delete-mod") {
        await invoke("delete_mod", { serverDir, fileName: pendingAction.fileName, folderName: itemsFolder });
        await loadMods();
      } else if (pendingAction.kind === "delete-mods-bulk") {
        for (const fileName of pendingAction.fileNames) {
          await invoke("delete_mod", { serverDir, fileName, folderName: itemsFolder });
        }
        setSelectedMods(new Set());
        await loadMods();
      } else if (pendingAction.kind === "delete-backup") {
        const backupsDir = await getBackupsDir(serverName);
        await invoke("delete_world_backup", { backupsDir, fileName: pendingAction.fileName });
        await loadBackups();
      } else if (pendingAction.kind === "restore-backup") {
        const backupsDir = await getBackupsDir(serverName);
        await invoke("restore_world_backup", { serverDir, backupsDir, fileName: pendingAction.fileName });
      } else if (pendingAction.kind === "reset-world") {
        await invoke("reset_world", { serverDir });
      }
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: tn("diag.source.server"), title: tn("manage.err.action"), message: String(err) });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
            {t("manage.badge")}
          </span>
          <h2 className="text-2xl font-bold text-theme-primary mt-2">{t("manage.heading", { items: itemsLabel })}</h2>
        </div>

        <div className="flex items-center gap-2 bg-theme-muted p-1 rounded-2xl border border-theme-card">
          {modsCapable && (
            <button
              type="button"
              onClick={() => setActiveTab("mods")}
              className={cn(
                "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 transition-all cursor-pointer",
                activeTab === "mods" ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary"
              )}
            >
              <Blocks className="w-3.5 h-3.5" /> {itemsLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveTab("mundo")}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 transition-all cursor-pointer",
              activeTab === "mundo" ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary"
            )}
          >
            <Globe2 className="w-3.5 h-3.5" /> {t("manage.tab.world")}
          </button>
        </div>
      </div>

      {pendingPack && (
        <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl space-y-2.5">
          <p className="text-sm font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {t("pack.pending.title")}
          </p>
          <p className="text-xs leading-relaxed">{t("pack.pending.message", { count: pendingPack.mods.length })}</p>
          {completeNote && <p className="text-xs font-semibold">{completeNote}</p>}
          <button
            type="button"
            onClick={handleCompletePending}
            disabled={!!completing}
            className="h-9 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
          >
            {completing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {completing ? t("pack.pending.completing", { done: completing.done, total: completing.total }) : t("pack.pending.complete")}
          </button>
        </div>
      )}

      {activeTab === "mods" && modsCapable && (
        <div className="space-y-4">
          {serverStatus === "online" && (
            <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {t("manage.restartNote", { items: itemsLabel.toLowerCase() })}
            </div>
          )}

          {pendingMods.length > 0 && (
            <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-bold">{t("pendingMods.title", { count: pendingMods.length })}</p>
                  <p className="text-xs leading-relaxed mt-0.5">{t("pendingMods.subtitle")}</p>
                </div>
              </div>
              <ul className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
                {pendingMods.map((m) => (
                  <li key={m.key} className="flex items-center justify-between gap-3 bg-white/50 dark:bg-black/20 rounded-xl px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold truncate">{m.name}</p>
                      <p className="text-[11px] opacity-80 truncate">
                        {t("pendingMods.fromPack", { pack: m.packName })}
                        {m.fileName ? ` · ${m.fileName}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => openExternal(pendingModPageUrl(m))}
                        className="h-7 px-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold cursor-pointer"
                      >
                        {t("pendingMods.openPage")}
                      </button>
                      <button
                        type="button"
                        onClick={() => dismissPendingMods(serverDir, [m.key]).then(setPendingMods)}
                        className="h-7 px-2.5 rounded-lg hover:bg-amber-200/60 dark:hover:bg-amber-800/40 text-[11px] font-bold cursor-pointer"
                      >
                        {t("pendingMods.dismiss")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenModsFolder}
                  className="h-8 px-3 rounded-xl bg-white/60 dark:bg-black/20 hover:bg-white dark:hover:bg-black/30 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" /> {t("pendingMods.openFolder")}
                </button>
                <button
                  type="button"
                  onClick={() => dismissPendingMods(serverDir, "all").then(setPendingMods)}
                  className="h-8 px-3 rounded-xl text-xs font-bold hover:bg-amber-200/60 dark:hover:bg-amber-800/40 cursor-pointer"
                >
                  {t("pendingMods.dismissAll")}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            {selectedMods.size > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleSelectAllMods}
                  title={allModsSelected ? t("manage.deselectAll") : t("manage.selectAll")}
                  className="h-9 w-9 flex items-center justify-center bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-indigo-600 transition-colors cursor-pointer"
                >
                  {allModsSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAction({ kind: "delete-mods-bulk", fileNames: Array.from(selectedMods) })}
                  title={t("manage.deleteSelected", { items: itemsLabel.toLowerCase() })}
                  className="h-9 w-9 flex items-center justify-center bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 border border-theme-card rounded-xl text-rose-500 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowModBrowser(true)}
              disabled={!modBrowserAvailable}
              title={modBrowserAvailable ? undefined : t("manage.browseUnavailable")}
              className="h-9 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <PackagePlus className="w-3.5 h-3.5" /> {t("manage.browse", { items: itemsLabel })}
            </button>
            <button
              type="button"
              onClick={handleOpenModsFolder}
              className="h-9 px-4 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-xs font-bold text-theme-secondary hover:text-indigo-600 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" /> {t("manage.openFolder", { items: itemsLabel })}
            </button>
            <button
              type="button"
              onClick={loadMods}
              disabled={loadingMods}
              className="h-9 w-9 flex items-center justify-center bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer disabled:opacity-50"
              title={t("manage.refresh")}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loadingMods && "animate-spin")} />
            </button>
          </div>

          {duplicateCount > 0 && (
            <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {t("manage.dup.banner", { count: duplicateCount })}
            </div>
          )}

          {mods.length > 0 && (
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-secondary pointer-events-none" />
              <input
                type="text"
                value={modQuery}
                onChange={(e) => handleModQueryChange(e.target.value)}
                placeholder={t("manage.searchPlaceholder", { items: itemsLabel.toLowerCase() })}
                className="w-full h-10 pl-10 pr-20 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
              />
              {modQuery && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-theme-secondary">
                    {t("manage.searchCount", { shown: visibleMods.length, total: mods.length })}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleModQueryChange("")}
                    title={t("manage.searchClear")}
                    className="h-6 w-6 flex items-center justify-center rounded-lg text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          {mods.length === 0 ? (
            <div className="text-center py-10 text-theme-secondary text-sm">
              {loadingMods ? (
                <Loader2 className="w-5 h-5 animate-spin mx-auto" />
              ) : (
                <>{t("manage.empty", { item: itemWord, folder: itemsFolder })}</>
              )}
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
              {visibleMods.length === 0 && (
                <div className="text-center py-8 text-theme-secondary text-sm">
                  {t("manage.searchNoMatch", { item: itemWord, query: modQuery })}
                </div>
              )}
              {visibleMods.map((mod) => (
                <div
                  key={mod.file_name}
                  className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Checkbox
                      checked={selectedMods.has(mod.file_name)}
                      onChange={() => toggleModSelection(mod.file_name)}
                      title={t("manage.selectMod")}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className={cn("text-sm font-semibold truncate", mod.enabled ? "text-theme-primary" : "text-theme-secondary line-through")}>
                          {mod.display_name}
                        </p>
                        {mod.enabled && duplicateByFile.has(mod.file_name) && (
                          <span
                            title={t("manage.dup.title", {
                              id: duplicateByFile.get(mod.file_name)!.modId,
                              files: duplicateByFile.get(mod.file_name)!.others.join(", "),
                            })}
                            className="px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-[9px] font-bold uppercase tracking-wide flex-shrink-0"
                          >
                            {t("manage.dup.badge")}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-theme-secondary">{formatSize(mod.size_bytes)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Switch
                      checked={mod.enabled}
                      onChange={() => handleToggleMod(mod)}
                      title={mod.enabled ? t("manage.disable", { item: itemWord }) : t("manage.enable", { item: itemWord })}
                    />
                    <button
                      type="button"
                      onClick={() => setPendingAction({ kind: "delete-mod", fileName: mod.file_name, displayName: mod.display_name })}
                      title={t("manage.delete", { item: itemWord })}
                      className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "mundo" && (
        <div className="space-y-4">
          {!isServerStopped && (
            <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {t("manage.stopForBackups")}
            </div>
          )}
          {error && (
            <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleBackupNow}
              disabled={!isServerStopped || isBackingUp}
              className="h-10 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer shadow-md shadow-theme-shadow"
            >
              {isBackingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isBackingUp ? t("manage.backingUp") : t("manage.backupNow")}
            </button>
            <button
              type="button"
              onClick={() => setShowExportPack(true)}
              disabled={!isServerStopped || !!pendingPack}
              title={t("pack.export.buttonHint")}
              className="h-10 px-5 bg-theme-muted hover:bg-theme-card border border-theme-card text-indigo-600 rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
            >
              <PackageOpen className="w-3.5 h-3.5" /> {t("pack.export.button")}
            </button>
            <button
              type="button"
              onClick={() => setPendingAction({ kind: "reset-world" })}
              disabled={!isServerStopped}
              className="h-10 px-5 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-300 rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> {t("manage.resetWorld")}
            </button>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-theme-secondary uppercase tracking-wide flex items-center gap-1.5">
                <Archive className="w-3.5 h-3.5" /> {t("manage.backups")}
              </h3>
              <button
                type="button"
                onClick={loadBackups}
                disabled={loadingBackups}
                className="h-7 w-7 flex items-center justify-center rounded-lg text-theme-secondary hover:text-indigo-600 hover:bg-theme-muted transition-colors cursor-pointer disabled:opacity-50"
                title={t("manage.refresh")}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", loadingBackups && "animate-spin")} />
              </button>
            </div>

            {backups.length === 0 ? (
              <div className="text-center py-8 text-theme-secondary text-sm">
                {loadingBackups ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : <>{t("manage.noBackups")}</>}
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
                {backups.map((backup) => (
                  <div
                    key={backup.file_name}
                    className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-theme-primary truncate">{backup.file_name}</p>
                      <p className="text-[11px] text-theme-secondary">
                        {formatDate(backup.created_at)} • {formatSize(backup.size_bytes)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setPendingAction({ kind: "restore-backup", fileName: backup.file_name })}
                        disabled={!isServerStopped}
                        title={t("manage.restoreBackup")}
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingAction({ kind: "delete-backup", fileName: backup.file_name })}
                        title={t("manage.deleteBackup")}
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmActionModal
        isOpen={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={handleConfirmAction}
        title={
          pendingAction?.kind === "delete-mod" || pendingAction?.kind === "delete-mods-bulk"
            ? t("manage.confirm.deleteItem.title", { item: isPluginBased ? "Plugin" : "Mod" })
            : pendingAction?.kind === "delete-backup"
            ? t("manage.confirm.deleteBackup.title")
            : pendingAction?.kind === "restore-backup"
            ? t("manage.confirm.restore.title")
            : t("manage.confirm.reset.title")
        }
        confirmLabel={
          pendingAction?.kind === "delete-mod" || pendingAction?.kind === "delete-mods-bulk" || pendingAction?.kind === "delete-backup"
            ? t("manage.confirm.delete")
            : pendingAction?.kind === "restore-backup"
            ? t("manage.confirm.restore")
            : t("manage.confirm.reset")
        }
        requireTypedConfirmation={
          pendingAction?.kind === "restore-backup" ? t("manage.confirm.typed.restore") : pendingAction?.kind === "reset-world" ? t("manage.confirm.typed.reset") : undefined
        }
        message={
          pendingAction?.kind === "delete-mod" ? (
            <>{rich("manage.confirm.deleteMod.msg", { item: itemWord, name: <strong className="text-theme-primary">{`"${pendingAction.displayName}"`}</strong> })}</>
          ) : pendingAction?.kind === "delete-mods-bulk" ? (
            <>{rich("manage.confirm.bulk.msg", { what: <strong className="text-theme-primary">{t("manage.confirm.bulk.what", { count: pendingAction.fileNames.length, item: itemWord })}</strong> })}</>
          ) : pendingAction?.kind === "delete-backup" ? (
            <>{rich("manage.confirm.deleteBackup.msg", { name: <strong className="text-theme-primary">{`"${pendingAction.fileName}"`}</strong> })}</>
          ) : pendingAction?.kind === "restore-backup" ? (
            <>{rich("manage.confirm.restore.msg", { emph: <strong className="text-theme-primary">{t("manage.confirm.restore.emph")}</strong> })}</>
          ) : (
            <>{rich("manage.confirm.reset.msg", { emph: <strong className="text-theme-primary">{t("manage.confirm.reset.emph")}</strong> })}</>
          )
        }
      />

      <ExportPackModal
        isOpen={showExportPack}
        onClose={() => setShowExportPack(false)}
        serverDir={serverDir}
        serverName={serverName}
        serverType={serverType}
        mcVersion={mcVersion}
        isServerStopped={isServerStopped}
      />

      {modBrowserAvailable && mcVersion && (
        <ModBrowserModal
          isOpen={showModBrowser}
          onClose={() => setShowModBrowser(false)}
          serverDir={serverDir}
          serverType={serverType}
          mcVersion={mcVersion}
          onInstalled={loadMods}
        />
      )}
    </div>
  );
}
