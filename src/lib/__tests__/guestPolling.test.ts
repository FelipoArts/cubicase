import { describe, expect, it } from "vitest";
import { IDLE_POLL_INTERVAL_MS, isIdleServer, shouldPoll } from "@/lib/guestPolling";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const down = (lastSeenOnline: string | null) => ({ status: "offline", minecraftStatus: null as string | null, lastSeenOnline });

describe("isIdleServer", () => {
  it("parado há mais de 30 min (ou nunca visto) é ocioso", () => {
    expect(isIdleServer(down(null), NOW)).toBe(true);
    expect(isIdleServer(down(ago(31 * 60_000)), NOW)).toBe(true);
    expect(isIdleServer(down("lixo"), NOW)).toBe(true);
  });

  it("parado há pouco tempo ainda é consultado no ritmo normal", () => {
    expect(isIdleServer(down(ago(5 * 60_000)), NOW)).toBe(false);
  });

  it("ligado, iniciando ou em espera nunca é ocioso", () => {
    expect(isIdleServer({ status: "online", minecraftStatus: "online", lastSeenOnline: ago(99 * 60 * 60_000) }, NOW)).toBe(false);
    expect(isIdleServer({ status: "offline", minecraftStatus: "online", lastSeenOnline: null }, NOW)).toBe(false);
    expect(isIdleServer({ status: "offline", minecraftStatus: "starting", lastSeenOnline: null }, NOW)).toBe(false);
    expect(isIdleServer({ status: "offline", minecraftStatus: "sleeping", lastSeenOnline: null }, NOW)).toBe(false);
  });
});

describe("shouldPoll", () => {
  const idle = down(ago(3 * 60 * 60_000));
  const live = { status: "online", minecraftStatus: "online", lastSeenOnline: ago(1000) };

  it("primeira consulta e pedido manual sempre consultam", () => {
    expect(shouldPoll(idle, undefined, NOW, false)).toBe(true);
    expect(shouldPoll(idle, NOW - 1000, NOW, true)).toBe(true);
  });

  it("servidor ocioso só é consultado a cada 2 minutos", () => {
    expect(shouldPoll(idle, NOW - 30_000, NOW, false)).toBe(false);
    expect(shouldPoll(idle, NOW - 90_000, NOW, false)).toBe(false);
    expect(shouldPoll(idle, NOW - IDLE_POLL_INTERVAL_MS, NOW, false)).toBe(true);
  });

  it("servidor ativo é consultado em toda volta", () => {
    expect(shouldPoll(live, NOW - 30_000, NOW, false)).toBe(true);
  });
});
