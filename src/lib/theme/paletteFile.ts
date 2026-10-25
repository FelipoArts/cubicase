"use client";

import {
  MAX_PALETTE_FILE_BYTES, PALETTE_FILE_EXTENSION, exportPalette, importPalette, paletteFileName,
  type Palette,
} from "./palette";

// Exportar e importar paletas como arquivo (.cubicase-palette). No app desktop usa as janelas de salvar/abrir do
// sistema (o plugin de diálogo libera só o arquivo escolhido); no navegador (desenvolvimento) cai no download e no
// seletor de arquivo comuns.

const FILTERS = [{ name: "Paleta do Cubicase", extensions: [PALETTE_FILE_EXTENSION, "json"] }];
const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type ExportResult = "saved" | "cancelled";
export type ImportResult = { ok: true; palette: Palette } | { ok: false; reason: "cancelled" | "invalid" | "too-big" | "error" };

export async function exportPaletteToFile(palette: Palette): Promise<ExportResult> {
  const text = exportPalette(palette);
  const fileName = paletteFileName(palette.name);

  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ title: "Salvar paleta", defaultPath: fileName, filters: FILTERS });
    if (!path) return "cancelled";
    await writeTextFile(path, text);
    return "saved";
  }

  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "saved";
}

function parseText(text: string): ImportResult {
  const palette = importPalette(text);
  return palette ? { ok: true, palette } : { ok: false, reason: "invalid" };
}

export async function importPaletteFromFile(): Promise<ImportResult> {
  try {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile, stat } = await import("@tauri-apps/plugin-fs");
      const path = await open({ title: "Importar paleta", multiple: false, directory: false, filters: FILTERS });
      if (!path || Array.isArray(path)) return { ok: false, reason: "cancelled" };
      if ((await stat(path)).size > MAX_PALETTE_FILE_BYTES) return { ok: false, reason: "too-big" };
      return parseText(await readTextFile(path));
    }

    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = `.${PALETTE_FILE_EXTENSION},.json,application/json`;
      input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
      input.addEventListener("cancel", () => resolve(null), { once: true });
      input.click();
    });
    if (!file) return { ok: false, reason: "cancelled" };
    if (file.size > MAX_PALETTE_FILE_BYTES) return { ok: false, reason: "too-big" };
    return parseText(await file.text());
  } catch {
    return { ok: false, reason: "error" };
  }
}
