import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBackupEvent, dismissBackup, resetBackupState, DONE_VISIBLE_MS, FAILED_VISIBLE_MS, useBackupState, type BackupUiState,
} from "@/lib/backupState";

// Lê o estado pelo mesmo caminho do componente, sem renderizar React.
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() };
});
const current = (): BackupUiState => useBackupState();

describe("estado do backup na interface", () => {
  beforeEach(() => { vi.useFakeTimers(); resetBackupState(); });
  afterEach(() => { vi.useRealTimers(); });

  it("começa parado", () => {
    expect(current().phase).toBe("idle");
  });

  it("enquanto roda, mostra o servidor e de onde veio o pedido, e não some sozinho", () => {
    applyBackupEvent({ state: "started", source: "remote", serverName: "Kukusen" });
    expect(current()).toMatchObject({ phase: "running", source: "remote", serverName: "Kukusen" });
    vi.advanceTimersByTime(60 * 60_000);
    expect(current().phase).toBe("running");
    dismissBackup();
    expect(current().phase).toBe("running"); // fechar manualmente só vale para resultados
  });

  it("ao terminar, mostra o arquivo e o tamanho por alguns segundos", () => {
    applyBackupEvent({ state: "started", source: "app", serverName: "Kukusen" });
    applyBackupEvent({ state: "finished", source: "app", serverName: "Kukusen", fileName: "world.zip", sizeBytes: 1234 });
    expect(current()).toMatchObject({ phase: "done", fileName: "world.zip", sizeBytes: 1234, error: null });
    vi.advanceTimersByTime(DONE_VISIBLE_MS - 1);
    expect(current().phase).toBe("done");
    vi.advanceTimersByTime(2);
    expect(current().phase).toBe("idle");
  });

  it("falha fica mais tempo na tela e mostra o motivo", () => {
    applyBackupEvent({ state: "started", source: "app", serverName: "K" });
    applyBackupEvent({ state: "failed", source: "app", serverName: "K", error: "disco cheio" });
    expect(current()).toMatchObject({ phase: "failed", error: "disco cheio" });
    vi.advanceTimersByTime(DONE_VISIBLE_MS + 1);
    expect(current().phase).toBe("failed");
    vi.advanceTimersByTime(FAILED_VISIBLE_MS);
    expect(current().phase).toBe("idle");
  });

  it("um backup novo cancela o fim do aviso anterior", () => {
    applyBackupEvent({ state: "finished", source: "app", serverName: "K", fileName: "a.zip", sizeBytes: 1 });
    vi.advanceTimersByTime(DONE_VISIBLE_MS - 100);
    applyBackupEvent({ state: "started", source: "app", serverName: "K" });
    vi.advanceTimersByTime(1000);
    expect(current().phase).toBe("running");
  });

  it("origem desconhecida vira 'app'; fechar o resultado manualmente funciona", () => {
    applyBackupEvent({ state: "finished", source: "qualquer", serverName: "K", fileName: "a.zip" });
    expect(current().source).toBe("app");
    dismissBackup();
    expect(current().phase).toBe("idle");
  });
});
