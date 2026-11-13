"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errorMessage";
import { useAppStore } from "@/app/store";
import { useT } from "@/i18n";
import { deleteMyProfile, getMyProfile, saveMyProfile } from "@/lib/profile";
import { AVATARS, COLORS, DEFAULT_AVATAR_ID, DEFAULT_COLOR_ID, DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, colorOf } from "@/lib/profileCatalog";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";

type Status = "idle" | "saving" | "saved" | "error" | "deleted";

/** Edição do perfil (nome, avatar e cor) dentro de Configurações → Conta. Só aparece com a conta logada. */
export function ProfileEditor() {
  const { t } = useT();
  const profile = useAppStore((s) => s.profile);
  const setProfile = useAppStore((s) => s.setProfile);

  const [name, setName] = useState("");
  const [avatarId, setAvatarId] = useState(DEFAULT_AVATAR_ID);
  const [colorId, setColorId] = useState(DEFAULT_COLOR_ID);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const filled = useRef(false);

  // Preenche o formulário uma vez: com o perfil salvo, ou com o nome que veio do Google/Discord como sugestão.
  useEffect(() => {
    let cancelled = false;
    getMyProfile()
      .then(({ profile: p, suggestedName }) => {
        if (cancelled || filled.current) return;
        filled.current = true;
        setProfile(p);
        setName(p?.displayName ?? suggestedName ?? "");
        setAvatarId(p?.avatarId ?? DEFAULT_AVATAR_ID);
        setColorId(p?.nameColor ?? DEFAULT_COLOR_ID);
      })
      .catch(() => { /* sem rede: o formulário abre vazio e o salvar mostra o erro */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [setProfile]);

  const trimmedLength = [...name.trim()].length;
  const nameOk = trimmedLength >= DISPLAY_NAME_MIN && trimmedLength <= DISPLAY_NAME_MAX;
  const dirty = !profile || profile.displayName !== name.trim() || profile.avatarId !== avatarId || (profile.nameColor ?? DEFAULT_COLOR_ID) !== colorId;

  async function save() {
    if (!nameOk) { setStatus("error"); setError(t("profile.error.length", { min: DISPLAY_NAME_MIN, max: DISPLAY_NAME_MAX })); return; }
    setStatus("saving");
    setError(null);
    try {
      await saveMyProfile({ displayName: name.trim(), avatarId, nameColor: colorId });
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err) || t("profile.error.save"));
    }
  }

  async function remove() {
    if (!window.confirm(t("profile.delete.confirm"))) return;
    try {
      await deleteMyProfile();
      setName(""); setAvatarId(DEFAULT_AVATAR_ID); setColorId(DEFAULT_COLOR_ID);
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

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-bold text-theme-primary">{t("profile.title")}</p>
        <p className="text-[11px] text-theme-secondary">{t("profile.hint")}</p>
      </div>

      <div className="flex items-center gap-3 rounded-2xl border border-theme-card bg-theme-muted px-4 py-3" aria-label={t("profile.preview")}>
        <ProfileAvatar avatarId={avatarId} colorId={colorId} size="lg" />
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{t("profile.preview")}</p>
          <p className="text-base font-bold truncate" style={{ color: colorOf(colorId).hex }}>{name.trim() || "—"}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="profile-name" className="text-[11px] font-bold text-theme-primary">{t("profile.name.label")}</label>
        <input
          id="profile-name"
          type="text"
          value={name}
          maxLength={DISPLAY_NAME_MAX + 10}
          onChange={(e) => { setName(e.target.value); setStatus("idle"); }}
          placeholder={t("profile.name.placeholder")}
          className="w-full h-10 px-3 border border-theme-card rounded-xl focus:border-indigo-500 focus:outline-none transition-all text-sm text-theme-primary bg-theme-card"
        />
        <p className="text-[11px] text-theme-secondary">{t("profile.name.hint", { min: DISPLAY_NAME_MIN, max: DISPLAY_NAME_MAX })}</p>
      </div>

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
          <button type="button" onClick={remove} className="text-xs font-semibold text-rose-500 hover:text-rose-600 transition-colors cursor-pointer">{t("profile.delete")}</button>
        )}
        {status === "saved" && <p className="text-[11px] text-emerald-600" role="status">{t("profile.saved")}</p>}
        {status === "deleted" && <p className="text-[11px] text-emerald-600" role="status">{t("profile.deleted")}</p>}
      </div>
      {status === "error" && error && <p className="text-[11px] text-rose-500" role="alert">{error}</p>}
    </div>
  );
}
