"use client";

import { useSyncExternalStore } from "react";

// ============================================================
// Estado do backup do mundo na interface
// ============================================================
// O Rust avisa (evento `world-backup`) quando um backup começa, termina ou falha: botão "Backup agora", backup
// automático ao parar o servidor e backup pedido pelo painel web / Discord. Em mundos grandes isso leva minutos, e sem
// um aviso a pessoa não sabe que precisa esperar (nem que pode fechar o app cedo demais).
// ============================================================

export type BackupPhase = "idle" | "running" | "done" | "failed";

export interface BackupUiState {
  phase: BackupPhase;
  /** "app" = botão ou backup automático; "remote" = pedido pelo painel web / Discord. */
  source: "app" | "remote" | null;
  serverName: string;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
}

/** Payload do evento `world-backup` (ver BackupEvent em src-tauri/src/lib.rs). */
export interface BackupEventPayload {
  state: "started" | "finished" | "failed";
  source: string;
  serverName: string;
  fileName?: string | null;
  sizeBytes?: number | null;
  error?: string | null;
}

export const DONE_VISIBLE_MS = 6000;
export const FAILED_VISIBLE_MS = 12000;

const IDLE: BackupUiState = { phase: "idle", source: null, serverName: "", fileName: null, sizeBytes: null, error: null };

let state: BackupUiState = IDLE;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: BackupUiState) {
  state = next;
  listeners.forEach((l) => l());
}

function clearTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** Esconde o aviso de resultado (concluído/falhou). Um backup em andamento nunca é escondido. */
export function dismissBackup() {
  clearTimer();
  if (state.phase === "done" || state.phase === "failed") set(IDLE);
}

export function applyBackupEvent(ev: BackupEventPayload) {
  clearTimer();
  const source = ev.source === "remote" ? "remote" : "app";
  if (ev.state === "started") {
    set({ phase: "running", source, serverName: ev.serverName, fileName: null, sizeBytes: null, error: null });
    return;
  }
  const done = ev.state === "finished";
  set({
    phase: done ? "done" : "failed",
    source,
    serverName: ev.serverName,
    fileName: ev.fileName ?? null,
    sizeBytes: ev.sizeBytes ?? null,
    error: done ? null : ev.error ?? "?",
  });
  hideTimer = setTimeout(dismissBackup, done ? DONE_VISIBLE_MS : FAILED_VISIBLE_MS);
}

export function resetBackupState() {
  clearTimer();
  set(IDLE);
}

export function useBackupState(): BackupUiState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}

/** Liga o evento do Rust ao estado. Chamar uma vez ao montar o app; devolve a função de limpeza. */
export async function listenBackupEvents(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<BackupEventPayload>("world-backup", (event) => applyBackupEvent(event.payload));
}
