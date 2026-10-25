"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Boxes, X, Loader2, AlertTriangle, Search, Trash2, Download, CheckCircle2, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/app/components/Switch";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useT } from "@/i18n";
import { getPackVersions, searchPackProjects, type ModrinthSearchHit, type PackKind } from "@/lib/modrinth";
import {
  activeLevelName,
  applyResourcePack,
  clearResourcePack,
  deleteDatapack,
  installDatapack,
  listDatapacks,
  readResourcePack,
  setResourcePackRequired,
  toggleDatapack,
  type DatapackInfo,
  type ResourcePackSetting,
} from "@/lib/worldPacks";

// ============================================================
// WorldPacksModal — datapacks (do mundo em uso) e pacote de recursos do servidor
// ============================================================
// Os dois vêm da Modrinth. O datapack é um .zip na pasta do mundo. O pacote de recursos não é hospedado
// pelo Cubicase: o servidor só diz ao jogador a URL do CDN da Modrinth (e o checksum) — ver worldPacks.ts.
// ============================================================

interface Props {
  isOpen: boolean;
  onClose: () => void;
  serverDir: string;
  mcVersion: string;
  isServerStopped: boolean;
}

const errText = (err: unknown) => (typeof err === "string" ? err : err instanceof Error ? err.message : String(err));

function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
    return decodeURIComponent(last);
  } catch {
    return url;
  }
}

function Body({ onClose, serverDir, mcVersion, isServerStopped }: Props) {
  const { t } = useT();
  useLockBodyScroll(true);
  const [tab, setTab] = useState<"datapacks" | "resource">("datapacks");
  const [level, setLevel] = useState("world");
  const [datapacks, setDatapacks] = useState<DatapackInfo[]>([]);
  const [resourcePack, setResourcePack] = useState<ResourcePackSetting | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const kind: PackKind = tab === "datapacks" ? "datapack" : "resourcepack";
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModrinthSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const refresh = useCallback(async () => {
    setLevel(await activeLevelName(serverDir));
    setDatapacks(await listDatapacks(serverDir).catch(() => []));
    setResourcePack(await readResourcePack(serverDir));
  }, [serverDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Busca (com um pequeno atraso ao digitar; respostas atrasadas são descartadas).
  useEffect(() => {
    const seq = ++searchSeq.current;
    setHits(null);
    setSearchError(false);
    const timer = setTimeout(async () => {
      try {
        const r = await searchPackProjects(kind, query, mcVersion);
        if (seq === searchSeq.current) setHits(r.hits);
      } catch {
        if (seq === searchSeq.current) { setHits([]); setSearchError(true); }
      }
    }, query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [kind, query, mcVersion]);

  const run = async (id: string, work: () => Promise<void>, okText?: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await work();
      await refresh();
      if (okText) setMessage({ kind: "ok", text: okText });
    } catch (err) {
      setMessage({ kind: "error", text: errText(err) });
    } finally {
      setBusyId(null);
    }
  };

  const install = (hit: ModrinthSearchHit) =>
    run(hit.project_id, async () => {
      const versions = await getPackVersions(hit.project_id, mcVersion, kind);
      const v = versions[0];
      if (!v) throw new Error(t("packs.noVersion", { mc: mcVersion }));
      if (kind === "datapack") await installDatapack(serverDir, v);
      else await applyResourcePack(serverDir, v, resourcePack?.required ?? false);
    }, kind === "datapack" ? t("packs.dp.restart") : t("packs.rp.restart"));

  const installedNames = new Set(datapacks.map((d) => d.displayName.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ type: "spring", duration: 0.4 }}
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-5"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center"><Boxes className="text-indigo-700 dark:text-indigo-300 w-5 h-5" /></div>
            <h3 className="text-xl font-bold text-theme-primary">{t("packs.title")}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex items-center gap-2 bg-theme-muted p-1 rounded-2xl border border-theme-card w-fit">
          {(["datapacks", "resource"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => { setTab(k); setMessage(null); setQuery(""); }}
              className={cn("px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 transition-all cursor-pointer", tab === k ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary")}
            >
              {k === "datapacks" ? <Boxes className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />} {t(k === "datapacks" ? "packs.tab.datapacks" : "packs.tab.resource")}
            </button>
          ))}
        </div>

        {!isServerStopped && (
          <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {t("packs.stopFirst")}
          </div>
        )}

        {message && (
          <div className={cn("p-3 rounded-xl text-xs flex items-start gap-2 leading-relaxed", message.kind === "ok" ? "bg-theme-accent border border-theme-accent text-theme-primary" : "bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200")}>
            {message.kind === "ok" ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-px" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" />}
            <span>{message.text}</span>
          </div>
        )}

        {tab === "datapacks" ? (
          <div className="space-y-3">
            <p className="text-xs text-theme-secondary leading-relaxed">{t("packs.dp.intro", { world: level })}</p>
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-theme-secondary">{t("packs.dp.installed")}</p>
              {datapacks.length === 0 ? (
                <p className="text-xs text-theme-secondary">{t("packs.dp.none")}</p>
              ) : (
                datapacks.map((d) => (
                  <div key={d.fileName} className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-xl px-3.5 py-2">
                    <p className={cn("text-sm font-semibold truncate", d.enabled ? "text-theme-primary" : "text-theme-secondary line-through")}>
                      {d.displayName} {d.isDir && <span className="text-[10px] font-bold uppercase text-theme-secondary no-underline">({t("packs.dp.folder")})</span>}
                    </p>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {!d.isDir && (
                        <Switch checked={d.enabled} disabled={!isServerStopped || busyId === d.fileName} onChange={() => run(d.fileName, () => toggleDatapack(serverDir, d.fileName))} title={d.enabled ? t("packs.dp.disable") : t("packs.dp.enable")} />
                      )}
                      <button
                        type="button"
                        disabled={!isServerStopped || busyId === d.fileName}
                        onClick={() => run(d.fileName, () => deleteDatapack(serverDir, d.fileName))}
                        title={t("packs.dp.remove")}
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-theme-secondary leading-relaxed">{t("packs.rp.intro")}</p>
            <div className="bg-theme-muted border border-theme-card rounded-2xl p-3.5 space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-theme-secondary">{t("packs.rp.current")}</p>
              {resourcePack ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-theme-primary truncate" title={resourcePack.url}>{fileNameFromUrl(resourcePack.url)}</p>
                    <button
                      type="button"
                      disabled={!isServerStopped || busyId === "rp-clear"}
                      onClick={() => run("rp-clear", () => clearResourcePack(serverDir))}
                      className="h-8 px-3 rounded-lg text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer disabled:opacity-40 flex-shrink-0"
                    >
                      {t("packs.rp.remove")}
                    </button>
                  </div>
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={resourcePack.required}
                      disabled={!isServerStopped}
                      onChange={(e) => run("rp-required", () => setResourcePackRequired(serverDir, e.target.checked))}
                      className="accent-indigo-600"
                    />
                    <span className="text-xs text-theme-primary">{t("packs.rp.required")}</span>
                  </label>
                </>
              ) : (
                <p className="text-xs text-theme-secondary">{t("packs.rp.none")}</p>
              )}
            </div>
          </div>
        )}

        {/* Busca na Modrinth */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 text-theme-secondary absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("packs.search.placeholder")}
              className="w-full h-11 pl-9 pr-3 rounded-xl bg-theme-muted border border-theme-card text-sm text-theme-primary focus:outline-none focus:border-indigo-400"
            />
          </div>
          {hits === null && <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 text-indigo-600 animate-spin" /></div>}
          {hits && searchError && <p className="text-xs text-rose-600 dark:text-rose-300 text-center py-3">{t("packs.search.offline")}</p>}
          {hits && !searchError && hits.length === 0 && <p className="text-xs text-theme-secondary text-center py-3">{t("packs.search.empty", { mc: mcVersion })}</p>}
          {hits && hits.length > 0 && (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
              {hits.map((h) => {
                const already = kind === "datapack" && installedNames.has(h.slug.toLowerCase());
                return (
                  <div key={h.project_id} className="flex items-center gap-3 bg-theme-muted border border-theme-card rounded-2xl px-3.5 py-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {h.icon_url ? <img src={h.icon_url} alt="" className="w-10 h-10 rounded-lg flex-shrink-0 bg-theme-card" /> : <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-theme-card" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-theme-primary truncate">{h.title}</p>
                      <p className="text-[11px] text-theme-secondary truncate">{h.description}</p>
                      <p className="text-[10px] text-theme-secondary">{t("packs.by", { author: h.author })} · {t("packs.downloads", { n: h.downloads.toLocaleString() })}</p>
                    </div>
                    <button
                      type="button"
                      disabled={!isServerStopped || busyId !== null || already}
                      onClick={() => install(h)}
                      className="h-9 px-4 flex-shrink-0 bg-theme-card hover:bg-theme-accent border border-theme-card text-indigo-600 rounded-xl text-xs font-bold transition-all active:scale-95 disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
                    >
                      {busyId === h.project_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : already ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                      {busyId === h.project_id ? t("packs.installing") : already ? t("packs.installed") : kind === "datapack" ? t("packs.install") : t("packs.rp.use")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end pt-3 border-t border-theme-card">
          <button type="button" onClick={onClose} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer">{t("packs.close")}</button>
        </div>
      </motion.div>
    </div>
  );
}

export function WorldPacksModal(props: Props) {
  return <AnimatePresence>{props.isOpen && <Body key="open" {...props} />}</AnimatePresence>;
}
