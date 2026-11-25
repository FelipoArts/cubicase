"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmActionModal } from "@/app/components/host/ConfirmActionModal";
import { Check, ChevronDown, Loader2, Lock, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errorMessage";
import { useAppStore } from "@/app/store";
import { useT, type TKey } from "@/i18n";
import { openPlus } from "@/lib/plusUi";
import { ImageError, checkImageFile, profileImageUrl, removeProfileImage, uploadProfileImage, type ImageKind } from "@/lib/profileImages";
import { ImageCropModal } from "@/app/components/ImageCropModal";
import { deleteMyProfile, getMyProfile, saveMyProfile } from "@/lib/profile";
import { AVATARS, BIO_MAX, BIO_MAX_LINES, COLORS, DEFAULT_AVATAR_ID, DEFAULT_COLOR_ID, DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, colorOf, normalizeBio, ownProfileView } from "@/lib/profileCatalog";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";
import { PlusTierPanel } from "@/app/components/PlusTierPanel";
import { PlusBadge } from "@/app/components/PlusBadge";

type Status = "idle" | "saving" | "saved" | "error" | "deleted";

/**
 * Edição do perfil dentro de Configurações → Conta. O cartão é o mesmo mini perfil que os outros veem, só que editável:
 * o banner e a foto escurecem e mostram um lápis ao passar o mouse (clicar escolhe uma imagem nova), e o nome e a bio
 * são campos no próprio cartão. Só aparece com a conta logada.
 */
export function ProfileEditor() {
  const { t } = useT();
  const profile = useAppStore((s) => s.profile);
  const setProfile = useAppStore((s) => s.setProfile);
  const setPlusStreak = useAppStore((s) => s.setPlusStreak);
  const plusStreak = useAppStore((s) => s.plusStreak);

  const [name, setName] = useState("");
  const [avatarId, setAvatarId] = useState(DEFAULT_AVATAR_ID);
  const [colorId, setColorId] = useState(DEFAULT_COLOR_ID);
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [imgBusy, setImgBusy] = useState<ImageKind | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  // A imagem escolhida que está sendo ajustada na janela (foto ou banner)
  const [cropping, setCropping] = useState<{ kind: ImageKind; file: File } | null>(null);
  const filled = useRef(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  // Foto e banner só valem enquanto o Plus está ativo; sem ele ficam guardados (e voltam ao reassinar).
  const plusActive = plusStreak?.phase === "active";
  const own = profile ? ownProfileView(profile, plusActive) : null;
  const color = colorOf(colorId);
  // Se a imagem do banner não carregar (sem rede, removida pela moderação), volta ao degradê.
  const [bannerFailed, setBannerFailed] = useState<string | null>(null);
  const showBanner = !!own?.bannerHash && bannerFailed !== own.bannerHash;

  /** Clicar na foto ou no banner: com Plus escolhe um arquivo; sem Plus, abre a explicação do Plus. */
  function requestImage(kind: ImageKind) {
    if (!plusActive) { openPlus("custom"); return; }
    if (!profile) { setImgError(t("images.needProfile")); return; }
    setImgError(null);
    (kind === "avatar" ? avatarInput : bannerInput).current?.click();
  }

  /** Escolheu o arquivo: confere e abre a janela de ajuste (arrastar, zoom, girar). O envio é no "Aplicar". */
  function pickImage(kind: ImageKind, file: File | undefined) {
    if (!file) return;
    setImgError(null);
    try {
      checkImageFile(file);
      setCropping({ kind, file });
    } catch (err) {
      setImgError(err instanceof ImageError ? t(`images.error.${err.reason}` as TKey) : t("images.error.generic"));
    }
  }

  /** "Aplicar" na janela de ajuste: envia o recorte. Se falhar, o erro aparece na própria janela. */
  async function applyCrop(blob: Blob) {
    if (!cropping) return;
    const kind = cropping.kind;
    setImgBusy(kind);
    try {
      await uploadProfileImage(kind, blob);
      setCropping(null);
    } finally {
      setImgBusy(null);
    }
  }

  async function dropImage(kind: ImageKind) {
    setImgError(null);
    setImgBusy(kind);
    try { await removeProfileImage(kind); } catch (err) { setImgError(errorMessage(err) || t("images.error.generic")); } finally { setImgBusy(null); }
  }

  // O aviso de erro de imagem some sozinho depois de alguns segundos
  useEffect(() => {
    if (!imgError) return;
    const id = window.setTimeout(() => setImgError(null), 8000);
    return () => window.clearTimeout(id);
  }, [imgError]);

  // Preenche o formulário uma vez: com o perfil salvo, ou com o nome que veio do Google/Discord como sugestão.
  useEffect(() => {
    let cancelled = false;
    getMyProfile()
      .then(({ profile: p, suggestedName, plusStreak: streak }) => {
        if (cancelled || filled.current) return;
        filled.current = true;
        setProfile(p);
        setPlusStreak(streak ?? null);
        setName(p?.displayName ?? suggestedName ?? "");
        setAvatarId(p?.avatarId ?? DEFAULT_AVATAR_ID);
        setColorId(p?.nameColor ?? DEFAULT_COLOR_ID);
        setBio(p?.bio ?? "");
      })
      .catch(() => { /* sem rede: o formulário abre vazio e o salvar mostra o erro */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [setProfile, setPlusStreak]);

  const trimmedLength = [...name.trim()].length;
  const nameOk = trimmedLength >= DISPLAY_NAME_MIN && trimmedLength <= DISPLAY_NAME_MAX;
  // O Worker arruma espaços e quebras de linha da bio; comparar já arrumada evita acender "Salvar" à toa.
  const cleanBio = normalizeBio(bio);
  const bioLength = [...cleanBio].length;
  const dirty = !profile || profile.displayName !== name.trim() || profile.avatarId !== avatarId || (profile.nameColor ?? DEFAULT_COLOR_ID) !== colorId || (profile.bio ?? "") !== cleanBio;

  async function save() {
    if (!nameOk) { setStatus("error"); setError(t("profile.error.length", { min: DISPLAY_NAME_MIN, max: DISPLAY_NAME_MAX })); return; }
    if (bioLength > BIO_MAX) { setStatus("error"); setError(t("profile.bio.tooLong", { max: BIO_MAX })); return; }
    setStatus("saving");
    setError(null);
    try {
      await saveMyProfile({ displayName: name.trim(), avatarId, nameColor: colorId, bio: cleanBio || null });
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err) || t("profile.error.save"));
    }
  }

  async function remove() {
    try {
      await deleteMyProfile();
      setName(""); setAvatarId(DEFAULT_AVATAR_ID); setColorId(DEFAULT_COLOR_ID); setBio("");
      setStatus("deleted");
      setError(null);
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err) || t("profile.error.save"));
    }
  }

  if (loading) {
    return <p className="text-xs text-theme-secondary flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("profile.loading")}</p>;
  }

  /** O lápis (ou o cadeado, sem Plus) que aparece sobre a imagem ao passar o mouse. */
  const overlayIcon = (busy: boolean, className: string) =>
    busy ? <Loader2 className={cn(className, "animate-spin")} /> : plusActive ? <Pencil className={className} /> : <Lock className={className} />;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-bold text-theme-primary">{t("profile.title")}</p>
        <p className="text-[11px] text-theme-secondary">{t("profile.hint")}</p>
      </div>

      <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { pickImage("avatar", e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={bannerInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { pickImage("banner", e.target.files?.[0]); e.target.value = ""; }} />

      {/* O cartão: igual ao mini perfil que os outros veem, mas editável */}
      <div className="rounded-2xl border border-theme-card bg-theme-card shadow-2xl overflow-hidden text-theme-primary">
        {/* Banner: a imagem enviada (Plus) ou o degradê da cor. Ao passar o mouse escurece e mostra o lápis. */}
        <div className={cn("group relative h-24 overflow-hidden", !showBanner && `bg-gradient-to-br ${color.gradient}`)}>
          {showBanner && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={(el) => { if (el?.complete && el.naturalWidth === 0) setBannerFailed(own!.bannerHash); }} // falhou antes de o React ligar o onError
              src={profileImageUrl(own!.bannerHash!)} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" onError={() => setBannerFailed(own!.bannerHash)}
            />
          )}
          <button
            type="button"
            onClick={() => requestImage("banner")}
            disabled={imgBusy === "banner"}
            aria-label={plusActive ? t("images.banner.edit") : t("images.locked")}
            title={plusActive ? t("images.banner.edit") : t("images.locked")}
            className="absolute inset-0 grid place-items-center bg-black/0 hover:bg-black/40 focus-visible:bg-black/40 transition-colors cursor-pointer outline-none"
          >
            <span className={cn("flex items-center gap-2 text-white text-xs font-bold opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity", imgBusy === "banner" && "opacity-100")}>
              {overlayIcon(imgBusy === "banner", "w-5 h-5")}
              {imgBusy === "banner" ? t("images.uploading") : plusActive ? t("images.banner.edit") : t("images.locked")}
            </span>
          </button>
          {/* O aviso de erro de uma imagem aparece aqui, onde a pessoa está olhando (some sozinho) */}
          {imgError && (
            <p role="alert" className="absolute inset-x-0 top-0 z-10 bg-rose-600/95 text-white text-xs font-semibold px-3 py-1.5 text-center">{imgError}</p>
          )}
          {profile?.bannerHash && plusActive && (
            <button
              type="button"
              onClick={() => void dropImage("banner")}
              disabled={imgBusy === "banner"}
              aria-label={t("images.banner.remove")}
              title={t("images.banner.remove")}
              className="absolute top-2 right-2 w-7 h-7 rounded-full grid place-items-center bg-black/50 hover:bg-rose-600 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all cursor-pointer"
            ><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="px-4 pb-4">
          <div className="-mt-8 flex items-end justify-between gap-2">
            {/* Foto: ao passar o mouse escurece e mostra o lápis; clicar escolhe uma nova. relative: fica acima da faixa. */}
            <span className="relative rounded-3xl p-1 bg-theme-card">
              <span className="group/avatar relative block rounded-3xl overflow-hidden">
                <ProfileAvatar avatarId={avatarId} colorId={colorId} imageHash={own?.avatarHash} size="lg" />
                <button
                  type="button"
                  onClick={() => requestImage("avatar")}
                  disabled={imgBusy === "avatar"}
                  aria-label={plusActive ? t("images.avatar.edit") : t("images.locked")}
                  title={plusActive ? t("images.avatar.edit") : t("images.locked")}
                  className="absolute inset-0 grid place-items-center bg-black/0 hover:bg-black/45 focus-visible:bg-black/45 transition-colors cursor-pointer outline-none"
                >
                  <span className={cn("text-white opacity-0 group-hover/avatar:opacity-100 group-focus-within/avatar:opacity-100 transition-opacity", imgBusy === "avatar" && "opacity-100")}>
                    {overlayIcon(imgBusy === "avatar", "w-5 h-5")}
                  </span>
                </button>
              </span>
              {profile?.avatarHash && plusActive && (
                <button
                  type="button"
                  onClick={() => void dropImage("avatar")}
                  disabled={imgBusy === "avatar"}
                  aria-label={t("images.avatar.remove")}
                  title={t("images.avatar.remove")}
                  className="absolute -top-1 -right-1 w-6 h-6 rounded-full grid place-items-center bg-theme-card border border-theme-card text-theme-secondary hover:text-white hover:bg-rose-600 hover:border-rose-600 shadow transition-colors cursor-pointer"
                ><X className="w-3.5 h-3.5" /></button>
              )}
            </span>
            {plusActive && plusStreak?.tier && <span className="pb-1"><PlusBadge tier={plusStreak.tier} /></span>}
          </div>

          {/* O nome e a bio são campos no próprio cartão; a borda aparece ao passar o mouse e ao editar */}
          <label htmlFor="profile-name" className="sr-only">{t("profile.name.label")}</label>
          <input
            id="profile-name"
            type="text"
            value={name}
            maxLength={DISPLAY_NAME_MAX + 10}
            onChange={(e) => { setName(e.target.value); setStatus("idle"); }}
            placeholder={t("profile.name.placeholder")}
            className="mt-2 w-full -mx-2 px-2 py-1 rounded-lg text-lg font-bold leading-tight bg-transparent border border-transparent hover:border-theme-card focus:border-indigo-500 focus:outline-none transition-colors placeholder:text-theme-secondary placeholder:font-semibold"
            style={{ color: color.hex, width: "calc(100% + 1rem)" }}
          />
          <p className="text-[11px] text-theme-secondary mt-0.5">{t("profile.name.hint", { min: DISPLAY_NAME_MIN, max: DISPLAY_NAME_MAX })}</p>

          <label htmlFor="profile-bio" className="sr-only">{t("profile.bio.label")}</label>
          <textarea
            id="profile-bio"
            value={bio}
            rows={3}
            maxLength={BIO_MAX * 2}
            onChange={(e) => {
              // Quebra de linha vale, mas só até BIO_MAX_LINES linhas (sem empilhar linhas em branco).
              const v = e.target.value.replace(/\r\n?/g, "\n");
              if (v.split("\n").length > BIO_MAX_LINES || /\n[^\S\n]*\n/.test(v)) return;
              setBio(v);
              setStatus("idle");
            }}
            placeholder={t("profile.bio.placeholder")}
            className="mt-2 w-full px-2 py-1.5 rounded-lg text-xs leading-relaxed text-theme-secondary bg-transparent border border-transparent hover:border-theme-card focus:border-indigo-500 focus:text-theme-primary focus:outline-none transition-colors resize-none"
            style={{ marginLeft: "-0.5rem", width: "calc(100% + 1rem)" }}
          />
          <p className={cn("flex justify-between gap-2 text-[11px]", bioLength > BIO_MAX ? "text-rose-500" : "text-theme-secondary")}>
            <span>{t("profile.bio.hint")}</span>
            <span className="tabular-nums shrink-0">{bioLength}/{BIO_MAX}</span>
          </p>

          {plusStreak && <div className="mt-3"><PlusTierPanel streak={plusStreak} /></div>}
        </div>
      </div>

      {/* Avisos sobre as imagens */}
      {!plusActive && <p className="text-[11px] text-theme-secondary">{t("images.plusOnly")}</p>}
      {!plusActive && (profile?.avatarHash || profile?.bannerHash) && <p className="text-[11px] text-theme-secondary">{t("images.paused")}</p>}
      {plusActive && !profile && <p className="text-[11px] text-amber-600 dark:text-amber-300">{t("images.needProfile")}</p>}
      {plusActive && <p className="text-[11px] text-theme-secondary">{t("images.hint")}</p>}

      <div className="rounded-2xl border border-theme-card">
        <button
          type="button"
          onClick={() => setLookOpen((v) => !v)}
          aria-expanded={lookOpen}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer rounded-2xl hover:bg-theme-muted transition-colors"
        >
          <span className="text-xs font-bold text-theme-primary">{t("profile.look.toggle")}</span>
          <ChevronDown className={cn("w-4 h-4 text-theme-secondary transition-transform", lookOpen && "rotate-180")} aria-hidden />
        </button>
        {lookOpen && (
          <div className="px-4 pb-4 space-y-4">
      <div className="space-y-1.5">
        <p className="text-[11px] font-bold text-theme-primary">{t("profile.avatar.label")}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("profile.avatar.label")}>
          {AVATARS.map((a) => {
            const selected = avatarId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(a.labelKey)}
                title={t(a.labelKey)}
                onClick={() => { setAvatarId(a.id); setStatus("idle"); }}
                className={cn("rounded-2xl p-0.5 border-2 cursor-pointer transition-colors", selected ? "border-indigo-500" : "border-transparent hover:border-indigo-300")}
              >
                <ProfileAvatar avatarId={a.id} colorId={colorId} size="md" />
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-bold text-theme-primary">{t("profile.color.label")}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("profile.color.label")}>
          {COLORS.map((c) => {
            const selected = colorId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(c.labelKey)}
                title={t(c.labelKey)}
                onClick={() => { setColorId(c.id); setStatus("idle"); }}
                className={cn("w-9 h-9 rounded-full grid place-items-center border-2 cursor-pointer transition-colors", selected ? "border-indigo-500" : "border-transparent hover:border-indigo-300")}
              >
                <span className="w-6 h-6 rounded-full grid place-items-center" style={{ backgroundColor: c.hex }}>{selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={4} />}</span>
              </button>
            );
          })}
        </div>
      </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={status === "saving" || !dirty}
          className="h-10 px-5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-xl transition-colors cursor-pointer"
        >
          {status === "saving" ? t("profile.saving") : t("profile.save")}
        </button>
        {profile && (
          <button type="button" onClick={() => setConfirmingDelete(true)} className="text-xs font-semibold text-rose-500 hover:text-rose-600 transition-colors cursor-pointer">{t("profile.delete")}</button>
        )}
        {status === "saved" && <p className="text-[11px] text-emerald-600" role="status">{t("profile.saved")}</p>}
        {status === "deleted" && <p className="text-[11px] text-emerald-600" role="status">{t("profile.deleted")}</p>}
      </div>
      {status === "error" && error && <p className="text-[11px] text-rose-500" role="alert">{error}</p>}

      {/* Ajuste da imagem escolhida (arrastar, zoom, girar): fica por cima das Configurações */}
      <ImageCropModal file={cropping?.file ?? null} kind={cropping?.kind ?? "avatar"} onCancel={() => setCropping(null)} onApply={applyCrop} />

      {/* Confirmação dentro do app (como as outras): levada para o body para ficar acima das Configurações. */}
      {typeof document !== "undefined" && createPortal(
        <ConfirmActionModal
          isOpen={confirmingDelete}
          title={t("profile.delete.title")}
          message={t("profile.delete.confirm")}
          confirmLabel={t("profile.delete.action")}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={async () => { await remove(); setConfirmingDelete(false); }}
        />,
        document.body,
      )}
    </div>
  );
}
