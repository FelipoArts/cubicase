"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Download, FolderOpen, HelpCircle, Monitor, PackageOpen, PanelLeftClose, PanelLeftOpen, Plus, Settings, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { pushDiagnostic } from "@/app/diagnostics";
import { useT, t as tn } from "@/i18n";
import type { HostController } from "@/app/components/host/useHostController";
import { ServerAvatar } from "@/app/components/ServerAvatar";
import { ResizeHandle, type usePanel } from "./panels";
import { goToHostTab } from "./hostNav";

// Menu lateral fixo da nova interface: os servidores do host, a porta de entrada do Convidado e os ajustes do app.
// Recolhido vira uma barra só de ícones (a classe `group-data-[compact=true]/side` esconde os textos).

interface Props {
  c: HostController;
  mode: "host" | "guest";
  onSetMode: (m: "host" | "guest") => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  panel: ReturnType<typeof usePanel>;
}

const HIDE = "group-data-[compact=true]/side:hidden";
const ROW = "w-full flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-bold cursor-pointer border group-data-[compact=true]/side:justify-center group-data-[compact=true]/side:px-0 group-data-[compact=true]/side:gap-0";

export function Sidebar({ c, mode, onSetMode, onOpenHelp, onOpenSettings, panel }: Props) {
  const { t } = useT();
  const compact = panel.collapsed;
  // Mesma logo da tela anterior (versão para fundo claro/escuro). Só depois de montar, para não divergir do HTML estático.
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const id = window.setTimeout(() => setMounted(true), 0); return () => clearTimeout(id); }, []);
  const logoSrc = mounted && resolvedTheme === "light" ? "/icon.png" : "/icon-dark.png";
  const { localServers, selectedServer, setSelectedServer, serverStatus, runningServerName, isDeletingServer } = c;

  /** Escolhe o servidor e abre a tela do host. Devolve false se não pôde trocar (outro está rodando). */
  function select(name: string): boolean {
    // Não troca de servidor com outro rodando: o app só mantém um processo por vez (mesmo aviso da lista atual).
    if (serverStatus !== "offline" && serverStatus !== "crashed" && selectedServer !== name) {
      pushDiagnostic({ level: "warning", source: tn("diag.source.server"), title: tn("serverList.running.title"), message: tn("serverList.running.message") });
      return false;
    }
    setSelectedServer(name);
    onSetMode("host");
    return true;
  }

  const iconBtn = "p-1 rounded-lg text-theme-secondary hover:text-indigo-600 hover:bg-theme-accent cursor-pointer";

  return (
    <aside
      style={{ width: panel.width }}
      data-compact={compact}
      className={cn("group/side relative shrink-0 bg-theme-card border-r border-theme-card flex flex-col", !panel.dragging && "transition-[width] duration-200")}
    >
      <ResizeHandle panel={panel} label={t("nui.sidebar.resize")} />

      <div className="h-14 flex items-center justify-start px-5 group-data-[compact=true]/side:justify-center group-data-[compact=true]/side:px-0 border-b border-theme-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} alt="Cubicase" className="h-7 w-auto" />
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-3 group-data-[compact=true]/side:p-2 space-y-5">
        <div>
          <div className={cn("flex items-center justify-between px-2 mb-2", HIDE)}>
            <span className="text-[10px] font-bold uppercase tracking-widest text-theme-secondary">{t("nui.sidebar.servers")}</span>
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={() => c.handleImportServer()} disabled={c.isImporting} title={t("serverList.import")} aria-label={t("serverList.import")} className={iconBtn}><FolderOpen className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => c.setShowImportModpack(true)} title={t("serverList.importModpack")} aria-label={t("serverList.importModpack")} className={iconBtn}><Download className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => c.setShowImportPack(true)} title={t("pack.import.button")} aria-label={t("pack.import.button")} className={iconBtn}><PackageOpen className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => c.onSetShowCreateServer(true)} title={t("serverList.create")} aria-label={t("serverList.create")} className={iconBtn}><Plus className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          <ul className="space-y-1">
            {localServers.length === 0 && <li className={cn("px-2.5 py-3 text-xs text-theme-secondary", HIDE)}>{t("nui.sidebar.empty")}</li>}
            {localServers.map((s) => {
              const selected = mode === "host" && selectedServer === s.name;
              const running = runningServerName === s.name && (serverStatus === "online" || serverStatus === "starting" || serverStatus === "stopping");
              return (
                <li key={s.path} className="group/row relative">
                  <button
                    type="button"
                    onClick={() => select(s.name)}
                    title={s.name}
                    className={cn(ROW, "text-left", selected ? "bg-theme-accent border-theme-accent" : "border-transparent hover:bg-theme-muted")}
                  >
                    <span className="relative shrink-0">
                      <ServerAvatar path={s.path} name={s.name} size="xs" />
                      {running && <span className="absolute -right-0.5 -top-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-[var(--card-bg)]" />}
                    </span>
                    <span className={cn("min-w-0 flex-1", HIDE)}>
                      <span className="block text-sm font-bold truncate">{s.name}</span>
                      <span className="block text-[11px] text-theme-secondary truncate">{s.version || t("serverList.versionNotFound")}</span>
                    </span>
                  </button>
                  <div className={cn("absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100", HIDE)}>
                    <button
                      type="button"
                      onClick={() => { if (select(s.name)) goToHostTab("settings"); }}
                      title={t("serverSettings.button")}
                      aria-label={t("serverSettings.button")}
                      className="p-1.5 rounded-lg text-theme-secondary hover:text-indigo-600 hover:bg-theme-card cursor-pointer"
                    ><Settings className="w-3.5 h-3.5" /></button>
                    <button
                      type="button"
                      onClick={(e) => c.handleDeleteServer(s.name, e)}
                      disabled={isDeletingServer === s.name || running}
                      title={t("serverList.delete")}
                      aria-label={t("serverList.delete")}
                      className="p-1.5 rounded-lg text-theme-secondary hover:text-rose-500 hover:bg-rose-500/10 cursor-pointer disabled:opacity-30"
                    ><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Recolhido, as ações de criar/importar não cabem na linha do título: ficam aqui, só o ícone */}
          <div className="hidden group-data-[compact=true]/side:block mt-2">
            <button type="button" onClick={() => c.onSetShowCreateServer(true)} title={t("serverList.create")} aria-label={t("serverList.create")} className={cn(ROW, "border-transparent text-theme-secondary hover:text-indigo-600 hover:bg-theme-muted")}>
              <Plus className="w-4 h-4 shrink-0" />
            </button>
          </div>
        </div>

        <div>
          <div className={cn("px-2 mb-2 text-[10px] font-bold uppercase tracking-widest text-theme-secondary", HIDE)}>{t("nui.sidebar.play")}</div>
          <button
            type="button"
            onClick={() => onSetMode("guest")}
            title={t("nui.sidebar.join")}
            className={cn(ROW, mode === "guest" ? "bg-theme-accent border-theme-accent text-indigo-600" : "border-transparent text-theme-secondary hover:text-theme-primary hover:bg-theme-muted")}
          >
            <Monitor className="w-4 h-4 shrink-0" /><span className={cn("truncate", HIDE)}>{t("nui.sidebar.join")}</span>
          </button>
        </div>
      </nav>

      <div className="p-3 group-data-[compact=true]/side:p-2 border-t border-theme-card space-y-1">
        <button type="button" onClick={c.onOpenSubscribe} title={t("host.plus.subscribe")} className={cn(ROW, "border-transparent text-indigo-600 hover:bg-theme-accent")}>
          <Sparkles className="w-4 h-4 shrink-0" /><span className={cn("truncate", HIDE)}>Cubicase Plus</span>
        </button>
        {[
          { icon: HelpCircle, label: t("help.button"), onClick: onOpenHelp },
          { icon: Settings, label: t("app.settings"), onClick: onOpenSettings },
        ].map(({ icon: Icon, label, onClick }) => (
          <button key={label} type="button" title={label} onClick={onClick} className={cn(ROW, "border-transparent text-theme-secondary hover:text-theme-primary hover:bg-theme-muted")}>
            <Icon className="w-4 h-4 shrink-0" /><span className={cn("truncate", HIDE)}>{label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={panel.toggle}
          title={compact ? t("nui.sidebar.expand") : t("nui.sidebar.collapse")}
          aria-label={compact ? t("nui.sidebar.expand") : t("nui.sidebar.collapse")}
          className={cn(ROW, "border-transparent text-theme-secondary hover:text-theme-primary hover:bg-theme-muted")}
        >
          {compact ? <PanelLeftOpen className="w-4 h-4 shrink-0" /> : <PanelLeftClose className="w-4 h-4 shrink-0" />}
          <span className={cn("truncate", HIDE)}>{t("nui.sidebar.collapse")}</span>
        </button>
      </div>
    </aside>
  );
}
