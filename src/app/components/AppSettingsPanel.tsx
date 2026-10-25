"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, X, Archive, Palette, User as UserIcon, Sparkles, Home, Monitor, Globe, Server, ShieldCheck, BedDouble, Check, Lock } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { errorMessage } from "@/lib/errorMessage";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useAppStore } from "@/app/store";
import { Switch } from "@/app/components/Switch";
import { useConnectionHelp } from "@/lib/connectionHelp";
import { AppearanceSettings } from "@/app/components/AppearanceSettings";
import { BackupFolderSettings } from "@/app/components/BackupFolderSettings";
import type { PlusFeature } from "@/lib/plusUi";
import { LanguageSelector } from "@/app/components/LanguageSelector";
import { useT, formatDateTime, type TKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { requireAuth, logout, setPassword, getLinkedProviders } from "@/lib/auth";
import { getJavaVersion, updateWakeOnDemandConfig } from "@/lib/server";
import { isJREInstalled, getJREPath } from "@/lib/jre";
import {
  getSubscriptionStatus,
  openBillingPortal,
  isSubscriptionActive,
  type SubscriptionInfo,
} from "@/lib/subscription";

const IDLE_TIMEOUT_OPTIONS = [10, 15, 30, 60] as const;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

// ============================================================
// AppSettingsPanel
// ============================================================
// Painel de configurações gerais do app, aberto pela engrenagem no
// cabeçalho. Menu lateral de categorias + conteúdo à direita. Grava
// direto na store a cada mudança (sem botão "Salvar").
// ============================================================

export type SettingsCategory = "geral" | "aparencia" | "servidores" | "conta";

/** Nomes antigos (quando eram 6 abas) continuam valendo: levam à aba onde a configuração está hoje. */
export type LegacySettingsCategory = "inicio" | "rede" | "backups" | "tema" | "assinatura";
const LEGACY: Record<LegacySettingsCategory, SettingsCategory> = { inicio: "geral", tema: "aparencia", rede: "servidores", backups: "servidores", assinatura: "conta" };
export function normalizeCategory(c: SettingsCategory | LegacySettingsCategory | undefined): SettingsCategory {
  if (!c) return "servidores";
  return c in LEGACY ? LEGACY[c as LegacySettingsCategory] : (c as SettingsCategory);
}

const CATEGORIES: { id: SettingsCategory; labelKey: TKey; hintKey: TKey; icon: typeof Archive }[] = [
  { id: "geral", labelKey: "settings.cat.general", hintKey: "settings.cat.general.hint", icon: Home },
  { id: "aparencia", labelKey: "settings.cat.appearance", hintKey: "settings.cat.appearance.hint", icon: Palette },
  { id: "servidores", labelKey: "settings.cat.servers", hintKey: "settings.cat.servers.hint", icon: Server },
  { id: "conta", labelKey: "settings.cat.accountPlus", hintKey: "settings.cat.accountPlus.hint", icon: UserIcon },
];

interface AppSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Categoria exibida ao abrir o painel (ex: card "Cubicase Plus" no HostView pulando direto pra aba de assinatura). Padrão "backups". */
  initialCategory?: SettingsCategory | LegacySettingsCategory;
  /** Abre o modal do Cubicase Plus (benefícios e planos). */
  onOpenPlus?: (feature?: PlusFeature) => void;
}

function Section({ title, hint, badge, children }: { title: string; hint?: string; badge?: string; children: React.ReactNode }) {
  return (
    <section className="bg-theme-muted border border-theme-card rounded-2xl p-5 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-bold text-theme-primary">{title}</h4>
          {badge && <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300">{badge}</span>}
        </div>
        {hint && <p className="text-xs text-theme-secondary mt-1 leading-relaxed">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function AppSettingsPanel({ isOpen, onClose, initialCategory, onOpenPlus }: AppSettingsPanelProps) {
  const { t } = useT();
  const [category, setCategory] = useState<SettingsCategory>(normalizeCategory(initialCategory));
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Reabrir o painel sempre parte da categoria pedida (ex: link direto pra "assinatura"),
  // sem carregar a última aba visitada de uma abertura anterior.
  useEffect(() => {
    if (isOpen) setCategory(normalizeCategory(initialCategory));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  const defaultTab = useAppStore((s) => s.defaultTab);
  const privateMode = useAppStore((s) => s.privateMode);
  const setPrivateMode = useAppStore((s) => s.setPrivateMode);
  const relayStatus = useAppStore((s) => s.relayStatus);
  const setDefaultTab = useAppStore((s) => s.setDefaultTab);

  const autoBackupEnabled = useAppStore((s) => s.autoBackupEnabled);
  const setAutoBackupEnabled = useAppStore((s) => s.setAutoBackupEnabled);
  const backupRetentionCount = useAppStore((s) => s.backupRetentionCount);
  const setBackupRetentionCount = useAppStore((s) => s.setBackupRetentionCount);
  const backupSafetyNetIntervalHours = useAppStore((s) => s.backupSafetyNetIntervalHours);
  const setBackupSafetyNetIntervalHours = useAppStore((s) => s.setBackupSafetyNetIntervalHours);

  const user = useAppStore((s) => s.user);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!user) { setProviders([]); return; }
    getLinkedProviders().then(setProviders);
  }, [user]);

  // Estado local, de propósito — igual a `providers` acima. Nunca deve virar
  // campo do store: entitlement precisa ser sempre reverificado ao vivo no
  // Supabase, nunca confiado a partir do que ficou salvo no localStorage.
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [subAction, setSubAction] = useState<"portal" | null>(null);

  useEffect(() => {
    if (!user) { setSubscription(null); return; }
    setSubLoading(true);
    getSubscriptionStatus()
      .then(setSubscription)
      .catch(() => setSubscription(null))
      .finally(() => setSubLoading(false));
  }, [user]);

  const handleManageSubscription = async () => {
    setSubAction("portal");
    setSubError(null);
    try {
      await openBillingPortal();
    } catch (err) {
      setSubError(errorMessage(err) || t("settings.sub.portalFailed"));
    } finally {
      setSubAction(null);
    }
  };

  // ------------------------------------------------------------
  // Wake-on-demand (Cubicase Plus) — armar/desarmar o servidor selecionado
  // ------------------------------------------------------------
  // Config por servidor (cubicase-meta.json), não global — segue o mesmo
  // servidor selecionado na aba Hospedar (mesma fonte, useAppStore). A
  // reflexão instantânea do badge "Em espera" na HostView depende de
  // `setLocalServers` também atualizar o espelho da store, não só o disco.
  const selectedServer = useAppStore((s) => s.selectedServer);
  const localServers = useAppStore((s) => s.localServers);
  const setLocalServers = useAppStore((s) => s.setLocalServers);
  const minecraftPort = useAppStore((s) => s.minecraftPort);
  const serverInfo = localServers.find((s) => s.name === selectedServer) ?? null;

  const [wakeIdleMinutes, setWakeIdleMinutes] = useState(DEFAULT_IDLE_TIMEOUT_MINUTES);
  const [wakeSubmitting, setWakeSubmitting] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);

  useEffect(() => {
    setWakeIdleMinutes(serverInfo?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES);
    setWakeError(null);
  }, [serverInfo?.name]);

  const patchServerInfo = (patch: Partial<typeof localServers[number]>) => {
    if (!serverInfo) return;
    setLocalServers(localServers.map((s) => (s.name === serverInfo.name ? { ...s, ...patch } : s)));
  };

  const handleEnableWakeOnDemand = async () => {
    if (!serverInfo) return;
    setWakeSubmitting(true);
    setWakeError(null);
    try {
      const version = serverInfo.version || "1.20.1";
      const javaVer = getJavaVersion(version);
      if (!(await isJREInstalled(javaVer))) {
        throw new Error(t("settings.wake.javaMissing"));
      }
      const jrePath = await getJREPath(javaVer);
      const javaPath = `${jrePath}\\bin\\java.exe`;

      let ramGb = 4;
      try {
        const metaPath = await join(serverInfo.path, "cubicase-meta.json");
        const meta = JSON.parse(await readTextFile(metaPath)) as { ramGb?: number };
        if (typeof meta.ramGb === "number" && meta.ramGb >= 2) ramGb = meta.ramGb;
      } catch { /* usa o padrão de 4GB */ }

      await invoke("arm_wake_on_demand", {
        serverDir: serverInfo.path,
        shortCode: serverInfo.shortCode,
        javaPath,
        ramGb,
        localPort: minecraftPort || 25565,
        serverJarName: serverInfo.serverJar || null,
        launchArgsDir: serverInfo.launchArgsDir || null,
        idleTimeoutMinutes: wakeIdleMinutes,
        name: serverInfo.name,
        version,
        serverType: serverInfo.serverType,
        description: serverInfo.description,
        forgeVersion: serverInfo.forgeVersion,
        modLoaderVersion: serverInfo.modLoaderVersion,
      });
      await updateWakeOnDemandConfig(serverInfo.path, { enabled: true, idleTimeoutMinutes: wakeIdleMinutes });
      patchServerInfo({ wakeOnDemandEnabled: true, idleTimeoutMinutes: wakeIdleMinutes });
    } catch (err) {
      setWakeError(errorMessage(err) || String(err));
    } finally {
      setWakeSubmitting(false);
    }
  };

  const handleDisableWakeOnDemand = async () => {
    if (!serverInfo) return;
    setWakeSubmitting(true);
    setWakeError(null);
    try {
      await invoke("disarm_wake_on_demand");
      await updateWakeOnDemandConfig(serverInfo.path, { enabled: false, idleTimeoutMinutes: wakeIdleMinutes });
      patchServerInfo({ wakeOnDemandEnabled: false });
    } catch (err) {
      setWakeError(errorMessage(err) || String(err));
    } finally {
      setWakeSubmitting(false);
    }
  };

  // Reverifica a assinatura periodicamente (e ao entrar nesta aba) enquanto o
  // app estiver aberto — cobre o caso raro de a assinatura vencer com o
  // wake-on-demand já armado. Nunca derruba uma sessão em hospedagem de
  // verdade (disarm_wake_on_demand só faz isso quando ainda dormindo) —
  // só impede reentrar em espera depois que ela terminar sozinha.
  useEffect(() => {
    const recheck = async () => {
      // Sem conta (acabou de sair) também não há Plus: desarma do mesmo jeito.
      const status = user ? await getSubscriptionStatus().catch(() => null) : null;
      setSubscription(status);
      if (isSubscriptionActive(status)) return;
      const servers = useAppStore.getState().localServers;
      const armed = servers.find((s) => s.wakeOnDemandEnabled);
      if (!armed) return;
      await invoke("disarm_wake_on_demand").catch(() => {});
      await updateWakeOnDemandConfig(armed.path, { enabled: false, idleTimeoutMinutes: armed.idleTimeoutMinutes }).catch(() => {});
      useAppStore.getState().setLocalServers(
        servers.map((s) => (s.name === armed.name ? { ...s, wakeOnDemandEnabled: false } : s))
      );
    };
    if (!user || category === "servidores" || category === "conta") recheck();
    const interval = setInterval(recheck, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user, category]);

  const handleLogin = async () => {
    setLoggingIn(true);
    setLoginError(null);
    // Se o login não voltar do navegador logo (aba fechada, login cancelado), libera o botão para tentar de novo; o app
    // continua aceitando o retorno do login por alguns minutos.
    const release = setTimeout(() => setLoggingIn(false), 30_000);
    try {
      await requireAuth();
    } catch (err) {
      // Uma tentativa antiga que expira depois de um login bem-sucedido não deve mostrar erro.
      if (!useAppStore.getState().user) setLoginError(errorMessage(err) || t("settings.account.loginFailed"));
    } finally {
      clearTimeout(release);
      setLoggingIn(false);
    }
  };

  const handleSetPassword = async () => {
    if (newPassword.length < 6) {
      setPasswordStatus("error");
      return;
    }
    setPasswordStatus("saving");
    try {
      await setPassword(newPassword);
      setPasswordStatus("saved");
      setNewPassword("");
    } catch {
      setPasswordStatus("error");
    }
  };

  useLockBodyScroll(isOpen);

  const plusActive = isSubscriptionActive(subscription);

  const numberInput = "w-28 h-10 px-3 border border-theme-card rounded-xl focus:border-indigo-500 focus:outline-none transition-all font-mono text-sm text-theme-primary bg-theme-card disabled:opacity-50";

  const geral = (
    <div className="space-y-5">
      <Section title={t("settings.home.label")} hint={t("settings.home.hint")}>
        <div className="grid grid-cols-2 gap-3">
          {([
            { id: "host" as const, icon: Monitor, label: t("settings.home.host"), desc: t("settings.home.hostDesc") },
            { id: "guest" as const, icon: Globe, label: t("settings.home.guest"), desc: t("settings.home.guestDesc") },
          ]).map(({ id, icon: Icon, label, desc }) => (
            <button
              key={id}
              type="button"
              onClick={() => setDefaultTab(id)}
              aria-pressed={defaultTab === id}
              className={cn("text-left p-4 rounded-2xl border transition-colors cursor-pointer", defaultTab === id ? "border-indigo-500 bg-theme-accent" : "border-theme-card bg-theme-card hover:border-indigo-300")}
            >
              <span className="flex items-center justify-between">
                <Icon className="w-5 h-5 text-indigo-600" />
                {defaultTab === id && <Check className="w-4 h-4 text-indigo-600" />}
              </span>
              <span className="block text-sm font-bold text-theme-primary mt-2">{label}</span>
              <span className="block text-xs text-theme-secondary">{desc}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title={t("language.label")} hint={t("language.hint")}>
        <LanguageSelector compact />
      </Section>
    </div>
  );

  const aparencia = (
    <div className="space-y-5">
      <AppearanceSettings />
    </div>
  );

  const servidores = (
    <div className="space-y-5">
      <Section title={t("settings.backups.auto")} hint={t("settings.backups.autoHint")}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-theme-primary">{autoBackupEnabled ? t("settings.backups.on") : t("settings.backups.off")}</p>
          <Switch checked={autoBackupEnabled} onChange={() => setAutoBackupEnabled(!autoBackupEnabled)} />
        </div>
        <div className="grid sm:grid-cols-2 gap-4 pt-1">
          <label className="space-y-1.5">
            <span className="text-xs font-bold text-theme-primary">{t("settings.backups.retention")}</span>
            <input type="number" min="1" max="100" value={backupRetentionCount} disabled={!autoBackupEnabled} onChange={(e) => setBackupRetentionCount(parseInt(e.target.value) || 1)} className={numberInput} />
            <span className="block text-[11px] text-theme-secondary">{t("settings.backups.retentionHint")}</span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold text-theme-primary">{t("settings.backups.interval")}</span>
            <input type="number" min="1" max="24" value={backupSafetyNetIntervalHours} disabled={!autoBackupEnabled} onChange={(e) => setBackupSafetyNetIntervalHours(parseInt(e.target.value) || 1)} className={numberInput} />
            <span className="block text-[11px] text-theme-secondary">{t("settings.backups.intervalHint")}</span>
          </label>
        </div>
      </Section>

      <Section title={t("settings.backups.folder.title")} hint={t("settings.backups.folder.hint")}>
        <BackupFolderSettings />
      </Section>

      <Section title={t("settings.network.label")} hint={t("settings.network.hint")}>
        {relayStatus === "quota" && <p className="text-xs text-sky-600 dark:text-sky-400">{t("settings.network.quotaNote")}</p>}
        <div className="flex items-start justify-between gap-4 p-4 rounded-2xl border border-theme-card bg-theme-card">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-bold text-theme-primary">{t("settings.private.label")}</span>
              <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300">Plus</span>
            </div>
            <p className="text-xs text-theme-secondary mt-1 leading-relaxed">{t("settings.private.desc")}</p>
          </div>
          <Switch
            checked={privateMode && plusActive}
            onChange={() => { if (plusActive) setPrivateMode(!privateMode); else onOpenPlus?.("private"); }}
            title={plusActive ? undefined : t("settings.private.lockedTitle")}
          />
        </div>
        {!plusActive && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onOpenPlus?.("private")} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-colors cursor-pointer"><Lock className="w-3.5 h-3.5" />{t("plus.locked.unlock")}</button>
            <button type="button" onClick={() => { onClose(); useConnectionHelp.getState().show("private_locked"); }} className="h-9 px-3.5 rounded-xl border border-theme-card hover:bg-theme-card text-xs font-bold text-theme-primary transition-colors cursor-pointer">{t("settings.private.withoutPlus")}</button>
          </div>
        )}
      </Section>

      <Section title={t("settings.wake.title")} hint={t("settings.wake.desc")} badge="Plus">
        {!plusActive && (
          <button type="button" onClick={() => onOpenPlus?.("wake")} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-colors cursor-pointer"><Lock className="w-3.5 h-3.5" />{t("plus.locked.unlock")}</button>
        )}
        {plusActive && !serverInfo ? (
          <p className="text-xs text-theme-secondary">{t("settings.wake.selectServer")}</p>
        ) : (
          <div
            className={cn("space-y-3", !plusActive && "cursor-pointer")}
            onClick={!plusActive ? () => onOpenPlus?.("wake") : undefined}
            role={!plusActive ? "button" : undefined}
            aria-label={!plusActive ? t("plus.locked.unlock") : undefined}
          >
            <div className={cn("flex items-center justify-between gap-4 p-4 rounded-2xl border border-theme-card bg-theme-card", !plusActive && "opacity-70")}>
              <div className="flex items-center gap-3 min-w-0">
                <BedDouble className="w-4 h-4 text-indigo-600 shrink-0" />
                <p className="text-sm text-theme-primary font-bold truncate">{serverInfo?.name ?? t("settings.wake.title")}</p>
              </div>
              <div className={cn(!plusActive && "pointer-events-none")}>
                <Switch
                  checked={plusActive && !!serverInfo?.wakeOnDemandEnabled}
                  disabled={wakeSubmitting || !plusActive}
                  onChange={() => (serverInfo?.wakeOnDemandEnabled ? handleDisableWakeOnDemand() : handleEnableWakeOnDemand())}
                />
              </div>
            </div>
            <label className={cn("block space-y-1.5", !plusActive && "opacity-70")}>
              <span className="text-xs font-bold text-theme-primary">{t("settings.wake.idleAfter")}</span>
              <select
                value={wakeIdleMinutes}
                disabled={wakeSubmitting || !plusActive}
                onChange={async (e) => {
                  if (!serverInfo) return;
                  const minutes = parseInt(e.target.value, 10);
                  setWakeIdleMinutes(minutes);
                  await updateWakeOnDemandConfig(serverInfo.path, { enabled: !!serverInfo.wakeOnDemandEnabled, idleTimeoutMinutes: minutes });
                  patchServerInfo({ idleTimeoutMinutes: minutes });
                  if (serverInfo.wakeOnDemandEnabled) {
                    // Rearma com o novo valor: o loop de espera/hospedagem em memória
                    // no Rust só lê o timeout no momento de armar.
                    await handleEnableWakeOnDemand();
                  }
                }}
                className={cn("w-full sm:w-64 h-10 px-3 rounded-xl border border-theme-card bg-theme-card text-theme-primary focus:outline-none focus:border-indigo-500 transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed", !plusActive && "pointer-events-none")}
              >
                {IDLE_TIMEOUT_OPTIONS.map((min) => (
                  <option key={min} value={min}>{t("settings.wake.minutes", { count: min })}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {wakeError && <p className="text-xs text-rose-500">{wakeError}</p>}
      </Section>
    </div>
  );

  const conta = (
    <div className="space-y-5">
      {/* Cubicase Plus: vitrine para quem não assina, resumo e gerenciamento para quem assina */}
      {plusActive && subscription ? (
        <section className="rounded-2xl border border-theme-accent bg-theme-accent p-5 space-y-3">
          <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-indigo-600" /><h4 className="text-sm font-bold text-theme-primary">{t("settings.sub.title")}</h4></div>
          <p className="text-sm text-theme-primary">
            {t(subscription.plan === "annual" ? "settings.sub.active.annual" : "settings.sub.active.monthly")}
            {subscription.currentPeriodEnd &&
              t(subscription.cancelAtPeriodEnd ? "settings.sub.cancelsOn" : "settings.sub.renewsOn", {
                date: formatDateTime(subscription.currentPeriodEnd, { dateStyle: "short" }),
              })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleManageSubscription} disabled={subAction !== null} className="h-10 px-4 bg-theme-card border border-theme-card hover:bg-theme-muted disabled:opacity-50 text-theme-primary font-semibold text-xs rounded-xl transition-colors cursor-pointer">
              {subAction === "portal" ? t("settings.sub.opening") : t("settings.sub.manage")}
            </button>
            {onOpenPlus && <button type="button" onClick={() => onOpenPlus()} className="h-10 px-4 text-indigo-600 font-semibold text-xs rounded-xl hover:bg-theme-card transition-colors cursor-pointer">{t("settings.sub.seePlus")}</button>}
          </div>
        </section>
      ) : (
        onOpenPlus && (
          <button
            type="button"
            onClick={() => onOpenPlus()}
            className="w-full flex items-center justify-between gap-3 p-5 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white text-left cursor-pointer shadow-md"
          >
            <span className="flex items-center gap-3"><Sparkles className="w-5 h-5 shrink-0" /><span><span className="block text-sm font-bold">{t("plus.settings.cta")}</span><span className="block text-xs text-white/80">{subLoading ? t("settings.sub.checking") : t("plus.settings.ctaHint")}</span></span></span>
            <span aria-hidden>→</span>
          </button>
        )
      )}
      {subError && <p className="text-xs text-rose-500">{subError}</p>}

      <Section title={t("settings.account.title")} hint={user ? undefined : t("settings.account.intro")}>
        {!user ? (
          <div className="space-y-3">
            <button type="button" onClick={handleLogin} disabled={loggingIn} className="w-full h-12 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-2xl transition-colors cursor-pointer">
              {loggingIn ? t("settings.account.opening") : t("settings.account.login")}
            </button>
            {loginError && <p className="text-xs text-rose-500">{loginError}</p>}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{t("settings.account.loggedAs")}</p>
              <p className="text-sm font-bold text-theme-primary">{user.email}</p>
              {providers.length > 0 && <p className="text-[11px] text-theme-secondary">{t("settings.account.providers", { providers: providers.join(", ") })}</p>}
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-bold text-theme-primary">{t("settings.account.setPassword")}</p>
              <p className="text-[11px] text-theme-secondary">{t("settings.account.setPasswordHint")}</p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setPasswordStatus("idle"); }}
                  placeholder={t("settings.account.newPassword")}
                  className="flex-1 h-10 px-3 border border-theme-card rounded-xl focus:border-indigo-500 focus:outline-none transition-all text-sm text-theme-primary bg-theme-card"
                />
                <button type="button" onClick={handleSetPassword} disabled={passwordStatus === "saving"} className="h-10 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition-colors cursor-pointer">{t("settings.account.save")}</button>
              </div>
              {passwordStatus === "saved" && <p className="text-[11px] text-emerald-600">{t("settings.account.passwordSaved")}</p>}
              {passwordStatus === "error" && <p className="text-[11px] text-rose-500">{t("settings.account.passwordError")}</p>}
            </div>
            <button type="button" onClick={() => logout()} className="text-xs font-semibold text-rose-500 hover:text-rose-600 transition-colors cursor-pointer">{t("settings.account.logout")}</button>
          </div>
        )}
      </Section>
    </div>
  );

  const content: Record<SettingsCategory, React.ReactNode> = { geral, aparencia, servidores, conta };
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.title")}
            className="relative w-full max-w-3xl bg-theme-card rounded-[2rem] border-theme-card shadow-2xl z-10 flex flex-col h-[640px] max-h-[88vh] overflow-hidden"
          >
            <div className="flex flex-1 min-h-0">
              <nav className="w-56 flex-shrink-0 border-r border-theme-card bg-theme-muted/40 p-4 flex flex-col justify-between" aria-label={t("settings.title")}>
                <div>
                  <div className="flex items-center gap-2.5 px-2 pb-4">
                    <div className="w-8 h-8 bg-theme-accent rounded-lg flex items-center justify-center"><Settings className="text-indigo-600 w-4.5 h-4.5" /></div>
                    <h3 className="text-base font-bold text-theme-primary">{t("settings.title")}</h3>
                  </div>
                  <div className="space-y-1">
                    {CATEGORIES.map(({ id, labelKey, hintKey, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setCategory(id)}
                        aria-current={category === id ? "page" : undefined}
                        className={cn(
                          "w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer",
                          category === id ? "bg-indigo-600 text-white shadow-sm" : "text-theme-secondary hover:text-theme-primary hover:bg-theme-muted",
                        )}
                      >
                        <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold">{t(labelKey)}</span>
                          <span className={cn("block text-[11px] leading-snug", category === id ? "text-white/75" : "text-theme-secondary")}>{t(hintKey)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                {appVersion && <p className="text-[10px] text-theme-secondary text-center px-2">{t("settings.version", { version: appVersion })}</p>}
              </nav>

              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 flex-shrink-0">
                  <h4 className="text-lg font-bold text-theme-primary">{t(active.labelKey)}</h4>
                  <button type="button" onClick={onClose} aria-label={t("common.cancel")} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar px-6 pb-6">{content[category]}</div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
