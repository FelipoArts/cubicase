"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  Loader2,
  ArrowLeft,
  Download,
  WifiOff,
  AlertTriangle,
  CheckCircle2,
  Blocks,
  PackagePlus,
} from "lucide-react";
import { pushDiagnostic } from "@/app/diagnostics";
import { Dropdown } from "@/app/components/Dropdown";
import { Checkbox } from "@/app/components/Checkbox";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { loaderForServerType, MOD_CATEGORIES } from "@/lib/modrinth";
import { MOD_PROVIDERS, MOD_SOURCES, type ModProvider, type ModSource } from "@/lib/modProviders";
import {
  mergeHits,
  buildVersionOptions,
  readInstalledKeys,
  readInstalledPackNames,
  isHitInstalled,
  isPackInstalled,
  type UnifiedHit,
  type VersionOption,
} from "@/lib/modSearch";
import {
  type ModrinthSearchHit,
  type ModrinthVersion,
  type MissingDependency,
  type ModrinthInstallProgress,
  type ModSort,
  type ModCategory,
  type ContentKind,
} from "@/lib/modrinth";
import {
  stageModpack,
  applyStagedModpack,
  discardStagedModpack,
  type StagedModpack,
  type ApplyResult,
  type ConflictStrategy,
} from "@/lib/modpackIntoServer";
import { useT, formatNumber } from "@/i18n";

// ============================================================
// ModBrowserModal
// ============================================================
// Busca e instala mods/plugins da Modrinth e da CurseForge numa lista só, já
// filtrados pela versão do Minecraft e pelo loader do servidor
// (Forge/NeoForge/Fabric/Paper). Ao abrir já mostra os mais populares (sem
// mods só de cliente, quando a fonte informa isso), com ordenação, categorias,
// busca ao digitar e rolagem infinita. Cada item tem um botão de instalar
// direto — escolhe a melhor versão compatível e instala as dependências
// obrigatórias — sem sair da lista; o detalhe continua existindo para quem
// quer escolher a versão. Ver src/lib/modrinth.ts / curseforge.ts para os
// clientes das APIs e src/lib/modSearch.ts para a junção das duas fontes.
// ============================================================

interface ModBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverDir: string;
  serverType: string;
  mcVersion: string;
  onInstalled: () => void;
}

type View = "search" | "detail";

const SEARCH_DEBOUNCE_MS = 350;
const SORTS: ModSort[] = ["popular", "updated", "newest"];

function without<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const emptyCounts = (): Record<ModSource, number> => ({ modrinth: 0, curseforge: 0 });

function SourceBadges({ sources }: { sources: UnifiedHit["sources"] }) {
  return (
    <span className="flex gap-1 flex-shrink-0">
      {MOD_SOURCES.filter((id) => sources[id]).map((id) => (
        <span
          key={id}
          className="px-1.5 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-800/40 text-indigo-700 dark:text-indigo-300 text-[9px] font-bold uppercase tracking-wide"
        >
          {MOD_PROVIDERS[id].label}
        </span>
      ))}
    </span>
  );
}

export function ModBrowserModal({ isOpen, onClose, serverDir, serverType, mcVersion, onInstalled }: ModBrowserModalProps) {
  const { t } = useT();
  useLockBodyScroll(isOpen);

  const loaderInfo = loaderForServerType(serverType);
  const itemsFolder = loaderInfo?.projectType === "plugin" ? "plugins" : "mods";
  const itemsLabel = loaderInfo?.projectType === "plugin" ? "plugin" : "mod";
  const supportsCategories = loaderInfo?.projectType === "mod";
  // Modpacks só existem para loaders de mod (Forge/NeoForge/Fabric), não para plugins.
  const supportsModpacks = loaderInfo?.projectType === "mod";

  // null = ainda checando. A busca usa só as fontes alcançáveis; o aviso de
  // "sem conexão" só aparece quando nenhuma responde.
  const [reachable, setReachable] = useState<Record<ModSource, boolean | null>>({ modrinth: null, curseforge: null });
  const [view, setView] = useState<View>("search");

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ModSort>("popular");
  const [category, setCategory] = useState<ModCategory | null>(null);
  const [kind, setKind] = useState<ContentKind>("mod");
  const isPackKind = kind === "modpack";
  const [hits, setHits] = useState<UnifiedHit[]>([]);
  // Quantos itens já foram carregados / existem no total, por fonte (paginação independente).
  const [loaded, setLoaded] = useState<Record<ModSource, number>>(emptyCounts);
  const [totals, setTotals] = useState<Record<ModSource, number>>(emptyCounts);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selectedProject, setSelectedProject] = useState<UnifiedHit | null>(null);
  const [versionOptions, setVersionOptions] = useState<VersionOption[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [selectedVersionKey, setSelectedVersionKey] = useState<string>("");

  const [missingDeps, setMissingDeps] = useState<MissingDependency[]>([]);
  const [checkedDeps, setCheckedDeps] = useState<Set<string>>(new Set());
  const [loadingDeps, setLoadingDeps] = useState(false);

  // Instalação pelo detalhe (tela cheia de progresso).
  const [installProgress, setInstallProgress] = useState<ModrinthInstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedOk, setInstalledOk] = useState(false);

  // Instalação rápida pelo botão de cada item da lista, por hit.key.
  const [quickProgress, setQuickProgress] = useState<Record<string, ModrinthInstallProgress>>({});
  const [quickErrors, setQuickErrors] = useState<Record<string, string>>({});
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(new Set());
  const [installedPackNames, setInstalledPackNames] = useState<Set<string>>(new Set());

  // Instalação de modpack em duas fases: prepara (baixa e compara) → host decide → aplica.
  const [packFlow, setPackFlow] = useState<{ title: string; staged: StagedModpack } | null>(null);
  const [packStrategy, setPackStrategy] = useState<ConflictStrategy>("keep");
  const [showConflicts, setShowConflicts] = useState(false);
  const [packResult, setPackResult] = useState<{ title: string; result: ApplyResult } | null>(null);

  const searchSeq = useRef(0);
  const installQueue = useRef<Promise<unknown>>(Promise.resolve());
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const busy = !!installProgress || Object.keys(quickProgress).length > 0;

  /**
   * Instalações rodam uma de cada vez: cada uma lê e regrava o
   * cubeforge-mods.json inteiro, e duas em paralelo perderiam registros.
   */
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = installQueue.current.then(job);
    installQueue.current = run.catch(() => undefined);
    return run;
  };

  const refreshInstalled = () => {
    readInstalledKeys(serverDir).then(setInstalledKeys).catch(() => {});
    readInstalledPackNames(serverDir).then(setInstalledPackNames).catch(() => {});
  };

  const resetToSearch = () => {
    setView("search");
    setSelectedProject(null);
    setVersionOptions([]);
    setSelectedVersionKey("");
    setMissingDeps([]);
    setCheckedDeps(new Set());
    setInstallError(null);
    setInstalledOk(false);
  };

  const checkReachability = () => {
    setReachable({ modrinth: null, curseforge: null });
    for (const id of MOD_SOURCES) {
      MOD_PROVIDERS[id].checkReachable().then((ok) => setReachable((prev) => ({ ...prev, [id]: ok })));
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    resetToSearch();
    setQuery("");
    setSort("popular");
    setCategory(null);
    setKind("mod");
    setHits([]);
    setLoaded(emptyCounts());
    setTotals(emptyCounts());
    setSearchError(null);
    setQuickErrors({});
    setPackFlow(null);
    setPackResult(null);
    refreshInstalled();
    checkReachability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const activeSources = MOD_SOURCES.filter((id) => reachable[id] !== false);
  const checking = MOD_SOURCES.some((id) => reachable[id] === null);
  const allOffline = !checking && activeSources.length === 0;
  const unavailableSources = MOD_SOURCES.filter((id) => reachable[id] === false);
  const hasMore = activeSources.some((id) => loaded[id] < totals[id]);

  const runSearch = async (reset = true) => {
    if (!loaderInfo) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    try {
      const sources = reset ? activeSources : activeSources.filter((id) => loaded[id] < totals[id]);
      const results = await Promise.allSettled(
        sources.map((id) =>
          MOD_PROVIDERS[id].search(query, {
            mcVersion,
            serverType,
            offset: reset ? 0 : loaded[id],
            sort,
            kind,
            category: supportsCategories && !isPackKind ? (category ?? undefined) : undefined,
          })
        )
      );
      // Uma busca mais nova (digitou/trocou filtro no meio) já assumiu a tela.
      if (seq !== searchSeq.current) return;

      const pages: { source: ModSource; hits: ModrinthSearchHit[] }[] = [];
      const nextLoaded = reset ? emptyCounts() : { ...loaded };
      const nextTotals = reset ? emptyCounts() : { ...totals };
      results.forEach((r, i) => {
        const id = sources[i];
        if (r.status === "fulfilled") {
          pages.push({ source: id, hits: r.value.hits });
          nextLoaded[id] += r.value.hits.length;
          // A CurseForge informa um total de até 10000 mesmo quando as páginas acabam antes;
          // página vazia = fim, senão a rolagem infinita repetiria a requisição para sempre.
          nextTotals[id] = r.value.hits.length === 0 ? nextLoaded[id] : r.value.totalHits;
        } else {
          console.error(`[${MOD_PROVIDERS[id].label}] Falha na busca:`, r.reason);
        }
      });
      if (pages.length === 0 && sources.length > 0) {
        setSearchError(t("modbrowser.searchFailed"));
        return;
      }
      setHits(mergeHits(reset ? [] : hits, pages));
      setLoaded(nextLoaded);
      setTotals(nextTotals);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  // Busca ao abrir (populares), ao digitar (com atraso) e ao trocar ordem/categoria.
  useEffect(() => {
    if (!isOpen || checking || allOffline) return;
    const id = setTimeout(() => runSearch(true), query.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, checking, allOffline, query, sort, category, kind]);

  // Rolagem infinita: quando o fim da lista aparece, carrega a próxima página.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (view !== "search" || !sentinel || !hasMore || searching) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) runSearch(false);
      },
      { root: scrollRef.current, rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hasMore, searching, hits.length]);

  const handleSelectProject = async (hit: UnifiedHit) => {
    setSelectedProject(hit);
    setView("detail");
    setVersionOptions([]);
    setSelectedVersionKey("");
    setMissingDeps([]);
    setInstallError(null);
    setInstalledOk(false);
    setLoadingVersions(true);
    const sources = MOD_SOURCES.filter((id) => hit.sources[id]);
    const results = await Promise.allSettled(
      sources.map((id) => MOD_PROVIDERS[id].versions(hit.sources[id]!.project_id, mcVersion, serverType, kind))
    );
    const bySource: Partial<Record<ModSource, ModrinthVersion[]>> = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") bySource[sources[i]] = r.value;
      else console.error(`[${MOD_PROVIDERS[sources[i]].label}] Falha ao buscar versões:`, r.reason);
    });
    if (results.every((r) => r.status === "rejected")) setInstallError(t("modbrowser.versionsFailed"));
    const options = buildVersionOptions(bySource);
    setVersionOptions(options);
    if (options.length > 0) setSelectedVersionKey(options[0].key);
    setLoadingVersions(false);
  };

  const selectedOption = versionOptions.find((o) => o.key === selectedVersionKey) ?? null;
  const selectedVersion = selectedOption?.version ?? null;
  const provider = selectedOption ? MOD_PROVIDERS[selectedOption.source] : null;

  useEffect(() => {
    if (!selectedVersion || !provider || isPackKind) {
      setMissingDeps([]);
      return;
    }
    let cancelled = false;
    setLoadingDeps(true);
    provider.missingDependencies(selectedVersion, serverDir)
      .then((deps) => {
        if (cancelled) return;
        setMissingDeps(deps);
        setCheckedDeps(new Set(deps.map((d) => d.projectId)));
      })
      .catch(() => {
        if (!cancelled) setMissingDeps([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDeps(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVersion, serverDir, provider, isPackKind]);

  const toggleDep = (projectId: string) => {
    setCheckedDeps((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  /**
   * Instala as dependências escolhidas e depois a versão em si, tudo da mesma
   * fonte (os ids de dependência pertencem a ela). Compartilhado pelo botão do
   * detalhe e pelo botão de instalar de cada item da lista.
   */
  const installWithDeps = async (
    prov: ModProvider,
    version: ModrinthVersion,
    title: string,
    deps: MissingDependency[],
    onProgress: (p: ModrinthInstallProgress) => void
  ) => {
    let step = 0;
    const totalSteps = deps.length + 1;
    const report = (name: string) => (p: ModrinthInstallProgress) =>
      onProgress({
        status: `(${step}/${totalSteps}) ${name}: ${p.status}`,
        percent: Math.round(((step - 1) / totalSteps) * 100 + p.percent / totalSteps),
      });

    for (const dep of deps) {
      step++;
      const depVersions = await prov.versions(dep.projectId, mcVersion, serverType);
      const depVersion = depVersions.find((v) => v.files[0]?.url);
      if (!depVersion) {
        pushDiagnostic({
          level: "warning",
          source: t("modbrowser.source"),
          title: t("modbrowser.depUnavailable.title", { name: dep.title }),
          message: t("modbrowser.depUnavailable.message", { name: dep.title }),
        });
        continue;
      }
      await prov.install(depVersion, dep.title, serverDir, itemsFolder, report(dep.title));
    }

    step++;
    await prov.install(version, title, serverDir, itemsFolder, report(title));
  };

  /** Fase 1 do modpack: baixa e compara. Em sucesso mostra o resumo; nada foi instalado ainda. */
  const stagePack = async (title: string, version: ModrinthVersion) => {
    setInstallProgress({ status: t("modpackInto.downloadingPack"), percent: 1 });
    try {
      const staged = await stageModpack({ serverDir, serverType, mcVersion, packVersion: version, onProgress: setInstallProgress });
      setPackStrategy("keep");
      setShowConflicts(false);
      setPackFlow({ title, staged });
    } finally {
      setInstallProgress(null);
    }
  };

  /** Fase 2: aplica a decisão do host. */
  const confirmPack = async () => {
    if (!packFlow) return;
    const { title, staged } = packFlow;
    setInstallProgress({ status: t("modpackInto.applying", { done: 0, total: staged.files.length }), percent: 0 });
    try {
      const result = await enqueue(() => applyStagedModpack(staged, packStrategy, setInstallProgress));
      setPackFlow(null);
      setPackResult({ title, result });
      refreshInstalled();
      onInstalled();
    } catch (err) {
      console.error("[Modpack] Falha ao instalar:", err);
      setPackFlow(null);
      setInstallError(String(err));
      pushDiagnostic({ level: "error", source: t("modbrowser.source"), title: t("modbrowser.installFailed", { item: "modpack" }), message: String(err) });
    } finally {
      setInstallProgress(null);
    }
  };

  const cancelPack = () => {
    if (packFlow) discardStagedModpack(packFlow.staged);
    setPackFlow(null);
  };

  const handleInstall = async () => {
    if (!selectedProject || !selectedVersion || !provider) return;
    setInstallError(null);
    if (isPackKind) {
      try {
        await stagePack(selectedProject.title, selectedVersion);
      } catch (err) {
        console.error("[Modpack] Falha ao preparar:", err);
        setInstallError(err instanceof Error ? err.message : String(err));
        pushDiagnostic({ level: "error", source: t("modbrowser.source"), title: t("modbrowser.installFailed", { item: "modpack" }), message: String(err) });
      }
      return;
    }
    try {
      const depsToInstall = missingDeps.filter((d) => checkedDeps.has(d.projectId));
      await enqueue(() => installWithDeps(provider, selectedVersion, selectedProject.title, depsToInstall, setInstallProgress));
      setInstallProgress(null);
      setInstalledOk(true);
      refreshInstalled();
      onInstalled();
    } catch (err) {
      console.error(`[${provider.label}] Falha ao instalar:`, err);
      setInstallProgress(null);
      setInstallError(String(err));
      pushDiagnostic({ level: "error", source: t("modbrowser.source"), title: t("modbrowser.installFailed", { item: itemsLabel }), message: String(err) });
    }
  };

  /**
   * Botão de instalar da lista: sem escolher versão. Pega a mais recente
   * compatível e instalável (Modrinth antes da CurseForge) e instala também as
   * dependências obrigatórias não detectadas — aqui não há checklist; quem quer
   * controlar isso abre o detalhe.
   */
  const handleQuickInstall = async (hit: UnifiedHit) => {
    if (quickProgress[hit.key]) return;
    setQuickErrors((prev) => without(prev, hit.key));
    setQuickProgress((prev) => ({ ...prev, [hit.key]: { status: t("modbrowser.queued"), percent: 0 } }));
    try {
      await enqueue(async () => {
        const sources = MOD_SOURCES.filter((id) => hit.sources[id]);
        const results = await Promise.allSettled(
          sources.map((id) => MOD_PROVIDERS[id].versions(hit.sources[id]!.project_id, mcVersion, serverType))
        );
        const bySource: Partial<Record<ModSource, ModrinthVersion[]>> = {};
        results.forEach((r, i) => {
          if (r.status === "fulfilled") bySource[sources[i]] = r.value;
        });
        if (results.every((r) => r.status === "rejected")) throw new Error(t("modbrowser.versionsFailed"));

        const options = buildVersionOptions(bySource);
        const option = options.find((o) => !o.restricted);
        if (!option) {
          throw new Error(options.length > 0 ? t("modbrowser.restrictedShort") : t("modbrowser.noCompatibleShort"));
        }
        const prov = MOD_PROVIDERS[option.source];
        const deps = await prov.missingDependencies(option.version, serverDir).catch(() => []);
        await installWithDeps(prov, option.version, hit.title, deps, (p) =>
          setQuickProgress((prev) => ({ ...prev, [hit.key]: p }))
        );
      });
      refreshInstalled();
      onInstalled();
    } catch (err) {
      console.error(`[Mods] Falha ao instalar ${hit.title}:`, err);
      setQuickErrors((prev) => ({ ...prev, [hit.key]: err instanceof Error ? err.message : String(err) }));
      pushDiagnostic({ level: "error", source: t("modbrowser.source"), title: t("modbrowser.installFailed", { item: itemsLabel }), message: String(err) });
    } finally {
      setQuickProgress((prev) => without(prev, hit.key));
    }
  };

  /** Botão de instalar de um modpack na lista: pega a versão mais recente compatível e vai para o resumo. */
  const handleQuickPack = async (hit: UnifiedHit) => {
    if (quickProgress[hit.key] || installProgress) return;
    setQuickErrors((prev) => without(prev, hit.key));
    setQuickProgress((prev) => ({ ...prev, [hit.key]: { status: t("modbrowser.loading"), percent: 0 } }));
    try {
      const sources = MOD_SOURCES.filter((id) => hit.sources[id]);
      const results = await Promise.allSettled(
        sources.map((id) => MOD_PROVIDERS[id].versions(hit.sources[id]!.project_id, mcVersion, serverType, "modpack"))
      );
      const bySource: Partial<Record<ModSource, ModrinthVersion[]>> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled") bySource[sources[i]] = r.value;
      });
      if (results.every((r) => r.status === "rejected")) throw new Error(t("modbrowser.versionsFailed"));
      const options = buildVersionOptions(bySource);
      const option = options.find((o) => !o.restricted);
      if (!option) {
        throw new Error(options.length > 0 ? t("modbrowser.restrictedShort") : t("modbrowser.noCompatibleShort"));
      }
      await stagePack(hit.title, option.version);
    } catch (err) {
      console.error(`[Modpack] Falha ao preparar ${hit.title}:`, err);
      setQuickErrors((prev) => ({ ...prev, [hit.key]: err instanceof Error ? err.message : String(err) }));
      pushDiagnostic({ level: "error", source: t("modbrowser.source"), title: t("modbrowser.installFailed", { item: "modpack" }), message: String(err) });
    } finally {
      setQuickProgress((prev) => without(prev, hit.key));
    }
  };

  const handleClose = () => {
    if (busy) return;
    // Fechar com um modpack preparado e não confirmado descarta a área de preparo.
    if (packFlow) cancelPack();
    onClose();
  };

  if (!loaderInfo) return null;

  const allLabels = MOD_SOURCES.map((id) => MOD_PROVIDERS[id].label).join(" / ");

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-2xl max-h-[85vh] bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 flex flex-col gap-5"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center">
                  <PackagePlus className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-theme-primary">{t("modbrowser.title")}</h3>
                  <p className="text-[11px] text-theme-secondary">
                    {loaderInfo.loader.charAt(0).toUpperCase() + loaderInfo.loader.slice(1)} · Minecraft {mcVersion}
                  </p>
                </div>
              </div>
              {!busy && (
                <button
                  onClick={handleClose}
                  className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {installProgress ? (
              <div className="py-8 space-y-4">
                <div className="flex items-center justify-center gap-3">
                  <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                  <span className="font-bold text-theme-primary text-sm">{installProgress.status}</span>
                </div>
                <div className="space-y-2">
                  <div className="w-full h-3 bg-theme-muted rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${installProgress.percent}%` }}
                      className="h-full bg-indigo-600 rounded-full"
                    />
                  </div>
                  <div className="text-right text-[10px] font-bold text-theme-secondary">{t("modpack.installing", { percent: installProgress.percent })}</div>
                </div>
              </div>
            ) : packResult ? (
              <div className="py-8 flex flex-col items-center gap-3 text-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                <p className="text-sm font-bold text-theme-primary">{t("modbrowser.plan.doneTitle", { pack: packResult.title })}</p>
                <p className="text-xs text-theme-secondary">
                  {t("modbrowser.plan.doneSummary", {
                    added: packResult.result.added,
                    replaced: packResult.result.replaced,
                    kept: packResult.result.keptOnConflict,
                    skipped: packResult.result.skipped,
                  })}
                </p>
                {packResult.result.failed.length > 0 && (
                  <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl text-xs text-left max-w-md w-full space-y-1">
                    <p className="font-bold">{t("modbrowser.plan.failedTitle", { count: packResult.result.failed.length })}</p>
                    <ul className="max-h-28 overflow-y-auto custom-scrollbar font-mono text-[11px] space-y-0.5">
                      {packResult.result.failed.map((f) => (
                        <li key={f.name} className="break-all">{f.name}: {f.error}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {packResult.result.backupDir && (
                  <p className="text-[11px] text-theme-secondary break-all max-w-md">
                    {t("modbrowser.plan.backupNote", { folder: packResult.result.backupDir })}
                  </p>
                )}
                <p className="text-xs text-theme-secondary">{t("modbrowser.restartHint")}</p>
                <button
                  type="button"
                  onClick={() => setPackResult(null)}
                  className="h-10 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-bold cursor-pointer"
                >
                  {t("modbrowser.plan.close")}
                </button>
              </div>
            ) : packFlow ? (
              <div className="flex flex-col gap-4 min-h-0 overflow-y-auto custom-scrollbar">
                <div>
                  <p className="text-base font-bold text-theme-primary">{t("modbrowser.plan.title", { pack: packFlow.title })}</p>
                  <p className="text-xs text-theme-secondary mt-0.5">
                    {t("modbrowser.plan.summary", {
                      new: packFlow.staged.counts.new,
                      identical: packFlow.staged.counts.identical,
                      conflict: packFlow.staged.counts.conflict,
                    })}
                  </p>
                </div>

                {packFlow.staged.counts.new === 0 && packFlow.staged.counts.conflict === 0 && packFlow.staged.extraFiles === 0 ? (
                  <p className="p-3 bg-theme-muted border border-theme-card rounded-xl text-xs text-theme-secondary flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-500" />
                    {t("modbrowser.plan.alreadyInstalled")}
                  </p>
                ) : packFlow.staged.counts.conflict === 0 ? (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {t("modbrowser.plan.noConflict")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                      {t("modbrowser.plan.conflictTitle", { count: packFlow.staged.counts.conflict })}
                    </p>
                    {(["keep", "replace"] as const).map((opt) => (
                      <label
                        key={opt}
                        className={`flex items-start gap-3 p-3 rounded-2xl border cursor-pointer transition-colors ${
                          packStrategy === opt
                            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20"
                            : "border-theme-card bg-theme-muted hover:bg-theme-card"
                        }`}
                      >
                        <input
                          type="radio"
                          name="pack-strategy"
                          checked={packStrategy === opt}
                          onChange={() => setPackStrategy(opt)}
                          className="mt-0.5 accent-indigo-600"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-theme-primary">{t(`modbrowser.plan.${opt}`)}</span>
                          <span className="block text-[11px] text-theme-secondary mt-0.5">{t(`modbrowser.plan.${opt}Hint`)}</span>
                        </span>
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() => setShowConflicts((v) => !v)}
                      className="text-xs font-bold text-indigo-600 dark:text-indigo-300 hover:underline cursor-pointer"
                    >
                      {showConflicts
                        ? t("modbrowser.plan.hideList")
                        : t("modbrowser.plan.showList", { count: packFlow.staged.counts.conflict })}
                    </button>
                    {showConflicts && (
                      <ul className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar text-[11px] text-theme-secondary font-mono">
                        {packFlow.staged.files
                          .filter((m) => m.isMod && m.status === "conflict")
                          .map((m) => (
                            <li key={m.entry.filename} className="break-all">
                              {t("modbrowser.plan.conflictRow", {
                                name: m.modId ?? m.entry.filename,
                                have: m.existing?.version ?? t("modbrowser.plan.unknownVersion"),
                                want: m.version ?? t("modbrowser.plan.unknownVersion"),
                              })}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}

                {packFlow.staged.parsed.recoveredViaModrinth > 0 && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-1.5">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    {t("modbrowser.plan.recovered", { count: packFlow.staged.parsed.recoveredViaModrinth })}
                  </p>
                )}

                {packFlow.staged.unresolved.length > 0 && (
                  <p className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl text-xs flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    {t("modbrowser.plan.unresolved", { count: packFlow.staged.unresolved.length })}
                  </p>
                )}

                <p className="text-[11px] text-theme-secondary italic">{t("modbrowser.plan.warn")}</p>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={cancelPack}
                    className="h-11 px-5 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-2xl text-sm font-bold text-theme-secondary cursor-pointer"
                  >
                    {t("modbrowser.plan.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={confirmPack}
                    disabled={packFlow.staged.counts.new === 0 && packFlow.staged.counts.conflict === 0 && packFlow.staged.extraFiles === 0}
                    className="flex-1 h-11 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4" /> {t("modbrowser.plan.confirm")}
                  </button>
                </div>
              </div>
            ) : allOffline ? (
              <div className="py-12 flex flex-col items-center gap-3 text-center">
                <WifiOff className="w-8 h-8 text-theme-secondary" />
                <p className="text-sm font-semibold text-theme-primary">{t("modbrowser.offline.title", { source: allLabels })}</p>
                <p className="text-xs text-theme-secondary max-w-sm">
                  {t("modbrowser.offline.body", { source: allLabels })}
                </p>
                <button
                  type="button"
                  onClick={checkReachability}
                  className="h-9 px-4 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-xs font-bold text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer"
                >
                  {t("modbrowser.retry")}
                </button>
              </div>
            ) : checking ? (
              <div className="py-12 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
              </div>
            ) : view === "search" ? (
              <div className="flex flex-col gap-3 min-h-0">
                {supportsModpacks && (
                  <div className="flex gap-1 p-1 bg-theme-muted border border-theme-card rounded-2xl">
                    {(["mod", "modpack"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => k !== kind && setKind(k)}
                        className={`flex-1 h-8 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                          k === kind ? "bg-indigo-600 text-white shadow-sm" : "text-theme-secondary hover:text-indigo-600"
                        }`}
                      >
                        {k === "mod" ? "Mods" : t("modbrowser.kind.modpacks")}
                      </button>
                    ))}
                  </div>
                )}
                {isPackKind && (
                  <p className="text-[11px] text-theme-secondary">
                    {t("modbrowser.modpack.intro", { mc: mcVersion, loader: loaderInfo.loader })}
                  </p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    runSearch(true);
                  }}
                  className="flex gap-2"
                >
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={isPackKind ? t("modbrowser.modpack.searchPlaceholder") : t("modbrowser.searchPlaceholder", { item: itemsLabel })}
                    className="flex-1 h-11 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={searching}
                    className="h-11 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl flex items-center gap-1.5 text-sm font-bold transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  </button>
                </form>

                <div className="flex items-center gap-2">
                  {supportsCategories && !isPackKind && (
                    <Dropdown
                      value={category ?? "all"}
                      onChange={(v) => setCategory(v === "all" ? null : v)}
                      options={[
                        { value: "all", label: t("modbrowser.cat.all") },
                        ...MOD_CATEGORIES.map((c) => ({ value: c, label: t(`modbrowser.cat.${c}`) })),
                      ]}
                      prefix={t("modbrowser.categoryLabel")}
                      className="flex-1 min-w-0"
                    />
                  )}
                  <Dropdown
                    value={sort}
                    onChange={setSort}
                    options={SORTS.map((o) => ({ value: o, label: t(`modbrowser.sort.${o}`) }))}
                    prefix={t("modbrowser.sortLabel")}
                    disabled={!!query.trim()}
                    title={query.trim() ? t("modbrowser.sort.disabledHint") : undefined}
                    align="right"
                    className={supportsCategories && !isPackKind ? "flex-1 min-w-0" : "w-full"}
                  />
                </div>

                {unavailableSources.length > 0 && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    {t("modbrowser.partialOffline", { source: unavailableSources.map((id) => MOD_PROVIDERS[id].label).join(", ") })}
                  </p>
                )}

                <div ref={scrollRef} className="overflow-y-auto custom-scrollbar space-y-2 min-h-[200px]">
                  {searchError ? (
                    <div className="text-center py-10 text-rose-500 text-sm">{searchError}</div>
                  ) : hits.length === 0 ? (
                    <div className="text-center py-10 text-theme-secondary text-sm">
                      {searching ? (
                        <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                      ) : (
                        <>{t("modbrowser.noResults", { item: isPackKind ? "modpack" : itemsLabel })}</>
                      )}
                    </div>
                  ) : (
                    <>
                      {hits.map((hit) => {
                        const progress = quickProgress[hit.key];
                        const error = quickErrors[hit.key];
                        const installed = !isPackKind && isHitInstalled(hit, installedKeys);
                        return (
                          <div
                            key={hit.key}
                            className="w-full flex items-center gap-2 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-2xl pr-3 transition-colors"
                          >
                            <button
                              type="button"
                              onClick={() => handleSelectProject(hit)}
                              className="flex-1 min-w-0 flex items-center gap-3 pl-4 py-3 text-left cursor-pointer"
                            >
                              {hit.icon_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={hit.icon_url} alt="" className="w-10 h-10 rounded-lg flex-shrink-0 object-cover" />
                              ) : (
                                <div className="w-10 h-10 rounded-lg bg-theme-card border border-theme-card flex items-center justify-center flex-shrink-0">
                                  <Blocks className="w-5 h-5 text-theme-secondary" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <p className="text-sm font-bold text-theme-primary truncate">{hit.title}</p>
                                  <SourceBadges sources={hit.sources} />
                                  {isPackKind && isPackInstalled(hit.title, installedPackNames) && (
                                    <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 text-[9px] font-bold uppercase tracking-wide flex-shrink-0">
                                      {t("modbrowser.plan.packInstalledTag")}
                                    </span>
                                  )}
                                </div>
                                {progress ? (
                                  <div className="mt-1 space-y-1">
                                    <p className="text-[11px] text-indigo-600 dark:text-indigo-300 truncate">{progress.status}</p>
                                    <div className="w-full h-1.5 bg-theme-card rounded-full overflow-hidden">
                                      <div className="h-full bg-indigo-600 rounded-full transition-all" style={{ width: `${progress.percent}%` }} />
                                    </div>
                                  </div>
                                ) : error ? (
                                  <p className="text-[11px] text-rose-500 truncate">{error}</p>
                                ) : (
                                  <p className="text-[11px] text-theme-secondary truncate">{hit.description}</p>
                                )}
                              </div>
                              <div className="text-[10px] font-bold text-theme-secondary flex-shrink-0 hidden sm:block">
                                {t("modbrowser.downloads", { count: formatNumber(hit.downloads) })}
                              </div>
                            </button>
                            {installed && !progress ? (
                              <span
                                className="h-9 px-3 flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0"
                                title={t("modbrowser.installedTag")}
                              >
                                <CheckCircle2 className="w-4 h-4" />
                                <span className="hidden sm:inline">{t("modbrowser.installedTag")}</span>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => (isPackKind ? handleQuickPack(hit) : handleQuickInstall(hit))}
                                disabled={!!progress}
                                title={t("modbrowser.install")}
                                className="h-9 w-9 sm:w-auto sm:px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl flex items-center justify-center gap-1.5 text-xs font-bold transition-colors disabled:opacity-60 cursor-pointer flex-shrink-0"
                              >
                                {progress ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                <span className="hidden sm:inline">{progress ? `${progress.percent}%` : t("modbrowser.install")}</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {hasMore && (
                        <div ref={sentinelRef} className="py-3 flex justify-center h-10">
                          {searching && <Loader2 className="w-4 h-4 text-theme-secondary animate-spin" />}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              selectedProject && (
                <div className="flex flex-col gap-4 min-h-0 overflow-y-auto custom-scrollbar">
                  <button
                    type="button"
                    onClick={resetToSearch}
                    className="flex items-center gap-1.5 text-xs font-bold text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer w-fit"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" /> {t("modbrowser.back")}
                  </button>

                  <div className="flex items-center gap-3">
                    {selectedProject.icon_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={selectedProject.icon_url} alt="" className="w-12 h-12 rounded-xl flex-shrink-0 object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded-xl bg-theme-muted border border-theme-card flex items-center justify-center flex-shrink-0">
                        <Blocks className="w-6 h-6 text-theme-secondary" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-base font-bold text-theme-primary truncate">{selectedProject.title}</p>
                        <SourceBadges sources={selectedProject.sources} />
                      </div>
                      <p className="text-xs text-theme-secondary truncate">{selectedProject.description}</p>
                    </div>
                  </div>

                  {installedOk ? (
                    <div className="py-8 flex flex-col items-center gap-2 text-center">
                      <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                      <p className="text-sm font-bold text-theme-primary">
                        {t("modbrowser.installedOk", { name: selectedProject.title })}
                      </p>
                      <p className="text-xs text-theme-secondary">{t("modbrowser.restartHint")}</p>
                    </div>
                  ) : loadingVersions ? (
                    <div className="py-8 flex justify-center">
                      <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                    </div>
                  ) : versionOptions.length === 0 ? (
                    <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl text-xs flex items-center gap-2.5">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      {t("modbrowser.noCompatible", { mc: mcVersion, loader: loaderInfo.loader, item: itemsLabel })}
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("modbrowser.version")}</label>
                        <select
                          value={selectedVersionKey}
                          onChange={(e) => setSelectedVersionKey(e.target.value)}
                          className="w-full h-11 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent cursor-pointer"
                        >
                          {versionOptions.map((o) => (
                            <option key={o.key} value={o.key}>
                              [{MOD_PROVIDERS[o.source].label}] {o.version.name || o.version.version_number}
                              {o.restricted ? ` — ${t("modbrowser.restrictedTag")}` : ""}
                            </option>
                          ))}
                        </select>
                      </div>

                      {loadingDeps ? (
                        <div className="flex items-center gap-2 text-xs text-theme-secondary">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("modbrowser.checkingDeps")}
                        </div>
                      ) : missingDeps.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                            {t("modbrowser.missingDeps")}
                          </p>
                          <div className="space-y-1.5">
                            {missingDeps.map((dep) => (
                              <label
                                key={dep.projectId}
                                className="flex items-center gap-2.5 bg-theme-muted border border-theme-card rounded-xl px-3 py-2 text-sm cursor-pointer"
                              >
                                <Checkbox checked={checkedDeps.has(dep.projectId)} onChange={() => toggleDep(dep.projectId)} />
                                <span className="text-theme-primary font-semibold">{dep.title}</span>
                              </label>
                            ))}
                          </div>
                          <p className="text-[11px] text-theme-secondary italic">
                            {t("modbrowser.missingDepsHint")}
                          </p>
                        </div>
                      ) : null}

                      {selectedOption?.restricted && provider && (
                        <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl text-xs space-y-2">
                          <p>{t("modbrowser.restricted", { name: selectedProject.title })}</p>
                          {selectedVersion?.manualDownloadUrl && (
                            <button
                              type="button"
                              onClick={() => openExternal(selectedVersion.manualDownloadUrl!)}
                              className="font-bold underline cursor-pointer"
                            >
                              {t("modbrowser.openPage", { source: provider.label })}
                            </button>
                          )}
                        </div>
                      )}

                      {installError && (
                        <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs">
                          {installError}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={handleInstall}
                        disabled={!selectedOption || selectedOption.restricted}
                        className="h-11 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer shadow-md shadow-theme-shadow"
                      >
                        <Download className="w-4 h-4" /> {t("modbrowser.install")}
                      </button>
                    </>
                  )}
                </div>
              )
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
