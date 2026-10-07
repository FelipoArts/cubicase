import { beforeEach, describe, expect, it, vi } from "vitest";

const getSlug = vi.fn();
const setSlug = vi.fn();
const getConnect = vi.fn();
const setConnect = vi.fn();
vi.mock("@/lib/inviteLink", () => ({ getServerSlug: (...a: unknown[]) => getSlug(...a), setServerSlug: (...a: unknown[]) => setSlug(...a) }));
vi.mock("@/lib/connectAddress", () => ({ getServerConnectName: (...a: unknown[]) => getConnect(...a), setConnectName: (...a: unknown[]) => setConnect(...a) }));

const { carryCustomNamesToNewCode } = await import("@/lib/codeRotation");

beforeEach(() => { [getSlug, setSlug, getConnect, setConnect].forEach((m) => m.mockReset()); });

describe("carryCustomNamesToNewCode", () => {
  it("sem nomes personalizados no código antigo não faz nada", async () => {
    getSlug.mockResolvedValue(null);
    getConnect.mockResolvedValue(null);
    expect(await carryCustomNamesToNewCode("OLD", "NEW")).toEqual({ hadCustomNames: false, moved: false, failed: false });
    expect(setSlug).not.toHaveBeenCalled();
    expect(setConnect).not.toHaveBeenCalled();
  });

  it("move link e endereço para o código novo", async () => {
    getSlug.mockResolvedValue("meu-server");
    getConnect.mockResolvedValue("meu-addr");
    setSlug.mockResolvedValue("meu-server");
    setConnect.mockResolvedValue("meu-addr");
    const r = await carryCustomNamesToNewCode("OLD", "NEW");
    expect(setSlug).toHaveBeenCalledWith("NEW", "meu-server");
    expect(setConnect).toHaveBeenCalledWith("NEW", "meu-addr");
    expect(r).toEqual({ hadCustomNames: true, moved: true, failed: false });
  });

  it("falha (sem login/Plus) é reportada, nunca lançada", async () => {
    getSlug.mockResolvedValue("meu-server");
    getConnect.mockResolvedValue(null);
    setSlug.mockRejectedValue(new Error("não autenticado"));
    expect(await carryCustomNamesToNewCode("OLD", "NEW")).toEqual({ hadCustomNames: true, moved: false, failed: true });
  });
});
