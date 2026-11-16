// ============================================================
// Painel web — aparência (cor de destaque, claro/escuro/automático e tamanho do console)
// ============================================================
// Roda cedo, no <head>, para a página já nascer com as cores escolhidas (sem piscar o tema padrão). A escolha fica só
// neste aparelho (localStorage): não vai para nenhum servidor. Tudo o que vem do armazenamento é conferido antes de
// usar, e qualquer falha de armazenamento (modo privado, bloqueio) simplesmente volta ao padrão.
//
// As cores viram variáveis CSS na <html>:
//   --accent / --accent-hover / --accent-soft(-strong)   a cor escolhida e suas variações
//   --accent-text    a mesma cor, ajustada para ter contraste de leitura sobre o fundo atual (links, botões de texto)
//   --on-accent      cor do texto em cima de botões da cor de destaque (branco ou quase preto, o que ler melhor)
// ============================================================
(function () {
  "use strict";

  var KEY = "cubicase-panel-theme";
  var DEFAULT_ACCENT = "#ff4433";
  var MODES = ["auto", "dark", "light"];
  var SIZES = { small: "11.5px", medium: "12.5px", large: "14.5px", xlarge: "16px" };
  var BG = { dark: "#0a0a0c", light: "#f4f4f7" };
  var SURFACE = { dark: "#17171b", light: "#ffffff" };

  // A mesma paleta usada nos servidores do app (mais o vermelho do Cubicase, que é o padrão).
  var PALETTE = [
    { id: "cubicase", hex: DEFAULT_ACCENT },
    { id: "indigo", hex: "#6366f1" }, { id: "violet", hex: "#8b5cf6" }, { id: "pink", hex: "#ec4899" },
    { id: "rose", hex: "#f43f5e" }, { id: "orange", hex: "#f97316" }, { id: "amber", hex: "#f59e0b" },
    { id: "lime", hex: "#84cc16" }, { id: "emerald", hex: "#10b981" }, { id: "teal", hex: "#14b8a6" },
    { id: "sky", hex: "#0ea5e9" }, { id: "slate", hex: "#64748b" }
  ];

  var HEX = /^#[0-9a-f]{6}$/i;

  function defaults() { return { mode: "auto", accent: null, consoleSize: "medium" }; }

  function read() {
    var out = defaults();
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (raw && typeof raw === "object") {
        if (MODES.indexOf(raw.mode) >= 0) out.mode = raw.mode;
        if (typeof raw.accent === "string" && HEX.test(raw.accent)) out.accent = raw.accent.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(SIZES, raw.consoleSize)) out.consoleSize = raw.consoleSize;
      }
    } catch (e) { /* armazenamento indisponível ou corrompido: padrão */ }
    return out;
  }

  function write(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* vale só nesta sessão */ }
  }

  // ---- cores ----
  function toRgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
  function toHex(rgb) { return "#" + rgb.map(function (v) { var n = Math.max(0, Math.min(255, Math.round(v))); return (n < 16 ? "0" : "") + n.toString(16); }).join(""); }

  function lum(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(hsl) {
    var h = hsl[0], s = hsl[1], l = hsl[2];
    if (s === 0) { var v = l * 255; return [v, v, v]; }
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
  }

  /** Clareia (fundo escuro) ou escurece (fundo claro) a cor até ela ler bem (contraste 4,5:1) sobre o fundo. */
  function readable(hex, mode) {
    var rgb = toRgb(hex), bg = toRgb(SURFACE[mode]);
    if (contrast(rgb, bg) >= 4.5) return hex;
    var hsl = rgbToHsl(rgb), step = mode === "dark" ? 0.03 : -0.03;
    for (var i = 0; i < 30 && contrast(hslToRgb(hsl), bg) < 4.5; i++) hsl[2] = Math.max(0, Math.min(1, hsl[2] + step));
    return toHex(hslToRgb(hsl));
  }

  /** Cor do texto sobre um botão da cor de destaque: a que tiver mais contraste (branco ou quase preto). */
  function onAccent(hex) {
    var rgb = toRgb(hex);
    return contrast(rgb, [255, 255, 255]) >= contrast(rgb, [17, 17, 20]) ? "#ffffff" : "#111114";
  }

  function shade(hex, amount) {
    var hsl = rgbToHsl(toRgb(hex));
    hsl[2] = Math.max(0, Math.min(1, hsl[2] + amount));
    return toHex(hslToRgb(hsl));
  }

  function rgba(hex, a) { var c = toRgb(hex); return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + a + ")"; }

  function resolvedMode(mode) {
    if (mode === "dark" || mode === "light") return mode;
    try { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch (e) { return "dark"; }
  }

  var current = read();

  function apply(state) {
    current = state || current;
    var root = document.documentElement;
    var mode = resolvedMode(current.mode);
    var accent = current.accent || DEFAULT_ACCENT;
    root.setAttribute("data-panel-mode", mode);
    var set = function (k, v) { root.style.setProperty(k, v); };
    set("--accent", accent);
    set("--accent-hover", shade(accent, mode === "dark" ? 0.07 : -0.07));
    set("--accent-soft", rgba(accent, 0.14));
    set("--accent-soft-strong", rgba(accent, 0.28));
    set("--accent-glow", rgba(accent, 0.55));
    set("--accent-text", readable(accent, mode));
    set("--on-accent", onAccent(accent));
    set("--console-size", SIZES[current.consoleSize] || SIZES.medium);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", BG[mode]);
    // O logo escuro é para fundo escuro; no tema claro entra a versão para fundo claro.
    var logos = document.querySelectorAll("img[data-logo]");
    for (var i = 0; i < logos.length; i++) logos[i].setAttribute("src", mode === "light" ? "/assets/logo.png" : "/assets/logo-dark.png");
  }

  function update(partial) {
    var next = read();
    for (var k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) next[k] = partial[k];
    // passa de novo pela validação (read) para nunca guardar valor inválido
    write(next);
    apply(read());
    return current;
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignora */ }
    apply(defaults());
    return current;
  }

  window.CubicasePanelTheme = { read: read, update: update, reset: reset, apply: apply, PALETTE: PALETTE, DEFAULT_ACCENT: DEFAULT_ACCENT, SIZES: SIZES, contrast: contrast, readable: readable, onAccent: onAccent, toRgb: toRgb };

  apply(current);
  try {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var on = function () { if (read().mode === "auto") apply(read()); };
    if (mq.addEventListener) mq.addEventListener("change", on); else if (mq.addListener) mq.addListener(on);
  } catch (e) { /* sem matchMedia */ }
  document.addEventListener("DOMContentLoaded", function () { apply(read()); });
})();
