"use client";

import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Check, Copy, Cpu, ExternalLink, Gauge, Globe, Lock, MemoryStick, Settings, ShieldCheck, Smartphone, Users, Package, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { inviteLinkUrl } from "@/lib/inviteLink";
import { meshAddressLabel } from "@/lib/meshAddress";
import { processCpuOfMachine, usePerfStore } from "@/lib/perfMonitor";
import { openPlus, useSubscriptionInfo } from "@/lib/plusUi";
import type { HostController } from "@/app/components/host/useHostController";
import { Avatar, Card } from "../ui";

type Tab = "overview" | "players" | "world" | "mods" | "performance" | "settings";

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-theme-card border-theme-card shadow-theme-card rounded-2xl px-4 py-3.5">
      <div className="flex items-center gap-2 text-theme-secondary">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[11px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold text-theme-primary tabular-nums mt-1">{value}</div>
      {sub && <div className="text-xs text-theme-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

export function OverviewTab({ c, onGoTo }: { c: HostController; onGoTo: (t: Tab) => void }) {
  const { t, serverInfo, friendsOnline, displayShortCode, inviteSlug, friendsHint, headline, copiedText, copyToClipboard, onlinePlayers, serverStatus, resourceSample, hosting, netIp, networkPath, serverConfigPort } = c;
  const tps = usePerfStore((s) => s.perf?.tps ?? null);
  const { active: plus } = useSubscriptionInfo();
  const running = serverStatus === "online";
  const cpu = running ? processCpuOfMachine(resourceSample?.processCpuPercent, resourceSample?.cpuCores) : null;
  const ramMb = running ? resourceSample?.processRamMb : undefined;
  const allocMb = resourceSample?.allocatedRamMb;
  const gb = (mb: number) => (mb / 1024).toFixed(1).replace(/\.0$/, "");
  const code = displayShortCode ? `CF-${displayShortCode}` : null;
  const link = inviteSlug ? inviteLinkUrl(inviteSlug) : null;

  return (
    <>
      {friendsOnline && code ? (
        <Card className="border bg-gradient-to-br from-indigo-600/10 to-transparent">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <span className="w-11 h-11 rounded-xl grid place-items-center bg-theme-card shadow-theme-shadow shrink-0"><ShieldCheck className="w-6 h-6 text-indigo-600" /></span>
              <div className="min-w-0">
                <p className="text-lg font-bold">{t("host.friends.onlineTitle")}</p>
                <p className="text-sm text-theme-secondary mt-0.5">{t("host.net.share")}</p>
                {link && <p className="text-xs text-theme-secondary font-mono truncate mt-1">play.cubicase.net/{inviteSlug}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => copyToClipboard(code)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer">
                {copiedText === code ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}{code}
              </button>
              {link && (
                <button type="button" onClick={() => copyToClipboard(link)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-theme-card border border-theme-card hover:border-indigo-400 cursor-pointer">
                  {copiedText === link ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}{t("host.copyInvite")}
                </button>
              )}
            </div>
          </div>
        </Card>
      ) : (headline === "idle" || headline === "crashed" || headline === "stopping") ? (
        // Nos demais estados (preparando, conectando, só neste PC) a faixa de avisos do topo já explica o que está acontecendo.
        <Card>
          <div className="flex items-center gap-4 text-sm text-theme-secondary"><Globe className="w-5 h-5 shrink-0 text-slate-400" /><span>{friendsHint[headline] || t("host.friends.hint.idle")}</span></div>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={Users} label={t("nui.stat.players")} value={running ? String(onlinePlayers.length) : "—"} sub={running ? t("nui.stat.playersNow") : undefined} />
        <Stat icon={Gauge} label="TPS" value={running && tps !== null ? (Math.round(tps * 10) / 10).toString() : "—"} />
        <Stat icon={MemoryStick} label={t("nui.stat.memory")} value={ramMb ? `${gb(ramMb)} GB` : "—"} sub={ramMb && allocMb ? t("nui.stat.memoryOf", { max: gb(allocMb) }) : undefined} />
        <Stat icon={Cpu} label="CPU" value={cpu !== null ? `${Math.round(cpu)}%` : "—"} sub={cpu !== null ? t("nui.stat.cpuOf") : undefined} />
      </div>

      {/* Painel web: quem tem Plus abre no navegador; quem não tem vê o botão (com o selo Plus) e cai na explicação do Plus. */}
      <button
        type="button"
        onClick={() => (plus ? void openExternal("https://cubicase.net/painel/") : openPlus("panel"))}
        className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl bg-gradient-to-r from-indigo-600/10 to-violet-600/10 border border-theme-accent hover:border-indigo-400 text-left cursor-pointer"
      >
        <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white grid place-items-center shrink-0"><Smartphone className="w-5 h-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-theme-primary">{t("plus.locked.panelOpen")}</span>
          <span className="block text-xs text-theme-secondary">{t("plus.locked.panelHint")}</span>
        </span>
        {plus ? <ExternalLink className="w-4 h-4 text-theme-secondary shrink-0" /> : <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-indigo-600 text-white shrink-0"><Lock className="w-3 h-3" />Plus</span>}
      </button>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title={t("nui.overview.players")} className="lg:col-span-2" action={<button type="button" onClick={() => onGoTo("players")} className="text-xs font-bold text-indigo-600 hover:underline cursor-pointer">{t("nui.overview.manage")}</button>}>
          {running && onlinePlayers.length > 0 ? (
            <ul className="divide-y divide-[var(--card-border)]">
              {onlinePlayers.slice(0, 8).map((p) => (
                <li key={p} className="py-2.5 flex items-center gap-3"><Avatar name={p} /><span className="text-sm font-bold">{p}</span></li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-theme-secondary py-6 text-center">{running ? t("players.noneOnline") : t("players.offlineEmpty")}</p>
          )}
        </Card>

        <Card title={t("nui.overview.shortcuts")}>
          <div className="space-y-2">
            {[
              { icon: Archive, label: t("nui.overview.worldBackups"), tab: "world" as const },
              ...(["forge", "neoforge", "fabric", "paper", "spigot", "purpur", "bukkit"].includes(serverInfo?.serverType ?? "") ? [{ icon: Package, label: t("nui.overview.mods"), tab: "mods" as const }] : []),
              { icon: Settings, label: t("nui.overview.settings"), tab: "settings" as const },
            ].map(({ icon: Icon, label, tab }) => (
              <button key={tab} type="button" onClick={() => onGoTo(tab)} className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-theme-muted border border-theme-card hover:border-indigo-400 text-sm font-bold text-left cursor-pointer")}>
                <Icon className="w-4 h-4 text-indigo-600" />{label}
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* Detalhes técnicos da rede (diagnóstico): fora do caminho de quem não precisa. */}
      <details className="group">
        <summary className="cursor-pointer select-none text-xs font-bold text-theme-secondary uppercase tracking-wider hover:text-theme-primary">{t("host.tech.summary")}</summary>
        <div className="grid sm:grid-cols-3 gap-3 mt-3">
          <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
            <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">{t("host.net.redirect")}</p>
            <p className="text-sm font-bold text-theme-primary mt-1">127.0.0.1:{serverConfigPort}</p>
          </div>
          <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
            <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">{t("host.net.meshAddress")}</p>
            <p className="text-sm font-bold text-theme-primary mt-1">{meshAddressLabel(hosting.ip ?? netIp, networkPath, t) || t("host.net.inactive")}</p>
          </div>
          <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
            <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">{t("host.net.interface")}</p>
            <p className={cn("text-sm font-bold mt-1", hosting.net === "online" ? "text-emerald-600" : "text-theme-secondary")}>{hosting.net === "online" ? t("host.net.active") : t("host.net.disconnected")}</p>
          </div>
        </div>
        {hosting.netError && <p className="mt-3 text-[11px] font-mono text-theme-secondary break-words">{hosting.netError}</p>}
      </details>
    </>
  );
}
