import { readModInstallRegistry, type ModrinthSearchHit, type ModrinthVersion } from "@/lib/modrinth";
import type { ModSource } from "@/lib/modProviders";

// Busca unificada: junta os resultados da Modrinth e da CurseForge numa lista
// só, agrupando o mesmo mod quando ele existe nas duas.

export interface UnifiedHit {
  key: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  sources: Partial<Record<ModSource, ModrinthSearchHit>>;
}

export interface VersionOption {
  key: string;
  source: ModSource;
  version: ModrinthVersion;
  /** CurseForge sem URL de download (autor bloqueou terceiros). */
  restricted: boolean;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Não existe id em comum entre as plataformas, então o casamento é por título
 * ou slug normalizados. É heurístico de propósito conservador: no máximo um hit
 * por fonte por mod (dois mods diferentes da mesma plataforma nunca se fundem)
 * e, na dúvida, o mod aparece duplicado em vez de fundir mods diferentes.
 */
function matches(existing: UnifiedHit, source: ModSource, hit: ModrinthSearchHit): boolean {
  if (existing.sources[source]) return false;
  const title = normalize(hit.title);
  const slug = normalize(hit.slug);
  return Object.values(existing.sources).some(
    (h) => !!h && (normalize(h.title) === title || (!!slug && normalize(h.slug) === slug))
  );
}

/**
 * Acrescenta uma página de resultados de cada fonte à lista, intercalando as
 * fontes (1º de cada, 2º de cada...) para nenhuma dominar o topo. Hits que já
 * existem na lista (de outra fonte, em páginas anteriores ou na mesma) só
 * ganham o selo da nova fonte.
 */
export function mergeHits(
  current: UnifiedHit[],
  pages: { source: ModSource; hits: ModrinthSearchHit[] }[]
): UnifiedHit[] {
  const result = current.map((h) => ({ ...h, sources: { ...h.sources } }));
  const longest = Math.max(0, ...pages.map((p) => p.hits.length));
  for (let i = 0; i < longest; i++) {
    for (const { source, hits } of pages) {
      const hit = hits[i];
      if (!hit) continue;
      const found = result.find((h) => matches(h, source, hit));
      if (found) {
        found.sources[source] = hit;
        found.downloads += hit.downloads;
        found.icon_url ??= hit.icon_url;
      } else {
        result.push({
          key: `${source}:${hit.project_id}`,
          title: hit.title,
          description: hit.description,
          icon_url: hit.icon_url,
          downloads: hit.downloads,
          sources: { [source]: hit },
        });
      }
    }
  }
  return result;
}

const SOURCE_ORDER: ModSource[] = ["modrinth", "curseforge"];

/**
 * Ordena as versões de todas as fontes: instaláveis antes das bloqueadas e
 * Modrinth antes da CurseForge (sem restrição de download e reconhecida pela
 * sincronização de mods com convidados); a ordem interna (mais nova primeiro)
 * de cada fonte é preservada.
 */
export function buildVersionOptions(bySource: Partial<Record<ModSource, ModrinthVersion[]>>): VersionOption[] {
  const options: VersionOption[] = [];
  for (const source of SOURCE_ORDER) {
    for (const version of bySource[source] ?? []) {
      options.push({
        key: `${source}:${version.id}`,
        source,
        version,
        restricted: !version.files[0]?.url,
      });
    }
  }
  return options.sort((a, b) => Number(a.restricted) - Number(b.restricted));
}

/**
 * Conjunto "fonte:projectId" dos mods que o registro local do servidor conhece
 * (instalados pelo navegador de mods ou por import de modpack). Mods colocados
 * à mão na pasta não entram — é "instalado por aqui", não "presente no disco".
 */
export async function readInstalledKeys(serverDir: string): Promise<Set<string>> {
  const registry = await readModInstallRegistry(serverDir);
  return new Set(
    Object.values(registry)
      .filter((r) => r.projectId !== undefined)
      .map((r) => `${r.source ?? "modrinth"}:${r.projectId}`)
  );
}

const normalizePackName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Nomes (normalizados) dos modpacks que já foram instalados neste servidor — o
 * registro guarda o nome do pack em cada mod instalado por ele.
 */
export async function readInstalledPackNames(serverDir: string): Promise<Set<string>> {
  const registry = await readModInstallRegistry(serverDir);
  const names = new Set<string>();
  for (const r of Object.values(registry)) {
    if ("installedViaModpack" in r && r.installedViaModpack) names.add(normalizePackName(r.installedViaModpack));
  }
  return names;
}

/** O título do resultado da busca bate com o nome de um pack já instalado? (nomes do manifest e da busca podem diferir um pouco) */
export function isPackInstalled(title: string, installedPackNames: Set<string>): boolean {
  const t = normalizePackName(title);
  if (t.length < 4) return false;
  for (const name of installedPackNames) {
    if (name === t || (name.length >= 6 && (name.includes(t) || t.includes(name)))) return true;
  }
  return false;
}

export function isHitInstalled(hit: UnifiedHit, installed: Set<string>): boolean {
  return (Object.entries(hit.sources) as [ModSource, ModrinthSearchHit][]).some(([source, h]) =>
    installed.has(`${source}:${h.project_id}`)
  );
}
