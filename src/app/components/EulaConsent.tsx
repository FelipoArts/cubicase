"use client";

// Aceite do EULA do Minecraft. O Cubicase grava `eula=true` no servidor criado,
// então o aceite precisa vir do próprio usuário, de forma explícita. Pergunta uma
// vez: depois de aceito (e gravado no app), a caixa some e fica só um aviso discreto.

import { useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/app/store";
import { useT } from "@/i18n";

export const MINECRAFT_EULA_URL = "https://aka.ms/MinecraftEULA";

export interface EulaConsent {
  /** Já aceito em algum momento anterior (gravado no app). */
  alreadyAccepted: boolean;
  /** Pode seguir: aceito antes ou marcado agora. */
  ok: boolean;
  checked: boolean;
  setChecked: (v: boolean) => void;
  /** Grava o aceite no app. Chamar ao confirmar a criação/importação. */
  commit: () => void;
  acceptedAt: string | null;
}

export function useEulaConsent(): EulaConsent {
  const acceptedAt = useAppStore((s) => s.eulaAcceptedAt);
  const accept = useAppStore((s) => s.acceptEula);
  const [checked, setChecked] = useState(false);
  return {
    alreadyAccepted: !!acceptedAt,
    ok: !!acceptedAt || checked,
    checked,
    setChecked,
    commit: () => {
      if (!acceptedAt && checked) accept();
    },
    acceptedAt,
  };
}

export function EulaConsentBox({ consent }: { consent: EulaConsent }) {
  const { t } = useT();
  const openEula = () => {
    void openExternal(MINECRAFT_EULA_URL).catch(() => {});
  };

  if (consent.alreadyAccepted) {
    const date = consent.acceptedAt ? new Date(consent.acceptedAt).toLocaleDateString() : "";
    return (
      <p className="text-[11px] text-theme-secondary">
        {t("eula.accepted", { date })}{" "}
        <button type="button" onClick={openEula} className="underline hover:text-theme-primary cursor-pointer">
          {t("eula.read")}
        </button>
      </p>
    );
  }

  return (
    <label className="flex items-start gap-3 p-3 rounded-2xl bg-theme-muted border-theme-card cursor-pointer">
      <input
        type="checkbox"
        checked={consent.checked}
        onChange={(e) => consent.setChecked(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer"
      />
      <span className="text-xs text-theme-secondary leading-relaxed">
        <span className="font-semibold text-theme-primary">{t("eula.label")}</span>{" "}
        {t("eula.hint")}{" "}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            openEula();
          }}
          className="underline hover:text-theme-primary cursor-pointer"
        >
          {t("eula.read")}
        </button>
      </span>
    </label>
  );
}
