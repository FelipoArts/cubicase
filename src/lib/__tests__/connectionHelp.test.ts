import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDirectFailureCode, useConnectionHelp } from "../connectionHelp";

describe("connectionHelp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useConnectionHelp.setState({ open: false, reason: "manual", target: null, lastAutoOpenAt: 0 });
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

  it("o botão da Central de Ajuda abre sem servidor; abrir por um servidor guarda qual é", () => {
    useConnectionHelp.getState().showForServer({ shortCode: "ABC123", name: "Meu mundo" });
    expect(useConnectionHelp.getState().target).toEqual({ shortCode: "ABC123", name: "Meu mundo" });
    useConnectionHelp.getState().close();
    useConnectionHelp.getState().show("manual");
    expect(useConnectionHelp.getState().target).toBeNull();
  });

  it("a tentativa em andamento guarda o servidor, e uma falha logo depois abre a janela já com ele", () => {
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    useConnectionHelp.getState().setTarget({ shortCode: "ABC123", name: "Meu mundo" });
    expect(useConnectionHelp.getState().open).toBe(false);
    expect(useConnectionHelp.getState().showAuto("direct_failed")).toBe(true);
    expect(useConnectionHelp.getState().target?.shortCode).toBe("ABC123");
  });
});
