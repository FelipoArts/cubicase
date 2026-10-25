// ============================================================
// Paletas de cores do app
// ============================================================
// Uma paleta é pouca coisa: a cor de destaque (accent) e um "tom" para os fundos (matiz + intensidade). Dela se
// derivam, para o modo claro e para o escuro, todas as variáveis que o app já usa (src/app/globals.css) e a escala
// do destaque, que sobrescreve `--color-indigo-*` do Tailwind — todos os botões, abas e realces roxos do app são
// "indigo-*", então trocar essa escala troca o destaque do app inteiro sem tocar nos componentes.
// Cores de estado (verde = ok, âmbar = atenção, vermelho = erro) NÃO mudam com a paleta: significam a mesma coisa
// em qualquer tema.
// Para quem quer controle total, `overrides` sobrescreve cores específicas de cada modo.
// ============================================================

export type Mode = "light" | "dark";

/** Variáveis de cor que uma paleta pode sobrescrever à mão (as demais são derivadas). */
export type TokenKey = "background" | "surface" | "text" | "accent";

export interface Palette {
  id: string;
  name: string;
  builtin?: boolean;
  /** Cor de destaque (#rrggbb). */
  accent: string;
  /** Matiz (0–360) que tinge os fundos; ignorado se `tint` = 0. */
  hue: number;
  /** Intensidade do tom nos fundos, de 0 (cinza puro) a 1. */
  tint: number;
  overrides?: Partial<Record<Mode, Partial<Record<TokenKey, string>>>>;
}

// ---------------- cores ----------------

export interface Rgb { r: number; g: number; b: number }

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** HSL com h em graus e s/l em 0–1. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
export function hslToHex(h: number, s: number, l: number): string {
  const S = Math.min(1, Math.max(0, s)), L = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = L - c / 2;
  return rgbToHex({ r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 });
}

export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** Razão de contraste WCAG (1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Branco ou preto, o que ler melhor sobre `bg`. */
export const readableOn = (bg: string) => (contrast(bg, "#ffffff") >= contrast(bg, "#0f172a") ? "#ffffff" : "#0f172a");

// ---------------- escala do destaque ----------------

export const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const SCALE_L = [0.97, 0.93, 0.86, 0.76, 0.66, 0.57, 0.5, 0.42, 0.35, 0.28, 0.2];

/**
 * Escala 50–950 do destaque, com o passo 600 igual à cor escolhida (é nela que o app mais usa) — os outros passos
 * variam só a luminosidade, mantendo matiz e saturação, como a escala do Tailwind.
 */
export function accentScale(accent: string): Record<number, string> {
  const { h, s, l } = hexToHsl(accent);
  const out: Record<number, string> = { 600: accent.toLowerCase() };
  const at = (step: number, i: number, lightness: number) => {
    // Os extremos claros/escuros perdem saturação para não ficarem "neon".
    const sat = step <= 100 ? s * 0.75 : step >= 900 ? s * 0.7 : s;
    return hslToHex(h, sat, Math.min(0.985, Math.max(0.08, lightness)));
  };
  // Do 500 para o 50: cada passo é mais claro que o anterior. Do 700 para o 950: mais escuro. A saturação reduzida muda a
  // luminância percebida, então se um passo sair fora de ordem ele é empurrado até ficar certo.
  for (let i = 5; i >= 0; i--) {
    const step = SCALE_STEPS[i];
    let target = Math.max(SCALE_L[i], l + 0.02 * (6 - i));
    let hex = at(step, i, target);
    const next = out[SCALE_STEPS[i + 1]];
    while (luminance(hex) < luminance(next) && target < 0.985) { target += 0.01; hex = at(step, i, target); }
    out[step] = hex;
  }
  for (let i = 7; i < SCALE_STEPS.length; i++) {
    const step = SCALE_STEPS[i];
    let target = Math.min(SCALE_L[i], l - 0.02 * (i - 6));
    let hex = at(step, i, target);
    const prev = out[SCALE_STEPS[i - 1]];
    while (luminance(hex) > luminance(prev) && target > 0.08) { target -= 0.01; hex = at(step, i, target); }
    out[step] = hex;
  }
  return out;
}

// ---------------- tokens ----------------

export type Tokens = Record<string, string>;

const NEUTRAL_S = { dark: 0.14, light: 0.18 }; // saturação máxima do tom dos fundos

/** Variáveis CSS para a paleta no modo dado (já com as sobrescritas manuais). */
export function deriveTokens(p: Palette, mode: Mode): Tokens {
  const sat = p.tint * NEUTRAL_S[mode];
  const n = (l: number, extraSat = 1) => hslToHex(p.hue, sat * extraSat, l);
  const o = p.overrides?.[mode] ?? {};
  const dark = mode === "dark";

  const background = o.background ?? (dark ? n(0.1) : n(0.975));
  const surface = o.surface ?? (dark ? n(0.15) : "#ffffff");
  const muted = dark ? mix(surface, "#ffffff", 0.06) : mix(surface, p.tint ? n(0.5) : "#64748b", 0.06);
  const border = dark ? mix(surface, "#ffffff", 0.1) : mix(surface, p.tint ? n(0.4) : "#475569", 0.14);
  const text = o.text ?? (dark ? n(0.92, 0.5) : n(0.1, 0.6));
  const textSecondary = mix(text, background, dark ? 0.35 : 0.4);
  const textMuted = mix(text, background, dark ? 0.55 : 0.6);
  const accent = o.accent ?? p.accent;
  const accentSoft = mix(surface, accent, dark ? 0.14 : 0.1);
  const accentBorder = mix(surface, accent, dark ? 0.3 : 0.22);
  const shadow = (a: number) => `rgba(0, 0, 0, ${dark ? a + 0.3 : a})`;

  return {
    "--background": background,
    "--foreground": text,
    "--card-bg": surface,
    "--card-border": border,
    "--card-shadow": shadow(0.04),
    "--header-bg": hexA(surface, dark ? 0.85 : 0.8),
    "--header-border": hexA(border, 0.8),
    "--sidebar-bg": surface,
    "--sidebar-border": border,
    "--input-bg": dark ? muted : surface,
    "--input-border": dark ? mix(muted, "#ffffff", 0.1) : border,
    "--muted-bg": muted,
    "--muted-border": border,
    "--text-primary": text,
    "--text-secondary": textSecondary,
    "--text-muted": textMuted,
    "--accent-bg": accentSoft,
    "--accent-border": accentBorder,
    "--console-bg": dark ? mix(background, "#000000", 0.45) : "#0f172a",
    "--overlay-bg": dark ? "rgba(0, 0, 0, 0.6)" : "rgba(15, 23, 42, 0.45)",
    "--shadow-color": shadow(0.08),
    "--shadow-color-lg": shadow(0.1),
    "--shadow-color-xl": shadow(0.12),
    "--shadow-color-2xl": shadow(0.15),
    ...Object.fromEntries(Object.entries(accentScale(accent)).map(([step, hex]) => [`--color-indigo-${step}`, hex])),
  };
}

function hexA(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ---------------- avisos de legibilidade ----------------

export interface ContrastIssue { id: "text" | "textSecondary" | "accentButton" | "accentText"; ratio: number; min: number }

/** Combinações que ficam ilegíveis — mostradas no editor, sem impedir o uso. */
export function contrastIssues(p: Palette, mode: Mode): ContrastIssue[] {
  const t = deriveTokens(p, mode);
  const bg = t["--background"], card = t["--card-bg"];
  const accent = t["--color-indigo-600"];
  const checks: ContrastIssue[] = [
    { id: "text", ratio: Math.min(contrast(t["--text-primary"], bg), contrast(t["--text-primary"], card)), min: 4.5 },
    { id: "textSecondary", ratio: contrast(t["--text-secondary"], card), min: 3 },
    // Os botões do app usam texto branco sobre o destaque.
    { id: "accentButton", ratio: contrast(accent, "#ffffff"), min: 4.5 },
    // Títulos e links no destaque sobre o cartão: no escuro o app usa indigo-400, no claro indigo-600.
    { id: "accentText", ratio: contrast(mode === "dark" ? t["--color-indigo-400"] : accent, card), min: 3 },
  ];
  return checks.filter((c) => c.ratio < c.min).map((c) => ({ ...c, ratio: Math.round(c.ratio * 10) / 10 }));
}

// ---------------- paletas prontas ----------------

export const DEFAULT_PALETTE_ID = "cubicase";

export const BUILTIN_PALETTES: Palette[] = [
  { id: DEFAULT_PALETTE_ID, name: "Cubicase", builtin: true, accent: "#4f46e5", hue: 222, tint: 1 },
  { id: "oceano", name: "Oceano", builtin: true, accent: "#0369a1", hue: 205, tint: 0.9 },
  { id: "floresta", name: "Floresta", builtin: true, accent: "#15803d", hue: 150, tint: 0.8 },
  { id: "por-do-sol", name: "Pôr do sol", builtin: true, accent: "#c2410c", hue: 20, tint: 0.7 },
  { id: "rosa", name: "Rosa", builtin: true, accent: "#be185d", hue: 330, tint: 0.7 },
  { id: "violeta", name: "Violeta", builtin: true, accent: "#7c3aed", hue: 265, tint: 0.9 },
  { id: "grafite", name: "Grafite", builtin: true, accent: "#52525b", hue: 0, tint: 0 },
  {
    id: "alto-contraste", name: "Alto contraste", builtin: true, accent: "#a16207", hue: 0, tint: 0,
    overrides: {
      dark: { background: "#000000", surface: "#0a0a0a", text: "#ffffff", accent: "#a16207" },
      light: { background: "#ffffff", surface: "#ffffff", text: "#000000", accent: "#1d4ed8" },
    },
  },
];

// ---------------- armazenamento e validação ----------------

export interface AppearanceState {
  activeId: string;
  custom: Palette[];
}

export const DEFAULT_APPEARANCE: AppearanceState = { activeId: DEFAULT_PALETTE_ID, custom: [] };
export const MAX_CUSTOM_PALETTES = 12;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Valida e normaliza uma paleta vinda de fora (arquivo importado, armazenamento). `null` se não for uma. */
export function sanitizePalette(raw: unknown): Palette | null {
  const r = raw as Partial<Palette> | null;
  if (!r || typeof r !== "object") return null;
  if (!isHex(r.accent)) return null;
  const name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 40) : "";
  if (!name) return null;
  const hue = typeof r.hue === "number" && Number.isFinite(r.hue) ? ((r.hue % 360) + 360) % 360 : 222;
  const tint = typeof r.tint === "number" && Number.isFinite(r.tint) ? clamp(r.tint, 0, 1) : 0.8;

  const overrides: Palette["overrides"] = {};
  for (const mode of ["light", "dark"] as const) {
    const src = r.overrides?.[mode];
    if (!src || typeof src !== "object") continue;
    const clean: Partial<Record<TokenKey, string>> = {};
    for (const key of ["background", "surface", "text", "accent"] as const) {
      if (isHex(src[key])) clean[key] = src[key]!.toLowerCase();
    }
    if (Object.keys(clean).length) overrides[mode] = clean;
  }

  const id = typeof r.id === "string" && /^[a-z0-9-]{1,48}$/.test(r.id) ? r.id : `p-${Math.random().toString(36).slice(2, 10)}`;
  return { id, name, accent: r.accent.toLowerCase(), hue, tint, ...(Object.keys(overrides).length ? { overrides } : {}) };
}

/** Lê o que foi guardado; qualquer coisa estranha vira o padrão (nunca quebra o app). */
export function sanitizeAppearance(raw: unknown): AppearanceState {
  const r = raw as Partial<AppearanceState> | null;
  const custom = Array.isArray(r?.custom)
    ? r!.custom.map(sanitizePalette).filter((p): p is Palette => !!p && !BUILTIN_PALETTES.some((b) => b.id === p.id)).slice(0, MAX_CUSTOM_PALETTES)
    : [];
  const all = [...BUILTIN_PALETTES, ...custom];
  const activeId = typeof r?.activeId === "string" && all.some((p) => p.id === r.activeId) ? r.activeId : DEFAULT_PALETTE_ID;
  return { activeId, custom };
}

export function findPalette(state: AppearanceState, id: string): Palette {
  return [...BUILTIN_PALETTES, ...state.custom].find((p) => p.id === id) ?? BUILTIN_PALETTES[0];
}

/** Arquivo de exportação de uma paleta (para compartilhar com amigos). */
export function exportPalette(p: Palette): string {
  const { id: _id, builtin: _b, ...rest } = p;
  void _id; void _b;
  return JSON.stringify({ cubicasePalette: 1, ...rest }, null, 2);
}

export function importPalette(text: string): Palette | null {
  if (text.length > 20_000) return null;
  try {
    const data = JSON.parse(text);
    if (data?.cubicasePalette !== 1) return null;
    return sanitizePalette({ ...data, id: undefined });
  } catch {
    return null;
  }
}

export const PALETTE_FILE_EXTENSION = "cubicase-palette";
/** Maior arquivo de paleta aceito (uma paleta real tem menos de 1 KB). */
export const MAX_PALETTE_FILE_BYTES = 20_000;

/** Nome de arquivo seguro para a paleta: sem acentos, espaços ou caracteres que o Windows recusa. */
export function paletteFileName(name: string): string {
  const slug = name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "paleta"}.${PALETTE_FILE_EXTENSION}`;
}

export function newPaletteId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
