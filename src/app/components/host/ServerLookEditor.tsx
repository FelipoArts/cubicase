"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Lock, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, type TKey } from "@/i18n";
import { openPlus } from "@/lib/plusUi";
import { ImageError, checkImageFile } from "@/lib/profileImages";
import { normalizeBio } from "@/lib/profileCatalog";
import {
  LOOK_COLORS, LOOK_NOTE_MAX, LOOK_NOTE_MAX_LINES, LOOK_TAGS, LOOK_TAGS_MAX, lookColorHex, serverBannerUrl, type ServerLookView,
} from "@/lib/serverLook";
import { LookApiError, fetchServerLook, removeServerBanner, saveServerLook, uploadServerBanner } from "@/lib/serverLookApi";
import { ImageCropModal } from "@/app/components/ImageCropModal";

interface Props {
  shortCode: string | null;
  /** Cubicase Plus ativo nesta conta: o banner só vale com ele. */
  plusActive: boolean;
}

/**
 * Como o servidor aparece para os amigos (na lista e na tela de detalhes): cor, etiquetas e recado são grátis; o banner é
 * do Plus. Fica dentro das configurações do servidor, mas salva por conta própria (não depende do botão de salvar do
 * formulário, porque vai para a API Central e não para os arquivos do servidor).
 */
export function ServerLookEditor({ shortCode, plusActive }: Props) {
  const { t } = useT();
  const [saved, setSaved] = useState<ServerLookView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  function adopt(look: ServerLookView | null) {
    setSaved(look);
    setColor(look?.color ?? null);
    setTags(look?.tags ?? []);
    setNote(look?.note ?? "");
  }

  useEffect(() => {
    if (!shortCode) return;
    let alive = true;
    setLoaded(false);
    setLoadError(false);
    fetchServerLook(shortCode)
      .then((look) => { if (alive) { adopt(look); setLoaded(true); } })
      .catch(() => { if (alive) { setLoadError(true); setLoaded(true); } });
    return () => { alive = false; };
  }, [shortCode]);

  const cleanNote = normalizeBio(note);
  const dirty = (saved?.color ?? null) !== color
    || JSON.stringify(saved?.tags ?? []) !== JSON.stringify(tags)
    || (saved?.note ?? "") !== cleanNote;
  const noteTooLong = [...cleanNote].length > LOOK_NOTE_MAX;

  const failure = (err: unknown, fallback: TKey) => {
    if (err instanceof LookApiError && err.status === 404) return t("look.error.noServer");
    if (err instanceof LookApiError && err.status === 401) return t("look.banner.needAccount");
    return (err instanceof LookApiError && err.message) || t(fallback);
  };

  async function save() {
    if (!shortCode || noteTooLong) return;
    setStatus("saving");
    setError(null);
    try {
      const look = await saveServerLook(shortCode, { color, tags, note: cleanNote || null });
      adopt(look);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(failure(err, "look.error.generic"));
    }
  }

  function toggleTag(id: string) {
    setStatus("idle");
    setTags((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= LOOK_TAGS_MAX ? cur : [...cur, id]));
  }

  function pickBanner(file: File | undefined) {
    if (!file) return;
    setBannerError(null);
    try {
      checkImageFile(file);
      setCropping(file);
    } catch (err) {
      setBannerError(err instanceof ImageError ? t(`images.error.${err.reason}` as TKey) : t("images.error.generic"));
    }
  }

  async function applyBanner(blob: Blob) {
    if (!shortCode) return;
    try {
      const look = await uploadServerBanner(shortCode, blob);
      setSaved((s) => ({ ...(s ?? { color: null, tags: [], note: null, bannerHash: null }), bannerHash: look?.bannerHash ?? null }));
      setCropping(null);
    } catch (err) {
      throw new Error(failure(err, "images.error.generic"));
    }
  }

  async function dropBanner() {
    if (!shortCode) return;
    setBannerBusy(true);
    setBannerError(null);
    try {
      await removeServerBanner(shortCode);
      setSaved((s) => (s ? { ...s, bannerHash: null } : s));
    } catch (err) {
      setBannerError(failure(err, "images.error.generic"));
    } finally {
      setBannerBusy(false);
    }
  }

  const accent = lookColorHex(color);
  const hasBanner = !!saved?.bannerHash;

  return (
    <div className="rounded-2xl border border-theme-card p-4 space-y-4" style={accent ? { borderColor: `${accent}66` } : undefined}>
      <div>
        <p className="text-sm font-medium text-theme-primary">{t("look.title")}</p>
        <p className="text-[11px] text-theme-secondary mt-0.5">{t("look.hint")}</p>
      </div>

      {!shortCode ? (
        <p className="text-xs text-theme-secondary">{t("look.error.noServer")}</p>
      ) : !loaded ? (
        <p className="text-xs text-theme-secondary flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("look.saving")}</p>
      ) : (
        <>
          {loadError && <p className="text-xs text-amber-600 dark:text-amber-300">{t("look.error.load")}</p>}

          {/* Banner (Plus) */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-[11px] font-bold text-theme-primary">{t("look.banner.label")}</p>
              <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300">Plus</span>
            </div>
            <div className="group/banner relative h-24 rounded-xl overflow-hidden border border-theme-card bg-theme-muted" style={accent ? { backgroundImage: `linear-gradient(135deg, ${accent}55, ${accent}11)` } : undefined}>
              {saved?.bannerHash && plusActive && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={serverBannerUrl(shortCode, saved.bannerHash)} alt="" className="block w-full h-full object-cover" />
              )}
              <button
                type="button"
                onClick={() => (plusActive ? bannerInput.current?.click() : openPlus("custom"))}
                disabled={bannerBusy}
                aria-label={t(hasBanner ? "look.banner.change" : "look.banner.choose")}
                className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-all hover:bg-black/45 hover:opacity-100 focus-visible:bg-black/45 focus-visible:opacity-100 cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white">
                  {plusActive ? <Pencil className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                  {t(!plusActive ? "plus.locked.unlock" : hasBanner ? "look.banner.change" : "look.banner.choose")}
                </span>
              </button>
              {hasBanner && plusActive && (
                <button
                  type="button"
                  onClick={dropBanner}
                  disabled={bannerBusy}
                  title={t("look.banner.remove")}
                  aria-label={t("look.banner.remove")}
                  className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover/banner:opacity-100 focus-visible:opacity-100 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <input ref={bannerInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { pickBanner(e.target.files?.[0]); e.target.value = ""; }} />
            <p className="text-[11px] text-theme-secondary">{t(plusActive ? "look.banner.hint" : "look.banner.plusOnly")}</p>
            {!plusActive && hasBanner && <p className="text-[11px] text-theme-secondary">{t("look.banner.paused")}</p>}
            {bannerError && <p className="text-[11px] text-rose-500">{bannerError}</p>}
          </div>

          {/* Cor */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-theme-primary">{t("look.color.label")}</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("look.color.label")}>
              <button
                type="button"
                role="radio"
                aria-checked={color === null}
                title={t("look.color.none")}
                aria-label={t("look.color.none")}
                onClick={() => { setColor(null); setStatus("idle"); }}
                className={cn("w-9 h-9 rounded-full grid place-items-center border-2 cursor-pointer transition-colors", color === null ? "border-indigo-500" : "border-transparent hover:border-indigo-300")}
              >
                <span className="w-6 h-6 rounded-full border border-dashed border-theme-secondary grid place-items-center">{color === null && <Check className="w-3.5 h-3.5 text-theme-secondary" strokeWidth={3} />}</span>
              </button>
              {LOOK_COLORS.map((c) => {
                const selected = color === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={t(c.labelKey)}
                    aria-label={t(c.labelKey)}
                    onClick={() => { setColor(c.id); setStatus("idle"); }}
                    className={cn("w-9 h-9 rounded-full grid place-items-center border-2 cursor-pointer transition-colors", selected ? "border-indigo-500" : "border-transparent hover:border-indigo-300")}
                  >
                    <span className="w-6 h-6 rounded-full grid place-items-center" style={{ backgroundColor: c.hex }}>{selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={4} />}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Etiquetas */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-theme-primary">{t("look.tags.label")} <span className="font-normal text-theme-secondary">· {t("look.tags.hint")}</span></p>
            <div className="flex flex-wrap gap-1.5">
              {LOOK_TAGS.map((tag) => {
                const on = tags.includes(tag.id);
                const blocked = !on && tags.length >= LOOK_TAGS_MAX;
                return (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={on}
                    disabled={blocked}
                    onClick={() => toggleTag(tag.id)}
                    className={cn(
                      "h-7 rounded-full border px-3 text-[11px] font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40",
                      on ? "border-indigo-500 bg-indigo-500/15 text-indigo-600 dark:text-indigo-300" : "border-theme-card text-theme-secondary hover:border-indigo-300",
                    )}
                  >
                    {t(tag.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Recado */}
          <div className="space-y-1.5">
            <label htmlFor="server-look-note" className="text-[11px] font-bold text-theme-primary">{t("look.note.label")}</label>
            <textarea
              id="server-look-note"
              value={note}
              rows={2}
              maxLength={LOOK_NOTE_MAX * 2}
              placeholder={t("look.note.placeholder")}
              onChange={(e) => {
                const v = e.target.value.replace(/\r\n?/g, "\n");
                if (v.split("\n").length > LOOK_NOTE_MAX_LINES || /\n[^\S\n]*\n/.test(v)) return;
                setNote(v);
                setStatus("idle");
              }}
              className="w-full rounded-xl border border-theme-card bg-transparent px-3 py-2 text-xs leading-relaxed text-theme-primary focus:border-indigo-500 focus:outline-none resize-none"
            />
            <p className={cn("flex justify-between gap-2 text-[11px]", noteTooLong ? "text-rose-500" : "text-theme-secondary")}>
              <span>{t("look.note.hint")}</span>
              <span className="tabular-nums shrink-0">{[...cleanNote].length}/{LOOK_NOTE_MAX}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={status === "saving" || !dirty || noteTooLong}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold transition-colors cursor-pointer"
            >
              {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t(status === "saving" ? "look.saving" : "look.save")}
            </button>
            {status === "saved" && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><Check className="w-3.5 h-3.5" />{t("look.saved")}</span>}
            {status === "error" && error && <span className="text-xs text-rose-500">{error}</span>}
          </div>
        </>
      )}

      <ImageCropModal file={cropping} kind="banner" onCancel={() => setCropping(null)} onApply={applyBanner} />
    </div>
  );
}
