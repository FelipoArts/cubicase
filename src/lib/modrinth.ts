import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { t } from "@/i18n";

// ============================================================
// Modrinth — busca, checagem de compatibilidade e instalação de mods/plugins
// ============================================================
// Todas as chamadas de leitura (busca, versões, detalhes de projeto) vão
// direto do frontend via @tauri-apps/plugin-http, seguindo o mesmo padrão
// usado para a Fabric Meta API e a API da PaperMC em src/lib/server.ts. O
// download do arquivo em si reaproveita o comando Rust "download_server_jar"
// (já genérico: url, destPath, expectedSha1, expectedSha256), do mesmo jeito
// que os installers do Forge e as builds do Paper já fazem.
// ============================================================

const MODRINTH_API = "https://api.modrinth.com/v2";

/**
 * User-Agent no formato pedido pelas diretrizes da Modrinth
 * (usuario/projeto/versao (contato)) — requests sem um User-Agent
 * identificável podem ser limitados com mais agressividade.
 */
const MODRINTH_USER_AGENT = "FelipoArts/CubeForge/1.0 (+https://cubeforge.dev; contato: suporte@cubeforge.dev)";

const MODRINTH_CACHE_TTL = 5 * 60 * 1000; // 5 min

export interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url: string | null;
  downloads: number;
  project_type: "mod" | "plugin" | "modpack" | "resourcepack" | "shader" | "datapack";
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
  total_hits: number;
}

export interface ModrinthDependency {
  project_id: string | null;
  version_id: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}

export interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  hashes: { sha1?: string; sha512?: string };
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  version_number: string;
  name: string;
  game_versions: string[];
  loaders: string[];
  dependencies: ModrinthDependency[];
  files: ModrinthVersionFile[];
  /**
   * Só para versões vindas da CurseForge (ver curseforge.ts): página do projeto
   * para download manual, usada quando o autor desabilitou a distribuição por
   * terceiros (arquivo sem URL de download).
   */
  manualDownloadUrl?: string;
}

/** Ordenação e categoria do navegador de mods — comuns às duas fontes. */
export type ModSort = "popular" | "updated" | "newest";
export type ModCategory = "optimization" | "technology" | "adventure" | "magic" | "worldgen" | "utility";
export const MOD_CATEGORIES: ModCategory[] = ["optimization", "technology", "adventure", "magic", "worldgen", "utility"];

/** O que o navegador busca: mods/plugins avulsos ou modpacks prontos. */
export type ContentKind = "mod" | "modpack";

export interface ModSearchOptions {
  /** Padrão "mod". Modpacks só existem para loaders de mod (não para plugins). */
  kind?: ContentKind;
  mcVersion: string;
  serverType: string;
  offset?: number;
  sort?: ModSort;
  /** Só faz sentido para mods (plugins têm categorias próprias, não mapeadas). */
  category?: ModCategory;
}

const MODRINTH_SORT_INDEX: Record<ModSort, string> = { popular: "downloads", updated: "updated", newest: "newest" };

export interface ModrinthLoaderInfo {
  projectType: "mod" | "plugin";
  loader: string;
}

const PLUGIN_LOADER_TYPES = new Set(["paper", "spigot", "purpur", "bukkit"]);
const MOD_LOADER_TYPES = new Set(["forge", "neoforge", "fabric"]);

/**
 * Mapeia o serverType do CubeForge (mesmo conjunto usado em ServerManagePanel.tsx
 * para decidir a pasta "mods" vs "plugins") para o project_type + loader que a
 * API da Modrinth espera. Retorna null para tipos sem suporte a mods/plugins
 * (vanilla) — nesses casos o navegador de mods não deve ser exibido.
 */
export function loaderForServerType(serverType: string): ModrinthLoaderInfo | null {
  if (MOD_LOADER_TYPES.has(serverType)) return { projectType: "mod", loader: serverType };
  if (PLUGIN_LOADER_TYPES.has(serverType)) return { projectType: "plugin", loader: serverType };
  return null;
}

async function modrinthFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": MODRINTH_USER_AGENT }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/**
 * Checa conectividade com a Modrinth com timeout curto, para diferenciar
 * "sem resultados" de "sem internet" na UI (ver checkModrinthReachable em
 * ModBrowserModal.tsx). Mesmo padrão de AbortController+timeout já usado em
 * NeoForgeProviderImpl.fetchVersions (server.ts).
 */
export async function checkModrinthReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${MODRINTH_API}/tag/loader`, {
      headers: { "User-Agent": MODRINTH_USER_AGENT },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ModrinthHashMatch {
  url: string;
  filename: string;
  projectId: string;
  versionId: string;
}

const HASH_LOOKUP_BATCH = 200;

/**
 * Procura na Modrinth arquivos pelo SHA-1. Hash igual = arquivo idêntico, então
 * serve para obter na Modrinth um mod que a CurseForge bloqueia para terceiros.
 * Nunca lança: qualquer falha (sem rede, resposta estranha) só significa "nenhum
 * encontrado" e o chamador segue com o que tem. Chaves do mapa em minúsculas.
 */
export async function lookupModrinthByHashes(sha1s: string[]): Promise<Map<string, ModrinthHashMatch>> {
  const found = new Map<string, ModrinthHashMatch>();
  const unique = [...new Set(sha1s.map((h) => h.toLowerCase()))];
  for (let i = 0; i < unique.length; i += HASH_LOOKUP_BATCH) {
    try {
      const res = await fetch(`${MODRINTH_API}/version_files`, {
        method: "POST",
        headers: { "User-Agent": MODRINTH_USER_AGENT, "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: unique.slice(i, i + HASH_LOOKUP_BATCH), algorithm: "sha1" }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, ModrinthVersion>;
      for (const [hash, version] of Object.entries(data)) {
        const file = version.files.find((f) => f.hashes.sha1?.toLowerCase() === hash.toLowerCase());
        if (file?.url) {
          found.set(hash.toLowerCase(), { url: file.url, filename: file.filename, projectId: version.project_id, versionId: version.id });
        }
      }
    } catch {
      // segue com o que já foi encontrado
    }
  }
  return found;
}

const searchCache: Map<string, { hits: ModrinthSearchHit[]; totalHits: number; fetchedAt: number }> = new Map();

/**
 * Busca projetos na Modrinth já filtrados por versão do Minecraft e loader do
 * servidor via facets — resultados incompatíveis nem chegam a aparecer na
 * lista, então a maior parte da checagem de compatibilidade acontece aqui,
 * de graça.
 */
export async function searchModrinthProjects(
  query: string,
  opts: ModSearchOptions
): Promise<{ hits: ModrinthSearchHit[]; totalHits: number }> {
  const loaderInfo = loaderForServerType(opts.serverType);
  if (!loaderInfo) return { hits: [], totalHits: 0 };

  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? "popular";
  const kind = opts.kind ?? "mod";
  if (kind === "modpack" && loaderInfo.projectType !== "mod") return { hits: [], totalHits: 0 };
  // Categorias de modpack são outras (kitchen-sink, quests...) — não mapeadas.
  const category = loaderInfo.projectType === "mod" && kind === "mod" ? opts.category : undefined;
  const cacheKey = `${kind}|${query}|${opts.mcVersion}|${opts.serverType}|${offset}|${sort}|${category ?? ""}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODRINTH_CACHE_TTL) {
    return { hits: cached.hits, totalHits: cached.totalHits };
  }

  const facetGroups = [
    [`project_type:${kind === "modpack" ? "modpack" : loaderInfo.projectType}`],
    [`versions:${opts.mcVersion}`],
    [`categories:${loaderInfo.loader}`],
  ];
  // Sem isso a lista de populares vira um mar de mods só de cliente (Sodium,
  // minimapas, shaders...) que não servem em servidor. Grupo = OR.
  // Vale também para modpacks: os que são só de cliente (server_side:unsupported) ficam de fora.
  if (loaderInfo.projectType === "mod") facetGroups.push(["server_side:required", "server_side:optional"]);
  if (category) facetGroups.push([`categories:${category}`]);
  const facets = JSON.stringify(facetGroups);
  const index = query.trim() ? "relevance" : MODRINTH_SORT_INDEX[sort];
  const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${index}&limit=20&offset=${offset}`;
  const res = await modrinthFetch(url);
  const data = (await res.json()) as ModrinthSearchResponse;
  searchCache.set(cacheKey, { hits: data.hits, totalHits: data.total_hits, fetchedAt: Date.now() });
  return { hits: data.hits, totalHits: data.total_hits };
}

const versionsCache: Map<string, { versions: ModrinthVersion[]; fetchedAt: number }> = new Map();

/** Lista as versões de um projeto já filtradas por versão do MC + loader do servidor. */
export async function getCompatibleVersions(
  projectId: string,
  mcVersion: string,
  serverType: string
): Promise<ModrinthVersion[]> {
  const loaderInfo = loaderForServerType(serverType);
  if (!loaderInfo) return [];

  const cacheKey = `${projectId}|${mcVersion}|${loaderInfo.loader}`;
  const cached = versionsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODRINTH_CACHE_TTL) return cached.versions;

  const gameVersions = encodeURIComponent(JSON.stringify([mcVersion]));
  const loaders = encodeURIComponent(JSON.stringify([loaderInfo.loader]));
  const url = `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?game_versions=${gameVersions}&loaders=${loaders}`;
  const res = await modrinthFetch(url);
  const versions = (await res.json()) as ModrinthVersion[];
  versionsCache.set(cacheKey, { versions, fetchedAt: Date.now() });
  return versions;
}

const projectTitleCache: Map<string, { title: string; fetchedAt: number }> = new Map();

/** Busca o título legível de um projeto pelo id (usado para nomear dependências faltando). */
export async function getModrinthProjectTitle(projectId: string): Promise<string> {
  const cached = projectTitleCache.get(projectId);
  if (cached && Date.now() - cached.fetchedAt < MODRINTH_CACHE_TTL) return cached.title;
  try {
    const res = await modrinthFetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`);
    const data = (await res.json()) as { title: string };
    projectTitleCache.set(projectId, { title: data.title, fetchedAt: Date.now() });
    return data.title;
  } catch {
    return projectId;
  }
}

// ------------------------------------------------------------
// Registro de proveniência (cubeforge-mods.json)
// ------------------------------------------------------------
// Arquivo próprio por servidor (ao lado de cubicase-meta.json) que só
// registra mods instalados por este navegador — não tenta inferir
// dependências de .jar colocados manualmente. Serve para a checagem de
// dependência "já instalado?" e para uma futura verificação de atualização.

export interface ModInstallRecord {
  /** Ausente em registros antigos — sempre foram da Modrinth. */
  source?: "modrinth" | "curseforge";
  projectId: string;
  versionId: string;
  projectTitle: string;
  versionNumber: string;
  requiredDependencyProjectIds: string[];
}

/**
 * Registro mais enxuto para mods que vieram de um import de modpack (ver
 * src/lib/modpackImport.ts) — nem sempre há um projectId/versionId no
 * formato do Modrinth disponível (o .mrpack só garante URL+hash por arquivo,
 * sem IDs de projeto), então esses campos ficam opcionais.
 */
export interface ModpackInstallRecord {
  source: "curseforge" | "modrinth";
  installedViaModpack: string;
  projectId?: number | string;
  fileOrVersionId?: number | string;
}

/** Registro de mods instalados via Modrinth (busca manual) ou via import de modpack, indexado pelo nome do arquivo .jar. */
export type ModInstallRegistry = Record<string, ModInstallRecord | ModpackInstallRecord>;

export async function readModInstallRegistry(serverDir: string): Promise<ModInstallRegistry> {
  const path = await join(serverDir, "cubeforge-mods.json");
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(await readTextFile(path)) as ModInstallRegistry;
  } catch {
    return {};
  }
}

export async function writeModInstallRegistry(serverDir: string, registry: ModInstallRegistry): Promise<void> {
  const path = await join(serverDir, "cubeforge-mods.json");
  await writeTextFile(path, JSON.stringify(registry, null, 2));
}

export interface MissingDependency {
  projectId: string;
  title: string;
}

/**
 * Cruza as dependências obrigatórias da versão escolhida contra o registro
 * local de instalações feitas por este navegador. Limitação conhecida: mods
 * colocados manualmente na pasta não entram nesse registro, então podem
 * aparecer aqui como "faltando" mesmo já estando presentes — por isso a UI
 * trata isso como "não detectado", não como certeza de ausência.
 */
export async function resolveRequiredDependencies(
  version: ModrinthVersion,
  serverDir: string,
  opts: { source?: "modrinth" | "curseforge"; getTitle?: (projectId: string) => Promise<string> } = {}
): Promise<MissingDependency[]> {
  const source = opts.source ?? "modrinth";
  const getTitle = opts.getTitle ?? getModrinthProjectTitle;
  const required = version.dependencies.filter(
    (d): d is ModrinthDependency & { project_id: string } => d.dependency_type === "required" && !!d.project_id
  );
  if (required.length === 0) return [];

  const registry = await readModInstallRegistry(serverDir);
  // Ids da Modrinth (strings) e da CurseForge (numéricos) vivem no mesmo
  // registro — só vale comparar dentro da mesma origem.
  const installedProjectIds = new Set(
    Object.values(registry)
      .filter((r) => (r.source ?? "modrinth") === source)
      .map((r) => String(r.projectId))
  );
  const missing = required.filter((d) => !installedProjectIds.has(d.project_id));

  return Promise.all(
    missing.map(async (d) => ({
      projectId: d.project_id,
      title: await getTitle(d.project_id),
    }))
  );
}

export interface ModrinthInstallProgress {
  status: string;
  percent: number;
}

/**
 * Baixa o arquivo primário de uma versão para a pasta mods/plugins do
 * servidor (reaproveitando o comando Rust "download_server_jar", que já faz
 * retry, verificação de checksum e cria o diretório de destino se preciso) e
 * grava a proveniência no registro local.
 */
export async function installModrinthFile(
  version: ModrinthVersion,
  projectTitle: string,
  serverDir: string,
  itemsFolder: string,
  onProgress: (p: ModrinthInstallProgress) => void
): Promise<void> {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new Error(t("modrinth.noFile"));

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
    source: "modrinth",
    projectId: version.project_id,
    versionId: version.id,
    projectTitle,
    versionNumber: version.version_number,
    requiredDependencyProjectIds: version.dependencies
      .filter((d) => d.dependency_type === "required" && !!d.project_id)
      .map((d) => d.project_id as string),
  };
  await writeModInstallRegistry(serverDir, registry);
  onProgress({ status: t("modrinth.installedDone"), percent: 100 });
}
