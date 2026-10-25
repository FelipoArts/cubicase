"use client";

import { FolderOpen, Trash2 } from "lucide-react";
import { ServerConfigModal } from "@/app/ServerConfigModal";
import { ServerManagePanel } from "@/app/components/host/ServerManagePanel";
import { DiscordCard } from "@/app/components/host/DiscordCard";
import type { HostController } from "@/app/components/host/useHostController";
import { Card, MiniButton } from "../ui";

// Aba de configurações do servidor: o mesmo formulário do modal "Configurações do servidor" (nome, ícone, motd, modo de
// jogo, dificuldade, jogadores, porta, memória, link de convite, endereço no Minecraft...), só que aqui dentro da
// página. O modal continua existindo (menu lateral e atalhos). Abaixo: versão/atualização, pasta e exclusão.
export function SettingsTab({ c }: { c: HostController }) {
  const { t, serverInfo, selectedServer, serverStatus, serverDir, localServers, importedServerPaths } = c;
  if (!serverInfo || !selectedServer) return null;
  const stopped = serverStatus === "offline" || serverStatus === "crashed";

  return (
    <div className="space-y-5">
      <ServerConfigModal
        variant="inline"
        isOpen
        onClose={() => {}}
        serverDir={serverInfo.path}
        serverName={serverInfo.name}
        isImported={importedServerPaths.some((p: string) => p.toLowerCase() === serverInfo.path.toLowerCase())}
        existingServerNames={localServers.filter((s) => s.path !== serverInfo.path).map((s) => s.name)}
        shortCode={serverInfo.shortCode ?? null}
        serverStatus={serverStatus}
        onSaved={() => c.handleConfigSaved()}
        onRenamed={(result) => c.handleServerRenamed(serverInfo.path, result)}
      />

      <ServerManagePanel
        key={`version-${serverInfo.path}`}
        section="version"
        serverDir={serverInfo.path}
        serverName={serverInfo.name}
        serverType={serverInfo.serverType}
        serverStatus={serverStatus}
        mcVersion={serverInfo.version}
        serverInfo={serverInfo}
        onServerUpgraded={() => c.handleServerUpgraded(serverInfo.path)}
      />

      <DiscordCard key={`discord-${serverInfo.path}`} shortCode={serverInfo.shortCode ?? null} />

      <Card title={t("nui.settings.storage")} hint={t("nui.settings.storageHint")}>
        <div className="flex items-center gap-2">
          <p className="flex-1 min-w-0 text-xs font-mono text-theme-secondary truncate bg-theme-muted p-2.5 rounded-lg border border-theme-card" title={serverDir || ""}>{serverDir || t("config.loading")}</p>
          <MiniButton onClick={c.handleSelectDir} title={t("host.params.pickDir")}><FolderOpen className="w-3.5 h-3.5" />{t("nui.settings.change")}</MiniButton>
        </div>
      </Card>

      <Card title={t("nui.settings.delete")} className="border-rose-500/30">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-theme-secondary max-w-xl">{t("nui.settings.deleteHint")}</p>
          <MiniButton tone="danger" disabled={!stopped || c.isDeletingServer === selectedServer} onClick={(e) => c.handleDeleteServer(selectedServer, e)}>
            <Trash2 className="w-3.5 h-3.5" />{t("serverList.delete")}
          </MiniButton>
        </div>
      </Card>
    </div>
  );
}
