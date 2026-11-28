import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks dos plugins do Tauri e do histórico de diagnósticos (não existem em Node).
const checkMock = vi.fn();
const relaunchMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => checkMock(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: (...a: unknown[]) => relaunchMock(...a) }));
const pushDiagnostic = vi.fn();
vi.mock("@/app/diagnostics", () => ({ pushDiagnostic: (...a: unknown[]) => pushDiagnostic(...a) }));

import { useUpdaterStore, UPDATE_RETRY_COOLDOWN_MS, STARTUP_CHECK_TIMEOUT_MS, resetStartupForTests } from "../updater";

function makeUpdate(downloadAndInstall: () => Promise<void>, version = "9.9.9") {
  return { version, body: "notas", downloadAndInstall } as never;
}

function resetStore() {
  useUpdaterStore.setState({ phase: "idle", version: null, notes: null, progress: 0, dismissed: false, update: null, lastFailureAt: null, cooling: false });
}

describe("updater: instalar e tentar de novo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    checkMock.mockReset();
    relaunchMock.mockReset();
    pushDiagnostic.mockReset();
    resetStore();
  });
  afterEach(() => vi.useRealTimers());

  it("cliques repetidos em instalar disparam um único download", async () => {
    let release!: () => void;
    const download = vi.fn(() => new Promise<void>((r) => (release = r)));
    useUpdaterStore.setState({ phase: "available", update: makeUpdate(download), version: "9.9.9" });

    const { installAndRestart } = useUpdaterStore.getState();
    const clicks = [installAndRestart(), installAndRestart(), installAndRestart()];
    release();
    await Promise.all(clicks);

    expect(download).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("falha na instalação vira 'error' e guarda o horário da falha", async () => {
    const download = vi.fn(async () => { throw new Error("rede caiu"); });
    useUpdaterStore.setState({ phase: "available", update: makeUpdate(download) });

    await useUpdaterStore.getState().installAndRestart();

    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("error");
    expect(s.lastFailureAt).toBe(Date.now());
    expect(pushDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("retryInstall ignora cliques durante o cooldown e não consulta o servidor", async () => {
    useUpdaterStore.setState({ phase: "error", update: makeUpdate(async () => {}), lastFailureAt: Date.now() });

    await useUpdaterStore.getState().retryInstall();

    expect(checkMock).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().phase).toBe("error");
  });

  it("depois do cooldown, retryInstall refaz a checagem e instala a versão nova", async () => {
    const download = vi.fn(async () => {});
    checkMock.mockResolvedValue(makeUpdate(download, "10.0.0"));
    useUpdaterStore.setState({ phase: "error", update: makeUpdate(async () => { throw new Error("velho"); }), lastFailureAt: Date.now() });

    vi.advanceTimersByTime(UPDATE_RETRY_COOLDOWN_MS + 1);
    await useUpdaterStore.getState().retryInstall();

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState().version).toBe("10.0.0");
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("cliques repetidos em retryInstall fazem uma única checagem", async () => {
    let resolveCheck!: (v: unknown) => void;
    checkMock.mockImplementation(() => new Promise((r) => (resolveCheck = r)));
    useUpdaterStore.setState({ phase: "error", update: makeUpdate(async () => {}), lastFailureAt: Date.now() - UPDATE_RETRY_COOLDOWN_MS - 1 });

    const { retryInstall } = useUpdaterStore.getState();
    const clicks = [retryInstall(), retryInstall(), retryInstall()];
    resolveCheck(null);
    await Promise.all(clicks);

    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("se já está na última versão, o botão some (update volta a null)", async () => {
    checkMock.mockResolvedValue(null);
    useUpdaterStore.setState({ phase: "error", update: makeUpdate(async () => {}), lastFailureAt: Date.now() - UPDATE_RETRY_COOLDOWN_MS - 1 });

    await useUpdaterStore.getState().retryInstall();

    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.update).toBeNull();
  });

  it("falha ao checar no retry volta para 'error' com novo cooldown", async () => {
    checkMock.mockRejectedValue(new Error("offline"));
    useUpdaterStore.setState({ phase: "error", update: makeUpdate(async () => {}), lastFailureAt: Date.now() - UPDATE_RETRY_COOLDOWN_MS - 1 });

    await useUpdaterStore.getState().retryInstall();

    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("error");
    expect(s.lastFailureAt).toBe(Date.now());
  });
});

describe("updater: atualizar antes de abrir", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkMock.mockReset();
    relaunchMock.mockReset();
    pushDiagnostic.mockReset();
    resetStore();
    useUpdaterStore.setState({ startup: "checking", startupCheckOk: false });
    resetStartupForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("sem versão nova, abre o app e dispensa a segunda checagem", async () => {
    checkMock.mockResolvedValue(null);
    await useUpdaterStore.getState().runStartupUpdate();
    const s = useUpdaterStore.getState();
    expect(s.startup).toBe("open");
    expect(s.startupCheckOk).toBe(true);
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("com versão nova, instala e reinicia sem mostrar o app", async () => {
    const download = vi.fn(async () => {});
    checkMock.mockResolvedValue(makeUpdate(download, "10.0.0"));
    await useUpdaterStore.getState().runStartupUpdate();
    expect(download).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    // o app reinicia: o portão continua fechado até lá, para a interface antiga não piscar
    expect(useUpdaterStore.getState().startup).toBe("updating");
    expect(useUpdaterStore.getState().phase).toBe("ready");
  });

  it("se a instalação falhar, abre na versão atual com o botão de tentar de novo", async () => {
    checkMock.mockResolvedValue(makeUpdate(async () => { throw new Error("rede caiu"); }));
    await useUpdaterStore.getState().runStartupUpdate();
    const s = useUpdaterStore.getState();
    expect(s.startup).toBe("open");
    expect(s.phase).toBe("error");
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("sem internet (a checagem falha), abre o app e pede a checagem normal depois", async () => {
    checkMock.mockRejectedValue(new Error("offline"));
    await useUpdaterStore.getState().runStartupUpdate();
    const s = useUpdaterStore.getState();
    expect(s.startup).toBe("open");
    expect(s.startupCheckOk).toBe(false);
    expect(pushDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("rede que não responde: depois do limite, abre o app", async () => {
    checkMock.mockReturnValue(new Promise(() => {}));
    const run = useUpdaterStore.getState().runStartupUpdate();
    expect(useUpdaterStore.getState().startup).toBe("checking");
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_TIMEOUT_MS + 1);
    await run;
    expect(useUpdaterStore.getState().startup).toBe("open");
    expect(useUpdaterStore.getState().startupCheckOk).toBe(false);
  });

  it("chamadas repetidas (efeito montado duas vezes) checam uma vez só", async () => {
    checkMock.mockResolvedValue(null);
    await Promise.all([useUpdaterStore.getState().runStartupUpdate(), useUpdaterStore.getState().runStartupUpdate()]);
    expect(checkMock).toHaveBeenCalledTimes(1);
  });
});
