"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Plus, X, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

import { ModSyncModal } from "./ModSyncModal";

import type { GuestController } from "./useGuestController";

// Modais da biblioteca do Convidado (preparar e jogar, adicionar servidor). Compartilhados pela tela atual e pela nova.
export function GuestModals({ c }: { c: GuestController }) {
  const {
    t,
    knownServers,
    showAddModal,
    setShowAddModal,
    inviteCodeInput,
    setInviteCodeInput,
    isAdding,
    addError,
    setAddError,
    prepModalFor,
    setPrepModalFor,
    prepStates,
    handlePrepareAndPlay,
    handleConfirmPrepare,
    handleRetryFailedOnly,
    handleContinueAnyway,
    handleOpenMinecraftFinal,
    handleAddServer
  } = c;
  return (
    <>
      {/* Modal de Preparar e Jogar (instalar loader + sincronizar mods + abrir launcher) */}
      {prepModalFor && prepStates[prepModalFor] && (() => {
        const prepServer = knownServers.find(s => s.shortCode === prepModalFor);
        if (!prepServer) return null;
        return (
          <ModSyncModal
            serverName={prepServer.name}
            state={prepStates[prepModalFor]}
            onCancel={() => setPrepModalFor(null)}
            onConfirm={() => handleConfirmPrepare(prepServer)}
            onRetryAll={() => handlePrepareAndPlay(prepServer)}
            onRetryFailedOnly={() => handleRetryFailedOnly(prepServer)}
            onContinueAnyway={() => handleContinueAnyway(prepServer)}
            onOpenMinecraft={() => handleOpenMinecraftFinal()}
          />
        );
      })()}

      {/* Modal de Adicionar Servidor */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
              onClick={() => { if (!isAdding) setShowAddModal(false); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: "spring", duration: 0.4 }}
              className="relative w-full max-w-sm bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center">
                    <Plus className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-bold text-theme-primary">{t("guest.modal.title")}</h3>
                </div>
                {!isAdding && (
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                    {t("guest.modal.code")}
                  </label>
                  <input
                    type="text"
                    placeholder="CF-XXXXXXXX"
                    value={inviteCodeInput}
                    onChange={(e) => {
                      setInviteCodeInput(e.target.value.toUpperCase());
                      setAddError(null);
                    }}
                    disabled={isAdding}
                    className={cn(
                      "w-full h-14 text-center text-2xl font-mono font-bold tracking-[0.1em] border-2 rounded-2xl transition-all uppercase bg-transparent text-theme-primary",
                      addError
                        ? "border-rose-400 focus:border-rose-500 focus:outline-none"
                        : "border-theme-card focus:border-indigo-500 focus:outline-none",
                      isAdding && "opacity-50"
                    )}
                    autoFocus
                  />
                  {addError && (
                    <p className="text-[10px] text-rose-500 font-bold flex items-center gap-1 mt-1">
                      <AlertTriangle className="w-3 h-3" /> {addError}
                    </p>
                  )}
                </div>

                <p className="text-[10px] text-theme-secondary italic leading-relaxed">
                  {t("guest.modal.hint")}
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t border-theme-card">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  disabled={isAdding}
                  className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold disabled:opacity-50 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleAddServer}
                  disabled={isAdding || !inviteCodeInput.startsWith("CF-")}
                  className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-theme-shadow cursor-pointer"
                >
                  {isAdding ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> {t("guest.modal.verifying")}</>
                  ) : (
                    <><Plus className="w-4 h-4" /> {t("guest.modal.add")}</>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
