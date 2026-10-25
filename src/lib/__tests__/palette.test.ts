import { describe, expect, it } from "vitest";
import {
  BUILTIN_PALETTES, DEFAULT_PALETTE_ID, MAX_CUSTOM_PALETTES, SCALE_STEPS, accentScale, contrast, contrastIssues, deriveTokens, exportPalette,
  hexToHsl, hslToHex, importPalette, isHex, luminance, mix, paletteFileName, readableOn, sanitizeAppearance, sanitizePalette, type Palette,
} from "@/lib/theme/palette";

const base: Palette = { id: "t", name: "Teste", accent: "#0284c7", hue: 205, tint: 0.9 };

describe("cores", () => {
  it("hex ↔ HSL volta ao mesmo valor (com tolerância de arredondamento)", () => {
    for (const hex of ["#4f46e5", "#16a34a", "#ea580c", "#000000", "#ffffff", "#808080"]) {
      const { h, s, l } = hexToHsl(hex);
      const back = hslToHex(h, s, l);
      const d = (a: string, b: string) => Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))));
      expect(d(hex, back)).toBeLessThanOrEqual(1);
    }
  });

  it("contraste: valores de referência do WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(luminance("#000000")).toBe(0);
    expect(readableOn("#facc15")).toBe("#0f172a");
    expect(readableOn("#1e1b4b")).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("isHex só aceita #rrggbb", () => {
    expect(isHex("#a1B2c3")).toBe(true);
    for (const v of ["a1b2c3", "#abc", "#12345g", "rgb(0,0,0)", "", null, 3]) expect(isHex(v)).toBe(false);
  });
});

describe("escala do destaque", () => {
  it("o passo 600 é a cor escolhida e a luminosidade desce do 50 ao 950", () => {
    for (const accent of ["#4f46e5", "#16a34a", "#facc15", "#52525b", "#1e3a8a", "#f5f5f5"]) {
      const scale = accentScale(accent);
      expect(scale[600]).toBe(accent);
      const lums = SCALE_STEPS.map((s) => luminance(scale[s]));
      for (let i = 1; i < lums.length; i++) expect(lums[i], `${accent} passo ${SCALE_STEPS[i]}`).toBeLessThanOrEqual(lums[i - 1] + 1e-9);
    }
  });
});

describe("tokens", () => {
  it("define as variáveis que o app usa e a escala sobrescreve o indigo", () => {
    const t = deriveTokens(base, "dark");
    for (const k of ["--background", "--card-bg", "--card-border", "--muted-bg", "--text-primary", "--text-secondary", "--accent-bg", "--console-bg", "--color-indigo-600", "--color-indigo-50", "--color-indigo-950"]) {
      expect(t[k], k).toMatch(/^(#[0-9a-f]{6}|rgba\()/);
    }
    expect(t["--color-indigo-600"]).toBe("#0284c7");
  });

  it("modo claro é mais claro que o escuro, e o texto sempre contrasta com o fundo", () => {
    for (const p of BUILTIN_PALETTES) {
      const dark = deriveTokens(p, "dark"), light = deriveTokens(p, "light");
      expect(luminance(light["--background"])).toBeGreaterThan(luminance(dark["--background"]));
      expect(contrast(dark["--text-primary"], dark["--background"]), `${p.name} escuro`).toBeGreaterThanOrEqual(7);
      expect(contrast(light["--text-primary"], light["--background"]), `${p.name} claro`).toBeGreaterThanOrEqual(7);
      expect(contrast(dark["--text-secondary"], dark["--card-bg"]), `${p.name} escuro (secundário)`).toBeGreaterThanOrEqual(3);
      expect(contrast(light["--text-secondary"], light["--card-bg"]), `${p.name} claro (secundário)`).toBeGreaterThanOrEqual(3);
    }
  });

  it("tom 0 dá fundos neutros (sem matiz)", () => {
    const t = deriveTokens({ ...base, tint: 0 }, "dark");
    const { r, g, b } = { r: parseInt(t["--background"].slice(1, 3), 16), g: parseInt(t["--background"].slice(3, 5), 16), b: parseInt(t["--background"].slice(5, 7), 16) };
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
  });

  it("sobrescritas manuais valem só no modo em que foram definidas", () => {
    const p: Palette = { ...base, overrides: { dark: { background: "#101010", text: "#fafafa" } } };
    expect(deriveTokens(p, "dark")["--background"]).toBe("#101010");
    expect(deriveTokens(p, "dark")["--text-primary"]).toBe("#fafafa");
    expect(deriveTokens(p, "light")["--background"]).not.toBe("#101010");
  });

  it("o alto contraste de fato é de alto contraste", () => {
    const hc = BUILTIN_PALETTES.find((p) => p.id === "alto-contraste")!;
    expect(contrast(deriveTokens(hc, "dark")["--text-primary"], deriveTokens(hc, "dark")["--background"])).toBeGreaterThanOrEqual(19);
    expect(contrastIssues(hc, "dark")).toEqual([]);
    expect(contrastIssues(hc, "light")).toEqual([]);
  });
});

describe("avisos de legibilidade", () => {
  it("destaque muito claro sobre cartão claro é apontado", () => {
    const issues = contrastIssues({ ...base, accent: "#fde68a" }, "light").map((i) => i.id);
    expect(issues).toContain("accentText");
  });
  it("texto quase igual ao fundo é apontado", () => {
    const issues = contrastIssues({ ...base, overrides: { dark: { text: "#1b1f2a" } } }, "dark").map((i) => i.id);
    expect(issues).toContain("text");
  });
  it("as paletas prontas não têm problemas graves nos dois modos", () => {
    for (const p of BUILTIN_PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const bad = contrastIssues(p, mode).filter((i) => i.id === "text" || i.id === "accentButton");
        expect(bad, `${p.name} ${mode}`).toEqual([]);
      }
    }
  });
});

describe("validação do que vem de fora", () => {
  it("normaliza e rejeita paletas inválidas", () => {
    expect(sanitizePalette({ name: "Boa", accent: "#ABCDEF", hue: 400, tint: 5 })).toMatchObject({ name: "Boa", accent: "#abcdef", hue: 40, tint: 1 });
    expect(sanitizePalette({ name: "x", accent: "vermelho" })).toBeNull();
    expect(sanitizePalette({ name: "   ", accent: "#ffffff" })).toBeNull();
    expect(sanitizePalette(null)).toBeNull();
    expect(sanitizePalette("oi")).toBeNull();
    const p = sanitizePalette({ name: "A\nB".repeat(40), accent: "#ffffff", overrides: { dark: { background: "#000", text: "#111111", extra: "#222222" }, claro: {} } })!;
    expect(p.name).not.toMatch(/[\n]/);
    expect(p.name.length).toBeLessThanOrEqual(40);
    expect(p.overrides).toEqual({ dark: { text: "#111111" } }); // "#000" (curto) e chaves desconhecidas saem
  });

  it("armazenamento corrompido vira o padrão; paleta ativa inexistente também", () => {
    expect(sanitizeAppearance(undefined)).toEqual({ activeId: DEFAULT_PALETTE_ID, custom: [] });
    expect(sanitizeAppearance("lixo")).toEqual({ activeId: DEFAULT_PALETTE_ID, custom: [] });
    expect(sanitizeAppearance({ activeId: "nao-existe", custom: [] }).activeId).toBe(DEFAULT_PALETTE_ID);
    const s = sanitizeAppearance({ activeId: "meu", custom: [{ id: "meu", name: "Minha", accent: "#112233" }, { id: "ruim", name: "x", accent: "nope" }] });
    expect(s.activeId).toBe("meu");
    expect(s.custom.map((c) => c.id)).toEqual(["meu"]);
  });

  it("não deixa uma paleta própria roubar o id de uma pronta, nem passar do limite", () => {
    const s = sanitizeAppearance({ custom: [{ id: "oceano", name: "Fake", accent: "#112233" }] });
    expect(s.custom).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, accent: "#112233" }));
    expect(sanitizeAppearance({ custom: many }).custom).toHaveLength(MAX_CUSTOM_PALETTES);
  });

  it("exportar e importar devolve a mesma paleta (com id novo) e recusa arquivos que não são de paleta", () => {
    const p: Palette = { id: "p-1", name: "Minha", accent: "#112233", hue: 100, tint: 0.5, overrides: { light: { surface: "#fefefe" } } };
    const back = importPalette(exportPalette(p))!;
    expect(back).toMatchObject({ name: "Minha", accent: "#112233", hue: 100, tint: 0.5, overrides: { light: { surface: "#fefefe" } } });
    expect(back.id).not.toBe("p-1");
    expect(importPalette("{}")).toBeNull();
    expect(importPalette("não é json")).toBeNull();
    expect(importPalette(JSON.stringify({ name: "x", accent: "#112233" }))).toBeNull(); // sem a marca do formato
    expect(importPalette("x".repeat(30_000))).toBeNull();
  });
});

describe("arquivo de paleta", () => {
  it("nome do arquivo seguro, com a extensão do Cubicase", () => {
    expect(paletteFileName("Pôr do sol")).toBe("por-do-sol.cubicase-palette");
    expect(paletteFileName("  A/B:C*?\"<>|  ")).toBe("a-b-c.cubicase-palette");
    expect(paletteFileName("***")).toBe("paleta.cubicase-palette");
    expect(paletteFileName("x".repeat(100)).length).toBeLessThanOrEqual(40 + ".cubicase-palette".length);
    expect(paletteFileName("CON")).toBe("con.cubicase-palette"); // com extensão, "con.cubicase-palette" não é um nome reservado do Windows
  });
});
