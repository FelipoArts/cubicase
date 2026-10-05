import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { fetch } from "@tauri-apps/plugin-http";
import { t } from "@/i18n";
import {
  loaderForServerType,
  readModInstallRegistry,
  writeModInstallRegistry,
  type ModrinthSearchHit,
  type ModrinthVersion,
  type ModrinthInstallProgress,
  type ModSearchOptions,
  type ContentKind,
  type ModSort,
  type ModCategory,
} from "@/lib/modrinth";

// ============================================================
// CurseForge — busca, compatibilidade e instalação de mods/plugins
// ============================================================
// Mesma ideia de src/lib/modrinth.ts, e devolve os MESMOS formatos
// (ModrinthSearchHit/ModrinthVersion) para o ModBrowserModal tratar as duas
// fontes de forma uniforme — ver modProviders.ts. A API da CurseForge exige
// API key, que fica só no Worker (api/src/index.ts, secret CURSEFORGE_API_KEY);
// aqui só falamos com o proxy dele, que repassa um allowlist de endpoints.
// ============================================================

const CURSEFORGE_PROXY = "https://cubeforge-api.cubeforge.workers.dev/api/v1/curseforge";
const CACHE_TTL = 5 * 60 * 1000; // 5 min

const MINECRAFT_GAME_ID = 432;
/** classId da CurseForge: 6 = Mods, 5 = Bukkit Plugins. */
const CLASS_MODS = 6;
const CLASS_PLUGINS = 5;
const CLASS_MODPACKS = 4471;
/** ModLoaderType da CurseForge. */
const LOADER_TYPE: Record<string, number> = { forge: 1, fabric: 4, neoforge: 6 };
/** ModsSearchSortField: 2 = Popularity, 3 = LastUpdated, 11 = ReleasedDate. */
const SORT_FIELD: Record<ModSort, number> = { popular: 2, updated: 3, newest: 11 };
/**
 * Slugs de categoria da CurseForge (aba Mods) que correspondem a cada categoria
 * nossa. Os ids numéricos vêm da própria API (resolveCategoryId) em vez de
 * ficarem fixos aqui — se nenhum slug casar, a categoria fica sem resultado
 * na CurseForge em vez de filtrar errado.
 */
const CATEGORY_SLUGS: Record<ModCategory, string[]> = {
  optimization: ["performance", "optimization"],
  technology: ["technology"],
  adventure: ["adventure-rpg", "adventure-and-rpg"],
  magic: ["magic"],
  worldgen: ["world-gen", "worldgen"],
  utility: ["utility-qol", "server-utility"],
};
/** FileRelationType.RequiredDependency */
const RELATION_REQUIRED = 3;
/** HashAlgo.Sha1 */
const HASH_SHA1 = 1;
const PAGE_SIZE = 20;

interface CfPagination {
  index: number;
  pageSize: number;
  resultCount: number;
  totalCount: number;
}

interface CfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  downloadCount: number;
  logo?: { thumbnailUrl?: string; url?: string } | null;
  authors?: { name: string }[];
  links?: { websiteUrl?: string };
}

interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  downloadUrl: string | null;
  releaseType: number; // 1 release, 2 beta, 3 alpha
  fileDate: string;
  hashes?: { algo: number; value: string }[];
  dependencies?: { modId: number; relationType: number }[];
}

async function cfFetch<T>(path: string, signal?: AbortSignal): Promise<{ data: T; pagination?: CfPagination }> {
  const res = await fetch(`${CURSEFORGE_PROXY}${path}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { data: T; pagination?: CfPagination };
}

/**
 * Checa o proxy com timeout curto. Qualquer resposta não-OK (inclusive o 503
 * de "key não configurada no Worker") conta como indisponível, pra UI cair no
 * mesmo aviso de "sem conexão" em vez de mostrar uma lista vazia enganosa.
 */
export async function checkCurseForgeReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await cfFetch(`/v1/mods/search?gameId=${MINECRAFT_GAME_ID}&classId=${CLASS_MODS}&pageSize=1`, controller.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function filterParams(
  mcVersion: string,
  serverType: string,
  kind: ContentKind = "mod"
): { classId: number; params: string } | null {
  const info = loaderForServerType(serverType);
  if (!info) return null;
  if (kind === "modpack") {
    if (info.projectType !== "mod") return null; // não existem modpacks de plugins
    const params = new URLSearchParams({ gameVersion: mcVersion, modLoaderType: String(LOADER_TYPE[info.loader]) });
    return { classId: CLASS_MODPACKS, params: params.toString() };
  }
  const params = new URLSearchParams({ gameVersion: mcVersion });
  // Plugins Bukkit não têm um loader próprio na CurseForge — só filtramos pela versão do MC.
  if (info.projectType === "mod") params.set("modLoaderType", String(LOADER_TYPE[info.loader]));
  return { classId: info.projectType === "plugin" ? CLASS_PLUGINS : CLASS_MODS, params: params.toString() };
}

let categoriesPromise: Promise<{ id: number; slug: string }[]> | null = null;

/** Carrega (uma vez) as categorias de mods da CurseForge. Falha não é cacheada. */
function loadCategories(): Promise<{ id: number; slug: string }[]> {
  categoriesPromise ??= cfFetch<{ id: number; slug: string }[]>(
    `/v1/categories?gameId=${MINECRAFT_GAME_ID}&classId=${CLASS_MODS}`
  )
    .then((r) => r.data)
    .catch((err) => {
      categoriesPromise = null;
      throw err;
    });
  return categoriesPromise;
}

async function resolveCategoryId(category: ModCategory): Promise<number | null> {
  const categories = await loadCategories();
  for (const slug of CATEGORY_SLUGS[category]) {
    const found = categories.find((c) => c.slug === slug);
    if (found) return found.id;
  }
  return null;
}

const searchCache = new Map<string, { hits: ModrinthSearchHit[]; totalHits: number; fetchedAt: number }>();

export async function searchCurseForgeProjects(
  query: string,
  opts: ModSearchOptions
): Promise<{ hits: ModrinthSearchHit[]; totalHits: number }> {
  const kind = opts.kind ?? "mod";
  const filter = filterParams(opts.mcVersion, opts.serverType, kind);
  if (!filter) return { hits: [], totalHits: 0 };

  const sort = opts.sort ?? "popular";
  const category = filter.classId === CLASS_MODS ? opts.category : undefined;
  let categoryId: number | null = null;
  if (category) {
    categoryId = await resolveCategoryId(category);
    if (categoryId === null) return { hits: [], totalHits: 0 };
  }

  const offset = opts.offset ?? 0;
  const cacheKey = `${kind}|${query}|${opts.mcVersion}|${opts.serverType}|${offset}|${sort}|${categoryId ?? ""}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return { hits: cached.hits, totalHits: cached.totalHits };

  const params = new URLSearchParams(filter.params);
  params.set("gameId", String(MINECRAFT_GAME_ID));
  params.set("classId", String(filter.classId));
  params.set("sortField", String(SORT_FIELD[query.trim() ? "popular" : sort]));
  if (categoryId !== null) params.set("categoryId", String(categoryId));
  params.set("sortOrder", "desc");
  params.set("pageSize", String(PAGE_SIZE));
  params.set("index", String(offset));
  if (query.trim()) params.set("searchFilter", query.trim());

  const { data, pagination } = await cfFetch<CfMod[]>(`/v1/mods/search?${params}`);
  const hits: ModrinthSearchHit[] = data.map((m) => ({
    project_id: String(m.id),
    slug: m.slug,
    title: m.name,
    description: m.summary,
    author: m.authors?.[0]?.name ?? "",
    icon_url: m.logo?.thumbnailUrl || m.logo?.url || null,
    downloads: m.downloadCount,
    project_type: kind === "modpack" ? "modpack" : filter.classId === CLASS_PLUGINS ? "plugin" : "mod",
  }));
  const totalHits = pagination?.totalCount ?? hits.length;
  searchCache.set(cacheKey, { hits, totalHits, fetchedAt: Date.now() });
  return { hits, totalHits };
}

const RELEASE_TAG: Record<number, string> = { 2: " [beta]", 3: " [alpha]" };

const versionsCache = new Map<string, { versions: ModrinthVersion[]; fetchedAt: number }>();

/** Arquivos de um mod filtrados por MC + loader, do mais recente ao mais antigo, no formato ModrinthVersion. */
export async function getCurseForgeCompatibleVersions(
  projectId: string,
  mcVersion: string,
  serverType: string,
  kind: ContentKind = "mod"
): Promise<ModrinthVersion[]> {
  const filter = filterParams(mcVersion, serverType, kind);
  if (!filter) return [];

  const cacheKey = `${projectId}|${filter.params}|${filter.classId}`;
  const cached = versionsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.versions;

  const [{ data: files }, manualDownloadUrl] = await Promise.all([
    cfFetch<CfFile[]>(`/v1/mods/${encodeURIComponent(projectId)}/files?${filter.params}&pageSize=50`),
    getCurseForgePageUrl(projectId, filter.classId),
  ]);

  const versions: ModrinthVersion[] = files
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate))
    .map((f) => {
      const sha1 = f.hashes?.find((h) => h.algo === HASH_SHA1)?.value;
      return {
        id: String(f.id),
        project_id: String(f.modId),
        version_number: f.displayName,
        name: f.displayName + (RELEASE_TAG[f.releaseType] ?? ""),
        game_versions: [mcVersion],
        loaders: [],
        dependencies: (f.dependencies ?? [])
          .filter((d) => d.relationType === RELATION_REQUIRED)
          .map((d) => ({ project_id: String(d.modId), version_id: null, dependency_type: "required" as const })),
        // downloadUrl nulo = autor desabilitou distribuição por terceiros.
        files: [{ url: f.downloadUrl ?? "", filename: f.fileName, primary: true, hashes: { sha1 } }],
        manualDownloadUrl,
      };
    });
  versionsCache.set(cacheKey, { versions, fetchedAt: Date.now() });
  return versions;
}

const modCache = new Map<string, { mod: CfMod; fetchedAt: number }>();

async function getMod(projectId: string): Promise<CfMod | null> {
  const cached = modCache.get(projectId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.mod;
  try {
    const res = await fetch(`${CURSEFORGE_PROXY}/v1/mods`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modIds: [Number(projectId)] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: CfMod[] };
    const mod = body.data[0];
    if (!mod) return null;
    modCache.set(projectId, { mod, fetchedAt: Date.now() });
    return mod;
  } catch {
    return null;
  }
}

async function getCurseForgePageUrl(projectId: string, classId: number): Promise<string | undefined> {
  const mod = await getMod(projectId);
  if (!mod) return undefined;
  const section = classId === CLASS_PLUGINS ? "bukkit-plugins" : classId === CLASS_MODPACKS ? "modpacks" : "mc-mods";
  return mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/${section}/${mod.slug}`;
}

/** Título legível de um projeto pelo id (usado para nomear dependências faltando). */
export async function getCurseForgeProjectTitle(projectId: string): Promise<string> {
  return (await getMod(projectId))?.name ?? projectId;
}

/** Baixa o arquivo para a pasta mods/plugins e registra a proveniência — espelha installModrinthFile. */
export async function installCurseForgeFile(
  version: ModrinthVersion,
  projectTitle: string,
  serverDir: string,
  itemsFolder: string,
  onProgress: (p: ModrinthInstallProgress) => void
): Promise<void> {
  const file = version.files[0];
  if (!file) throw new Error(t("modrinth.noFile"));
  if (!file.url) throw new Error(t("curseforge.downloadRestricted", { name: projectTitle }));

  onProgress({ status: t("modrinth.downloading", { file: file.filename }), percent: 20 });
  const destPath = await join(serverDir, itemsFolder, file.filename);
  await invoke("download_server_jar", {
    url: file.url,
    destPath,
    expectedSha1: file.hashes.sha1 ?? null,
    expectedSha256: null,
  });
  onProgress({ status: t("modrinth.downloadDone"), percent: 80 });

  const registry = await readModInstallRegistry(serverDir);
  registry[file.filename] = {
    source: "curseforge",
    projectId: version.project_id,
    versionId: version.id,
    projectTitle,
    versionNumber: version.version_number,
    requiredDependencyProjectIds: version.dependencies.map((d) => d.project_id as string),
  };
  await writeModInstallRegistry(serverDir, registry);
  onProgress({ status: t("modrinth.installedDone"), percent: 100 });
}
