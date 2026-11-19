import { describe, it, expect, beforeEach, vi } from "vitest";
import { markMilestone, MILESTONES } from "../milestones";
import { sendInstallPing, getInstallId, detectOs } from "../installPing";

const calls = (f: unknown) => (f as { mock: { calls: [string, { body: string }][] } }).mock.calls;
const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("installPing", () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  });

  it("o ID é aleatório, estável e só tem o formato esperado", () => {
    const a = getInstallId();
    expect(a).toMatch(/^[0-9a-f-]{32,36}$/i);
    expect(getInstallId()).toBe(a);
  });

  it("manda só id, versão e sistema", async () => {
    const f = okFetch();
    expect(await sendInstallPing(true, "0.8.4", f, 1_000_000)).toBe(true);
    const [url, init] = calls(f)[0];
    expect(url).toContain("/api/v1/installs/ping");
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(["e", "id", "os", "s", "v"]);
  });

  it("não manda se estiver desligado, nem duas vezes no mesmo dia", async () => {
    const f = okFetch();
    expect(await sendInstallPing(false, "0.8.4", f, 1_000_000)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(await sendInstallPing(true, "0.8.4", f, 1_000_000)).toBe(true);
    expect(await sendInstallPing(true, "0.8.4", f, 1_000_000 + 3600_000)).toBe(false);
    expect(await sendInstallPing(true, "0.8.4", f, 1_000_000 + 21 * 3600_000)).toBe(true);
  });

  it("falha de rede é silenciosa e tenta de novo depois", async () => {
    const bad = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await sendInstallPing(true, "0.8.4", bad, 5_000_000)).toBe(false);
    expect(await sendInstallPing(true, "0.8.4", okFetch(), 5_000_001)).toBe(true);
  });

  it("reenvia dentro do dia só se apareceu um marco novo, e no máximo de hora em hora", async () => {
    const f = okFetch();
    await sendInstallPing(true, "0.8.4", f, 10_000_000);
    markMilestone("server_started");
    expect(await sendInstallPing(true, "0.8.4", f, 10_000_000 + 10 * 60_000)).toBe(false); // cedo demais
    expect(await sendInstallPing(true, "0.8.4", f, 10_000_000 + 2 * 3600_000)).toBe(true);
    expect(JSON.parse(calls(f)[1][1].body).s).toBe(MILESTONES.server_started);
    expect(await sendInstallPing(true, "0.8.4", f, 10_000_000 + 4 * 3600_000)).toBe(false); // nada mudou
  });

  it("detecta o sistema", () => {
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectOs("")).toBe("other");
  });
});
