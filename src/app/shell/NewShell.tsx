"use client";

import { HostModals } from "@/app/components/host/HostModals";
import { useHostController, type HostViewProps } from "@/app/components/host/useHostController";
import type { GuestViewProps } from "@/app/components/guest/useGuestController";
import { GuestWorkspace } from "./GuestWorkspace";
import { HostWorkspace } from "./HostWorkspace";
import { usePanel } from "./panels";
import { Sidebar } from "./Sidebar";

// Nova interface: menu lateral fixo + área de trabalho. O controlador do host fica sempre montado (a lista de
// servidores do menu e os modais de criar/importar/excluir dependem dele); o do Convidado só existe na tela do Convidado.

const SIDEBAR = { key: "sidebar", def: 256, min: 200, max: 380, collapsedWidth: 64 };

interface Props {
  host: HostViewProps;
  guest: GuestViewProps;
  mode: "host" | "guest";
  onSetMode: (m: "host" | "guest") => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
}

export function NewShell({ host, guest, mode, onSetMode, onOpenHelp, onOpenSettings }: Props) {
  const c = useHostController(host);
  const sidebar = usePanel(SIDEBAR);

  return (
    <div className="flex-1 min-h-0 flex bg-theme-base text-theme-primary overflow-hidden">
      <Sidebar c={c} mode={mode} onSetMode={onSetMode} onOpenHelp={onOpenHelp} onOpenSettings={onOpenSettings} panel={sidebar} />
      {mode === "host" ? <HostWorkspace c={c} /> : <GuestWorkspace {...guest} />}
      <HostModals c={c} />
    </div>
  );
}
