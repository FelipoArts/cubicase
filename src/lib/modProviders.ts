import {
  checkModrinthReachable,
  searchModrinthProjects,
  getCompatibleVersions,
  resolveRequiredDependencies,
  installModrinthFile,
  type ModrinthSearchHit,
  type ModrinthVersion,
  type MissingDependency,
  type ModrinthInstallProgress,
  type ModSearchOptions,
  type ContentKind,
} from "@/lib/modrinth";
import {
  checkCurseForgeReachable,
  searchCurseForgeProjects,
  getCurseForgeCompatibleVersions,
  getCurseForgeProjectTitle,
  installCurseForgeFile,
} from "@/lib/curseforge";

// Fonte de mods do navegador (ModBrowserModal): as duas implementações falam
// os mesmos tipos (ModrinthSearchHit/ModrinthVersion), então o modal só troca de provider.

export type ModSource = "modrinth" | "curseforge";

export interface ModProvider {
  label: string;
  checkReachable(): Promise<boolean>;
  search(query: string, opts: ModSearchOptions): Promise<{ hits: ModrinthSearchHit[]; totalHits: number }>;
  versions(projectId: string, mcVersion: string, serverType: string, kind?: ContentKind): Promise<ModrinthVersion[]>;
  missingDependencies(version: ModrinthVersion, serverDir: string): Promise<MissingDependency[]>;
  install(
    version: ModrinthVersion,
    projectTitle: string,
    serverDir: string,
    itemsFolder: string,
    onProgress: (p: ModrinthInstallProgress) => void
  ): Promise<void>;
}

export const MOD_SOURCES: ModSource[] = ["modrinth", "curseforge"];

export const MOD_PROVIDERS: Record<ModSource, ModProvider> = {
  modrinth: {
    label: "Modrinth",
    checkReachable: checkModrinthReachable,
    search: searchModrinthProjects,
    versions: getCompatibleVersions,
    missingDependencies: (version, serverDir) => resolveRequiredDependencies(version, serverDir),
    install: installModrinthFile,
  },
  curseforge: {
    label: "CurseForge",
    checkReachable: checkCurseForgeReachable,
    search: searchCurseForgeProjects,
    versions: getCurseForgeCompatibleVersions,
    missingDependencies: (version, serverDir) =>
      resolveRequiredDependencies(version, serverDir, { source: "curseforge", getTitle: getCurseForgeProjectTitle }),
    install: installCurseForgeFile,
  },
};
