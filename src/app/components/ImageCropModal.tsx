"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Image as ImageIcon, Loader2, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errorMessage";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useT, type TKey } from "@/i18n";
import {
  IMAGE_SPECS, ImageError, MAX_ZOOM, cropCenter, cropRect, drawCrop, loadImageSource, panCenter, renderCrop, rotateSource,
  type ImageKind, type ImageSource,
} from "@/lib/profileImages";

/** Quanto a prévia anda com cada toque nas setas do teclado, em pixels da prévia. */
const KEY_STEP = 12;
const ZOOM_STEP = 0.01;

interface Props {
  /** O arquivo escolhido. Com `null` a janela fica fechada. */
  file: File | null;
  kind: ImageKind;
  onCancel: () => void;
  /** Recebe o WebP final já no tamanho certo. Se lançar um erro, a janela fica aberta e mostra a mensagem. */
  onApply: (blob: Blob) => Promise<void>;
}

/**
 * Janela de ajuste da foto ou do banner: arrastar para posicionar, zoom, girar e redefinir. A prévia e o arquivo enviado
 * usam o mesmo desenho (drawCrop), então o que aparece dentro da moldura é exatamente o que será usado.
 */
export function ImageCropModal({ file, kind, onCancel, onApply }: Props) {
  const { t } = useT();
  const spec = IMAGE_SPECS[kind];
  const isOpen = !!file;
  useLockBodyScroll(isOpen);

  const [source, setSource] = useState<ImageSource | null>(null);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null); // null = o meio da imagem
  const [busy, setBusy] = useState(false);
  // Erro ao ler o arquivo (guarda só o código: o texto é montado na hora de mostrar) e erro ao enviar (já em texto)
  const [loadError, setLoadError] = useState<ImageError["reason"] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const error = loadError ? t(`images.error.${loadError}` as TKey) : sendError;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Prévia: a moldura é a própria imagem final (avatar quadrado; banner 3:1), em resolução maior que a exibida
  const previewW = kind === "avatar" ? 512 : 960;
  const previewH = Math.round((previewW * spec.height) / spec.width);

  // Carrega o arquivo cada vez que a janela abre (só depende do arquivo: depender da função de tradução reiniciava a leitura sem parar)
  useEffect(() => {
    if (!file) { setSource(null); return; }
    let cancelled = false;
    setSource(null); setZoom(1); setCenter(null); setLoadError(null); setSendError(null); setBusy(false);
    loadImageSource(file)
      .then((s) => { if (!cancelled) setSource(s); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof ImageError ? err.reason : "decode"); });
    return () => { cancelled = true; };
  }, [file]);

  const rect = source ? cropRect(source.width, source.height, spec.width, spec.height, zoom, center?.x, center?.y) : null;

  // Redesenha a prévia quando algo muda
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source || !rect) return;
    const ctx = canvas.getContext("2d");
    if (ctx) drawCrop(ctx, source, rect, previewW, previewH);
  }, [source, rect, previewW, previewH]);

  const move = useCallback((dx: number, dy: number) => {
    if (!rect) return;
    const canvas = canvasRef.current;
    const viewW = canvas?.getBoundingClientRect().width || previewW;
    setCenter(panCenter(rect, dx, dy, viewW));
  }, [rect, previewW]);

  function reset() { setZoom(1); setCenter(null); }
  function rotate() {
    if (!source) return;
    setSource(rotateSource(source));
    setCenter(null); // depois de girar, volta a centralizar (o centro antigo não vale na imagem girada)
  }

  async function apply() {
    if (!source || !rect) return;
    setBusy(true);
    setSendError(null);
    try {
      await onApply(await renderCrop(source, rect, kind));
    } catch (err) {
      setSendError(err instanceof ImageError ? t(`images.error.${err.reason}` as TKey) : errorMessage(err) || t("images.error.generic"));
      setBusy(false);
    }
  }

  const title = t("crop.title");
  const canvasClass = cn("block w-full touch-none select-none", kind === "avatar" ? "rounded-3xl" : "rounded-xl");
  // O ponto central permite voltar à posição inicial depois de arrastar
  const centered = !!rect && !!source && Math.abs(cropCenter(rect).x - source.width / 2) < 0.5 && Math.abs(cropCenter(rect).y - source.height / 2) < 0.5;

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busy && onCancel()} className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-lg bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-6 z-10 space-y-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xl font-bold text-theme-primary">{title}</h3>
              <button type="button" onClick={onCancel} disabled={busy} aria-label={t("common.cancel")} className="p-2 rounded-xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted cursor-pointer disabled:opacity-40"><X className="w-5 h-5" /></button>
            </div>

            {/* A moldura: tudo que aparece aqui é o que será enviado */}
            <div className="rounded-2xl bg-theme-muted border border-theme-card p-4 grid place-items-center">
              <div className={cn("relative", kind === "avatar" ? "w-64 max-w-full" : "w-full")}>
                {source ? (
                  <canvas
                    ref={canvasRef}
                    width={previewW}
                    height={previewH}
                    tabIndex={0}
                    role="img"
                    aria-label={t("crop.frame")}
                    className={cn(canvasClass, "cursor-grab active:cursor-grabbing outline-none ring-2 ring-white/80 focus-visible:ring-indigo-400")}
                    onPointerDown={(e) => {
                      drag.current = { x: e.clientX, y: e.clientY };
                      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético: segue sem captura */ }
                    }}
                    onPointerMove={(e) => {
                      if (!drag.current) return;
                      move(e.clientX - drag.current.x, e.clientY - drag.current.y);
                      drag.current = { x: e.clientX, y: e.clientY };
                    }}
                    onPointerUp={() => { drag.current = null; }}
                    onPointerCancel={() => { drag.current = null; }}
                    onWheel={(e) => setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z - e.deltaY * 0.002)))}
                    onKeyDown={(e) => {
                      const step = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] }[e.key];
                      if (step) { e.preventDefault(); move(step[0], step[1]); }
                    }}
                  />
                ) : (
                  <div className="aspect-square grid place-items-center text-theme-secondary" style={kind === "banner" ? { aspectRatio: "3 / 1" } : undefined}>
                    {error ? null : <Loader2 className="w-6 h-6 animate-spin" />}
                  </div>
                )}
              </div>
            </div>
            <p className="text-[11px] text-theme-secondary -mt-2">{t("crop.hint")}</p>

            {/* Zoom e girar */}
            <div className="flex items-center gap-3">
              <ImageIcon className="w-3.5 h-3.5 text-theme-secondary shrink-0" aria-hidden />
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={ZOOM_STEP}
                value={zoom}
                disabled={!source || busy}
                onChange={(e) => setZoom(Number(e.target.value))}
                aria-label={t("crop.zoom")}
                className="flex-1 accent-indigo-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <ImageIcon className="w-5 h-5 text-theme-secondary shrink-0" aria-hidden />
              <button type="button" onClick={rotate} disabled={!source || busy} aria-label={t("crop.rotate")} title={t("crop.rotate")} className="ml-1 p-2 rounded-xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted cursor-pointer disabled:opacity-40"><RotateCw className="w-5 h-5" /></button>
            </div>

            {error && <p className="text-xs text-rose-500" role="alert">{error}</p>}

            <div className="flex items-center justify-between gap-3 pt-3 border-t border-theme-card">
              <button type="button" onClick={reset} disabled={!source || busy || (zoom === 1 && centered)} className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">{t("crop.reset")}</button>
              <div className="flex gap-3">
                <button type="button" onClick={onCancel} disabled={busy} className="px-5 h-11 rounded-2xl bg-theme-muted hover:bg-theme-accent text-theme-primary text-sm font-semibold transition-colors disabled:opacity-40 cursor-pointer">{t("common.cancel")}</button>
                <button type="button" onClick={apply} disabled={!source || busy} className="px-6 h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
                  {busy ? t("crop.applying") : t("crop.apply")}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
