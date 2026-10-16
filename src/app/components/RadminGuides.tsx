"use client";

import { useEffect, useState, type ReactNode } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Check, Copy, Download, Loader2, RefreshCw, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useAppStore } from "@/app/store";
import { useConnectionHelp } from "@/lib/connectionHelp";
import {
  RADMIN_DOWNLOAD_URL,
  allowRadminFirewall,
  generateNetworkPassword,
  guestPhase,
  hostPhase,
  installRadmin,
  radminAddress,
  suggestedNetworkName,
  useFirewallOk,
  useHostRadmin,
  useRadminStatus,
  useReachable,
  wingetAvailable,
  type HostPhase,
} from "@/lib/radmin";

// ============================================================
// Passo a passo do Radmin VPN (plano B de conexão)
// ============================================================
// Cada passo se marca sozinho a partir do que o Windows mostra (instalado? conectado a uma rede? o host
// responde?). Nada aqui guarda o nome/senha da rede: o app não tem como saber se ainda valem.
// ============================================================

type StepState = "done" | "current" | "todo";

function StepRow({ n, state, title, children }: { n: number; state: StepState; title: string; children?: ReactNode }) {
  return (
    <div className={cn("flex gap-3", state === "todo" && "opacity-50")}>
      <div
        className={cn(
          "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5",
          state === "done" ? "bg-emerald-500 text-white" : state === "current" ? "bg-indigo-500 text-white" : "bg-theme-muted text-theme-secondary border border-theme-card",
        )}
      >
        {state === "done" ? <Check className="w-4 h-4" /> : n}
      </div>
      <div className="space-y-1.5 min-w-0 flex-1">
        <p className="text-sm font-bold text-theme-primary">{title}</p>
        {state !== "done" && children}
      </div>
    </div>
  );
}

function stateFor(step: number, current: number): StepState {
  return step < current ? "done" : step === current ? "current" : "todo";
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* sem área de transferência: o valor continua visível para copiar à mão */ }
  };
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-secondary">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate px-3 h-9 flex items-center rounded-xl bg-theme-muted border border-theme-card text-sm font-bold text-theme-primary select-all">{value}</code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-theme-card hover:bg-theme-muted text-xs font-bold text-theme-primary transition-colors cursor-pointer shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? t("connhelp.step.copied") : t("connhelp.step.copy")}
        </button>
      </div>
    </div>
  );
}

/** Passo 1 (igual para host e convidado): instalar o Radmin. */
function InstallStep({ n, state, refresh }: { n: number; state: StepState; refresh: () => void }) {
  const { t } = useT();
  const [winget, setWinget] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    wingetAvailable().then(setWinget);
  }, []);

  const install = async () => {
    setInstalling(true);
    setFailed(false);
    try {
      await installRadmin();
    } catch {
      setFailed(true);
    } finally {
      setInstalling(false);
      refresh();
    }
  };

  return (
    <StepRow n={n} state={state} title={state === "done" ? t("connhelp.install.done") : t("connhelp.install.title")}>
      <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.install.desc")}</p>
      <div className="flex flex-wrap gap-2">
        {winget && (
          <button
            type="button"
            onClick={install}
            disabled={installing}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 text-white text-xs font-bold transition-colors cursor-pointer"
          >
            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {installing ? t("connhelp.install.running") : t("connhelp.install.auto")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void openExternal(RADMIN_DOWNLOAD_URL).catch(() => {})}
          className={cn(
            "inline-flex items-center gap-2 h-9 px-4 rounded-xl text-xs font-bold transition-colors cursor-pointer",
            winget ? "border border-theme-card hover:bg-theme-muted text-theme-primary" : "bg-indigo-500 hover:bg-indigo-600 text-white",
          )}
        >
          <Download className="w-4 h-4" />
          {t("connhelp.install.manual")}
        </button>
      </div>
      {failed && <p className="text-xs text-amber-600 dark:text-amber-400">{t("connhelp.install.failed")}</p>}
    </StepRow>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] text-theme-secondary flex items-center gap-1.5">
      <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
      {children}
    </p>
  );
}

const HOST_ORDER: HostPhase[] = ["install", "network", "firewall", "ready"];

/** Quem hospeda: instalar → criar a rede → liberar o firewall → passar o endereço. */
export function HostGuide() {
  const { t } = useT();
  const { status, refresh } = useRadminStatus(true);
  const { ok: firewallOk, refresh: refreshFirewall } = useFirewallOk(true);
  const minecraftPort = useAppStore((s) => s.minecraftPort);
  const shortCode = useAppStore((s) => s.localServers.find((x) => x.name === s.selectedServer)?.shortCode ?? null);
  const [password, setPassword] = useState(() => generateNetworkPassword());
  const [networkName] = useState(() => suggestedNetworkName(shortCode));
  const [fw, setFw] = useState<"idle" | "running" | "cancelled" | "failed">("idle");

  const phase = status ? hostPhase(status, firewallOk) : null;
  const current = phase ? HOST_ORDER.indexOf(phase) : 0;

  const allow = async () => {
    setFw("running");
    try {
      await allowRadminFirewall();
      setFw("idle");
    } catch (e) {
      setFw(String(e).includes("CANCELLED") ? "cancelled" : "failed");
    } finally {
      refreshFirewall();
    }
  };

  if (!status) return <Waiting>…</Waiting>;

  return (
    <div className="space-y-5">
      <InstallStep n={1} state={stateFor(0, current)} refresh={refresh} />

      <StepRow n={2} state={stateFor(1, current)} title={current > 1 ? t("connhelp.host.net.done") : t("connhelp.host.net.title")}>
        <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.host.net.desc")}</p>
        <CopyField label={t("connhelp.host.net.name")} value={networkName} />
        <CopyField label={t("connhelp.host.net.password")} value={password} />
        <button
          type="button"
          onClick={() => setPassword(generateNetworkPassword())}
          className="text-[11px] font-bold text-indigo-500 hover:underline cursor-pointer"
        >
          {t("connhelp.host.net.regen")}
        </button>
        <p className="text-[11px] text-theme-secondary leading-relaxed">{t("connhelp.host.net.noStore")}</p>
        {current === 1 && <Waiting>{t("connhelp.host.net.waiting")}</Waiting>}
      </StepRow>

      <StepRow n={3} state={stateFor(2, current)} title={current > 2 ? t("connhelp.host.fw.done") : t("connhelp.host.fw.title")}>
        <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.host.fw.desc")}</p>
        <button
          type="button"
          onClick={allow}
          disabled={fw === "running"}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 text-white text-xs font-bold transition-colors cursor-pointer"
        >
          {fw === "running" && <Loader2 className="w-4 h-4 animate-spin" />}
          {fw === "running" ? t("connhelp.host.fw.running") : t("connhelp.host.fw.button")}
        </button>
        {fw === "cancelled" && <p className="text-xs text-amber-600 dark:text-amber-400">{t("connhelp.host.fw.cancelled")}</p>}
        {fw === "failed" && <p className="text-xs text-rose-600 dark:text-rose-400">{t("connhelp.host.fw.failed")}</p>}
      </StepRow>

      <StepRow n={4} state={phase === "ready" ? "current" : "todo"} title={t("connhelp.host.ready.title")}>
        {phase === "ready" && status.ip && (
          <>
            <CopyField label={t("connhelp.host.ready.address")} value={radminAddress(status.ip, minecraftPort)} />
            <p className="text-[11px] text-theme-secondary leading-relaxed">{t("connhelp.host.ready.share")}</p>
          </>
        )}
      </StepRow>
    </div>
  );
}

/** Quem entra: instalar → entrar na rede do host → achar o host → jogar. */
export function GuestGuide({ onPlay }: { onPlay: (shortCode: string) => void }) {
  const { t } = useT();
  const target = useConnectionHelp((s) => s.target);
  const { status, refresh } = useRadminStatus(true);
  const host = useHostRadmin(target?.shortCode ?? null, !!status?.ip);
  const port = host.port ?? 25565;
  const reachable = useReachable(host.ip, port, !!status?.ip && !!target);
  const phase = status ? guestPhase(status, host.ip, reachable) : null;

  if (!status) return <Waiting>…</Waiting>;

  // Passos 1 e 2 valem com ou sem servidor escolhido; o passo 3 precisa saber qual é.
  const installDone = phase !== "install";
  const networkDone = phase !== "install" && phase !== "network";
  const name = target?.name ?? "";
  const ready = phase === "ready";

  return (
    <div className="space-y-5">
      <InstallStep n={1} state={installDone ? "done" : "current"} refresh={refresh} />

      <StepRow n={2} state={networkDone ? "done" : installDone ? "current" : "todo"} title={networkDone ? t("connhelp.guest.net.done") : t("connhelp.guest.net.title")}>
        <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.guest.net.desc")}</p>
        {installDone && !networkDone && <Waiting>{t("connhelp.guest.net.waiting")}</Waiting>}
      </StepRow>

      <StepRow n={3} state={ready ? "done" : networkDone ? "current" : "todo"} title={ready ? t("connhelp.guest.host.ready", { name }) : t("connhelp.guest.host.title")}>
        {!target ? (
          <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.guest.host.noTarget")}</p>
        ) : phase === "host-missing" ? (
          <p className="text-xs text-theme-secondary leading-relaxed">{t("connhelp.guest.host.missing")}</p>
        ) : phase === "checking" ? (
          <Waiting>{t("connhelp.guest.host.checking", { name })}</Waiting>
        ) : phase === "unreachable" ? (
          <div className="space-y-1.5">
            <p className="text-xs font-bold text-amber-600 dark:text-amber-400">{t("connhelp.guest.host.unreachable", { name })}</p>
            <ol className="text-xs text-theme-secondary leading-relaxed list-decimal pl-4 space-y-1">
              <li>{t("connhelp.guest.host.c1")}</li>
              <li>{t("connhelp.guest.host.c2")}</li>
              <li>{t("connhelp.guest.host.c3")}</li>
            </ol>
          </div>
        ) : null}
      </StepRow>

      {ready && target && (
        <button
          type="button"
          onClick={() => onPlay(target.shortCode)}
          className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold transition-colors cursor-pointer"
        >
          <Play className="w-4 h-4 fill-current" />
          {t("connhelp.guest.play")}
        </button>
      )}
    </div>
  );
}
