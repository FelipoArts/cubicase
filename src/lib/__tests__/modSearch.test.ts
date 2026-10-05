import { describe, it, expect } from "vitest";
import { mergeHits, buildVersionOptions, isPackInstalled } from "../modSearch";
import type { ModrinthSearchHit, ModrinthVersion } from "../modrinth";

const hit = (id: string, title: string, slug = title.toLowerCase(), downloads = 10): ModrinthSearchHit => ({
  project_id: id, slug, title, description: "", author: "", icon_url: null, downloads, project_type: "mod",
});

describe("mergeHits", () => {
  it("junta o mesmo mod das duas fontes", () => {
    const r = mergeHits([], [
      { source: "modrinth", hits: [hit("a", "Sodium")] },
      { source: "curseforge", hits: [hit("1", "Sodium")] },
    ]);
    expect(r).toHaveLength(1);
    expect(Object.keys(r[0].sources).sort()).toEqual(["curseforge", "modrinth"]);
    expect(r[0].downloads).toBe(20);
  });

  it("casa por slug quando o título difere", () => {
    const r = mergeHits([], [
      { source: "modrinth", hits: [hit("a", "Sodium", "sodium")] },
      { source: "curseforge", hits: [hit("1", "Sodium (Fabric)", "sodium")] },
    ]);
    expect(r).toHaveLength(1);
  });

  it("não funde dois mods diferentes da mesma fonte", () => {
    const r = mergeHits([], [{ source: "curseforge", hits: [hit("1", "Map"), hit("2", "Map")] }]);
    expect(r).toHaveLength(2);
  });

  it("anexa fonte a um mod de página anterior e intercala as fontes", () => {
    const first = mergeHits([], [{ source: "modrinth", hits: [hit("a", "A"), hit("b", "B")] }]);
    const r = mergeHits(first, [{ source: "curseforge", hits: [hit("9", "B"), hit("8", "C")] }]);
    expect(r.map((h) => h.title)).toEqual(["A", "B", "C"]);
    expect(r[1].sources.curseforge?.project_id).toBe("9");
  });
});

describe("buildVersionOptions", () => {
  const v = (id: string, url: string): ModrinthVersion => ({
    id, project_id: "p", version_number: id, name: id, game_versions: [], loaders: [], dependencies: [],
    files: [{ url, filename: `${id}.jar`, primary: true, hashes: {} }],
  });
  it("põe Modrinth primeiro e bloqueadas por último", () => {
    const o = buildVersionOptions({ curseforge: [v("c1", ""), v("c2", "u")], modrinth: [v("m1", "u")] });
    expect(o.map((x) => x.key)).toEqual(["modrinth:m1", "curseforge:c2", "curseforge:c1"]);
  });
});

describe("isPackInstalled", () => {
  const installed = new Set(["fabulouslyoptimized", "allthemods9"]);
  it("casa o título da busca com o nome do pack gravado no registro, ignorando pontuação e caixa", () => {
    expect(isPackInstalled("Fabulously Optimized", installed)).toBe(true);
    expect(isPackInstalled("All the Mods 9", installed)).toBe(true);
    expect(isPackInstalled("All The Mods 9 - ATM9", installed)).toBe(true);
  });
  it("não confunde packs diferentes nem títulos curtos demais", () => {
    expect(isPackInstalled("Better MC", installed)).toBe(false);
    expect(isPackInstalled("ATM", installed)).toBe(false);
  });
});
