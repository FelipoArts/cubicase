import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDirectFailureCode, radminJoinAddress, RADMIN_DOWNLOAD_URL, useConnectionHelp } from "../connectionHelp";

describe("connectionHelp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useConnectionHelp.setState({ open: false, reason: "manual", lastAutoOpenAt: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("só falhas de ligação entre os computadores abrem a ajuda sozinha", () => {
    expect(isDirectFailureCode("peer_failed")).toBe(true);
    // host offline, sala de sinalização fora do ar e queda de conexão têm outra solução
    expect(isDirectFailureCode("host_unreachable")).toBe(false);
    expect(isDirectFailureCode("signal_unreachable")).toBe(false);
    expect(isDirectFailureCode("connection_lost")).toBe(false);
    expect(isDirectFailureCode(undefined)).toBe(false);
  });

  it("o endereço do Radmin omite a porta padrão do Minecraft", () => {
    expect(radminJoinAddress("26.202.7.93", 25565)).toBe("26.202.7.93");
    expect(radminJoinAddress("26.202.7.93", 25570)).toBe("26.202.7.93:25570");
  });

  it("abre sozinha no máximo uma vez a cada 10 minutos", () => {
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const s = useConnectionHelp.getState();
    expect(s.showAuto("direct_failed")).toBe(true);
    expect(useConnectionHelp.getState().open).toBe(true);
    useConnectionHelp.getState().close();

    vi.advanceTimersByTime(60_000);
    expect(useConnectionHelp.getState().showAuto("direct_failed")).toBe(false); // reconexão em laço
    expect(useConnectionHelp.getState().open).toBe(false);

    vi.advanceTimersByTime(10 * 60_000);
    expect(useConnectionHelp.getState().showAuto("direct_failed")).toBe(true);
  });

  it("o botão manual abre mesmo dentro do intervalo e não reabre por cima de uma janela aberta", () => {
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    useConnectionHelp.getState().showAuto("direct_failed");
    useConnectionHelp.getState().close();
    useConnectionHelp.getState().show("manual");
    expect(useConnectionHelp.getState().open).toBe(true);
    expect(useConnectionHelp.getState().reason).toBe("manual");
    expect(useConnectionHelp.getState().showAuto("relay_quota")).toBe(false);
  });

  it("aponta para o site oficial do Radmin VPN", () => {
    expect(new URL(RADMIN_DOWNLOAD_URL).hostname).toBe("www.radmin-vpn.com");
  });
});
