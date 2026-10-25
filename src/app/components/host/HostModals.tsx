"use client";

import { listLocalServers } from "@/lib/server";

import { ServerConfigModal } from "@/app/ServerConfigModal";

import { CreateServerModal } from "./CreateServerModal";
import { ImportModpackModal } from "./ImportModpackModal";
import { ImportPackModal } from "./ImportPackModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { SettingsModal } from "./SettingsModal";
import { ConfirmActionModal } from "./ConfirmActionModal";

import { AnimatePresence } from "framer-motion";
import type { HostController } from "./useHostController";

// Modais do painel do host (criar/importar/excluir servidor, configurações, confirmações). Compartilhados pela tela
// atual e pela nova interface: ambas só decidem ONDE o botão que os abre fica.
export function HostModals({ c }: { c: HostController }) {
  const {
    t,
    serverDir,
    minecraftPort,
    setSelectedServer,
    serverStatus,
    importedServerPaths,
    showImportModpack,
    setShowImportModpack,
    showImportPack,
    setShowImportPack,
    showRegenerateCode,
    setShowRegenerateCode,
    confirmLeaveGuest,
    setConfirmLeaveGuest,
    pendingModsWarning,
    setPendingModsWarning,
    pendingLocalOnly,
    handleStartHosting,
    handleCreateServer,
    handleImportModpack,
    handleConfirmDelete,
    handleSaveSettings,
    handleRegenerateCode,
    displayShortCode,
    localServers,
    showCreateServer,
    showSettings,
    showConfigModal,
    configServerDir,
    serverInstallProgress,
    deleteConfirmServer,
    totalSystemRamGb,
    onSetLocalServers,
    onSetShowCreateServer,
    onSetShowSettings,
    onSetShowConfigModal,
    onSetConfigServerDir,
    onSetDeleteConfirmServer
  } = c;
  return (
    <>
      {/* Este app só tem UMA rede por vez: hospedar exige sair do servidor onde está como Convidado. */}
      <ConfirmActionModal
        isOpen={confirmLeaveGuest}
        title={t("host.guestActive.title")}
        message={t("host.guestActive.message")}
        confirmLabel={t("host.guestActive.confirm")}
        onClose={() => setConfirmLeaveGuest(false)}
        onConfirm={async () => {
          setConfirmLeaveGuest(false);
          await handleStartHosting({ localOnly: pendingLocalOnly, leaveGuest: true, skipPendingCheck: true });
        }}
      />

      <ConfirmActionModal
        isOpen={!!pendingModsWarning}
        title={t("pendingMods.startTitle")}
        message={t("pendingMods.startMessage", { count: pendingModsWarning?.count ?? 0 })}
        confirmLabel={t("pendingMods.startConfirm")}
        onClose={() => setPendingModsWarning(null)}
        onConfirm={async () => {
          const opts = pendingModsWarning?.opts ?? {};
          setPendingModsWarning(null);
          await handleStartHosting({ ...opts, skipPendingCheck: true });
        }}
      />

      <CreateServerModal
        isOpen={showCreateServer}
        onClose={() => onSetShowCreateServer(false)}
        onCreate={handleCreateServer}
        installProgress={serverInstallProgress}
        totalRamGb={totalSystemRamGb}
      />

      <ImportModpackModal
        isOpen={showImportModpack}
        onClose={() => setShowImportModpack(false)}
        onImport={handleImportModpack}
        installProgress={serverInstallProgress}
        totalRamGb={totalSystemRamGb}
      />

      <ImportPackModal
        isOpen={showImportPack}
        onClose={() => setShowImportPack(false)}
        existingNames={localServers.map((s) => s.name)}
        onImported={async (name) => {
          const servers = await listLocalServers();
          onSetLocalServers(servers);
          setSelectedServer(name);
        }}
      />

      <DeleteConfirmModal
        serverName={deleteConfirmServer}
        onClose={() => onSetDeleteConfirmServer(null)}
        onConfirm={handleConfirmDelete}
        isImported={deleteConfirmServer ? localServers.some(s => {
          if (s.name !== deleteConfirmServer) return false;
          // Comparar: servidores dentro da pasta padrão não são importados
          const defaultPath = `${serverDir || ''}\\${s.name}`;
          return s.path.toLowerCase() !== defaultPath.toLowerCase();
        }) : false}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => onSetShowSettings(false)}
        currentPort={minecraftPort || 25565}
        onSave={handleSaveSettings}
      />

      <ConfirmActionModal
        isOpen={showRegenerateCode}
        title={t("host.regen.title")}
        message={t("host.regen.message", { code: displayShortCode })}
        confirmLabel={t("host.regen.confirm")}
        onClose={() => setShowRegenerateCode(false)}
        onConfirm={async () => {
          await handleRegenerateCode();
          setShowRegenerateCode(false);
        }}
      />

      <AnimatePresence>
        {showConfigModal && configServerDir && (
          <ServerConfigModal
            serverDir={configServerDir}
            serverName={localServers.find((s) => s.path === configServerDir)?.name ?? ""}
            isImported={importedServerPaths.some((p) => p.toLowerCase() === configServerDir.toLowerCase())}
            existingServerNames={localServers.filter((s) => s.path !== configServerDir).map((s) => s.name)}
            shortCode={localServers.find((s) => s.path === configServerDir)?.shortCode ?? null}
            isOpen={showConfigModal}
            onClose={() => {
              onSetShowConfigModal(false);
              onSetConfigServerDir(null);
            }}
            onSaved={() => c.handleConfigSaved()}
            onRenamed={(result) => c.handleServerRenamed(configServerDir, result)}
            serverStatus={serverStatus}
          />
        )}
      </AnimatePresence>
    </>
  );
}
