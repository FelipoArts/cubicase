import { describe, it, expect } from "vitest";
import {
  IDLE_HOSTING_STATUS,
  hostingHeadline,
  isStopAction,
  isPrimaryDisabled,
  isHostingActive,
  isGuestActiveError,
  secondsUntilRetry,
  friendsCanJoin,
  type HostingStatus,
} from "../hosting";

const st = (over: Partial<HostingStatus>): HostingStatus => ({ ...IDLE_HOSTING_STATUS, ...over });
const base = { preparing: false, mcStatus: "offline" as const, hostNetOnline: false };

describe("hostingHeadline", () => {
  it("idle sem nada rodando → idle", () => {
    expect(hostingHeadline({ ...base, status: st({}) })).toBe("idle");
  });

  it("preparando (instalando Java) vence qualquer fase", () => {
    expect(hostingHeadline({ ...base, preparing: true, status: st({ phase: "onlineFriends" }) })).toBe("preparing");
  });

  it("acompanha as fases do orquestrador", () => {
    expect(hostingHeadline({ ...base, status: st({ phase: "starting" }) })).toBe("starting");
    expect(hostingHeadline({ ...base, status: st({ phase: "connecting" }) })).toBe("connecting");
    expect(hostingHeadline({ ...base, status: st({ phase: "onlineFriends" }) })).toBe("onlineFriends");
    expect(hostingHeadline({ ...base, status: st({ phase: "stopping" }) })).toBe("stopping");
    expect(hostingHeadline({ ...base, status: st({ phase: "crashed" }) })).toBe("crashed");
  });

  it("só local por escolha × só local por falha", () => {
    expect(hostingHeadline({ ...base, status: st({ phase: "localOnly", localOnlyReason: "userChoice" }) })).toBe("localOnlyChoice");
    expect(hostingHeadline({ ...base, status: st({ phase: "localOnly", localOnlyReason: "networkFailed" }) })).toBe("localOnlyFailed");
    expect(hostingHeadline({ ...base, status: st({ phase: "localOnly", localOnlyReason: "networkDropped" }) })).toBe("localOnlyFailed");
  });

  it("Minecraft de pé fora do orquestrador continua parável", () => {
    expect(hostingHeadline({ ...base, mcStatus: "online", status: st({}) })).toBe("localOnlyFailed");
    expect(hostingHeadline({ ...base, mcStatus: "online", hostNetOnline: true, status: st({}) })).toBe("onlineFriends");
    expect(hostingHeadline({ ...base, mcStatus: "starting", status: st({}) })).toBe("starting");
    expect(hostingHeadline({ ...base, mcStatus: "stopping", status: st({}) })).toBe("stopping");
    expect(hostingHeadline({ ...base, mcStatus: "crashed", status: st({}) })).toBe("crashed");
  });
});

describe("botão principal", () => {
  it("é 'Parar' enquanto há sessão e 'Iniciar' em idle/crash", () => {
    for (const h of ["starting", "connecting", "onlineFriends", "localOnlyChoice", "localOnlyFailed"] as const) {
      expect(isStopAction(h)).toBe(true);
    }
    for (const h of ["idle", "crashed", "preparing", "stopping"] as const) {
      expect(isStopAction(h)).toBe(false);
    }
  });

  it("fica desabilitado só durante preparação e parada", () => {
    expect(isPrimaryDisabled("preparing")).toBe(true);
    expect(isPrimaryDisabled("stopping")).toBe(true);
    expect(isPrimaryDisabled("starting")).toBe(false); // dá para cancelar uma subida lenta
    expect(isPrimaryDisabled("idle")).toBe(false);
  });
});

describe("helpers", () => {
  it("isHostingActive", () => {
    expect(isHostingActive("idle")).toBe(false);
    expect(isHostingActive("crashed")).toBe(false);
    expect(isHostingActive("localOnly")).toBe(true);
    expect(isHostingActive("stopping")).toBe(true);
  });

  it("reconhece o código de convidado ativo mesmo embrulhado em Error/espacos", () => {
    expect(isGuestActiveError("GUEST_ACTIVE")).toBe(true);
    expect(isGuestActiveError(" GUEST_ACTIVE \n")).toBe(true);
    expect(isGuestActiveError(new Error("GUEST_ACTIVE"))).toBe(false); // "Error: GUEST_ACTIVE" ≠ código puro
    expect(isGuestActiveError("outra coisa")).toBe(false);
  });

  it("secondsUntilRetry", () => {
    const now = 1_000_000;
    expect(secondsUntilRetry(st({ netRetryAtMs: now + 9_500 }), now)).toBe(10);
    expect(secondsUntilRetry(st({ netRetryAtMs: now - 1 }), now)).toBeNull();
    expect(secondsUntilRetry(st({ netRetryAtMs: null }), now)).toBeNull();
    expect(secondsUntilRetry(st({ netRetryAtMs: now + 5_000, netRetrying: true }), now)).toBeNull();
  });

  it("friendsCanJoin só em onlineFriends", () => {
    expect(friendsCanJoin(st({ phase: "onlineFriends" }))).toBe(true);
    expect(friendsCanJoin(st({ phase: "localOnly" }))).toBe(false);
    expect(friendsCanJoin(st({ phase: "connecting" }))).toBe(false);
  });
});
