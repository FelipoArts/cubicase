import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@/app/diagnostics", () => ({ pushDiagnostic: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (k: string) => k }));

let prompted = false;
vi.mock("@/app/store", () => ({
  useAppStore: { getState: () => ({ firewallPrompted: prompted, setFirewallPrompted: (v: boolean) => { prompted = v; } }) },
}));

const { ensureFirewallPrompted, offerFirewallIfBlocked, useFirewallHelp } = await import("../firewall");
const { pushDiagnostic } = await import("@/app/diagnostics");

beforeEach(() => {
  invokeMock.mockReset();
  vi.mocked(pushDiagnostic).mockClear();
  prompted = false;
  useFirewallHelp.setState({ open: false, state: "idle", offered: false });
});

describe("ensureFirewallPrompted", () => {
  it("explica e abre as portas só na primeira vez", async () => {
    invokeMock.mockResolvedValue(undefined);
    await ensureFirewallPrompted();
    await ensureFirewallPrompted();
    expect(pushDiagnostic).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("prewarm_firewall");
  });

  it("não lança se o pré-aquecimento falhar", async () => {
    invokeMock.mockRejectedValue(new Error("x"));
    await expect(ensureFirewallPrompted()).resolves.toBeUndefined();
  });
});

describe("offerFirewallIfBlocked", () => {
  it("só abre a janela quando o Windows tem um bloqueio", async () => {
    invokeMock.mockResolvedValue("allowed");
    await offerFirewallIfBlocked();
    expect(useFirewallHelp.getState().open).toBe(false);

    invokeMock.mockResolvedValue("blocked");
    await offerFirewallIfBlocked();
    expect(useFirewallHelp.getState().open).toBe(true);
  });

  it("não insiste na mesma sessão", async () => {
    invokeMock.mockResolvedValue("blocked");
    await offerFirewallIfBlocked();
    useFirewallHelp.getState().close();
    invokeMock.mockClear();
    await offerFirewallIfBlocked();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("leitura que falha não abre nada", async () => {
    invokeMock.mockRejectedValue(new Error("x"));
    await offerFirewallIfBlocked();
    expect(useFirewallHelp.getState().open).toBe(false);
  });
});

describe("allow", () => {
  it("distingue cancelamento de erro e de sucesso", async () => {
    invokeMock.mockResolvedValue(undefined);
    await useFirewallHelp.getState().allow();
    expect(useFirewallHelp.getState().state).toBe("done");

    invokeMock.mockRejectedValue("cancelled");
    await useFirewallHelp.getState().allow();
    expect(useFirewallHelp.getState().state).toBe("cancelled");

    invokeMock.mockRejectedValue("failed:Some(1)");
    await useFirewallHelp.getState().allow();
    expect(useFirewallHelp.getState().state).toBe("error");
  });
});
