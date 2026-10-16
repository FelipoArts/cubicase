import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { hostPhase, guestPhase, generateNetworkPassword, suggestedNetworkName, radminAddress, NO_RADMIN } = await import("@/lib/radmin");

const base = { installed: true, running: true, ip: "26.1.2.3" };

describe("fases de quem hospeda", () => {
  it("segue a ordem: instalar → criar a rede → firewall → pronto", () => {
    expect(hostPhase(NO_RADMIN, null)).toBe("install");
    expect(hostPhase({ installed: true, running: false, ip: null }, null)).toBe("network");
    expect(hostPhase({ installed: true, running: true, ip: null }, null)).toBe("network");
    expect(hostPhase(base, false)).toBe("firewall");
    expect(hostPhase(base, true)).toBe("ready");
  });
  it("enquanto verifica o firewall não finge que está bloqueado", () => {
    expect(hostPhase(base, null)).toBe("ready");
  });
});

describe("fases de quem entra", () => {
  it("segue a ordem: instalar → entrar na rede → o host está no Radmin? → alcançável?", () => {
    expect(guestPhase(NO_RADMIN, "26.9.9.9", true)).toBe("install");
    expect(guestPhase({ installed: true, running: true, ip: null }, "26.9.9.9", true)).toBe("network");
    expect(guestPhase(base, null, null)).toBe("host-missing");
    expect(guestPhase(base, "26.9.9.9", null)).toBe("checking");
    expect(guestPhase(base, "26.9.9.9", false)).toBe("unreachable");
    expect(guestPhase(base, "26.9.9.9", true)).toBe("ready");
  });
  it("só se diz 'pronto' com o teste de alcance dizendo que sim (os dados da rede nunca bastam)", () => {
    for (const reachable of [null, false] as const) expect(guestPhase(base, "26.9.9.9", reachable)).not.toBe("ready");
  });
});

describe("senha sugerida para a rede", () => {
  it("tem o tamanho pedido, sem caracteres ambíguos, e muda a cada vez", () => {
    const a = generateNetworkPassword(12);
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    expect(a).not.toMatch(/[0O1lI]/);
    expect(new Set(Array.from({ length: 20 }, () => generateNetworkPassword(12))).size).toBe(20);
  });
  it("descarta os bytes que enviesariam a escolha (mapa uniforme)", () => {
    // 57 letras: 256 - (256 % 57) = 228 → bytes ≥ 228 são descartados, não reaproveitados.
    const rnd = (n: number) => new Uint8Array(n).fill(230);
    let calls = 0;
    const mixed = (n: number) => (++calls === 1 ? rnd(n) : new Uint8Array(n).fill(0));
    expect(generateNetworkPassword(4, mixed)).toBe("aaaa"); // o primeiro lote (todos 230) foi ignorado
  });
});

describe("nome e endereço", () => {
  it("o nome sugerido é limpo e estável para o mesmo servidor", () => {
    expect(suggestedNetworkName("6Y6B6U")).toBe("cubicase-6y6b6u");
    expect(suggestedNetworkName("A-b_c d!")).toBe("cubicase-abcd");
  });
  it("sem o código do servidor o nome leva um sufixo aleatório (nome de rede do Radmin é único no mundo)", () => {
    const a = suggestedNetworkName(null);
    expect(a).toMatch(/^cubicase-[a-z2-9]{6}$/);
    expect(suggestedNetworkName("")).toMatch(/^cubicase-[a-z2-9]{6}$/);
    const many = new Set(Array.from({ length: 30 }, () => suggestedNetworkName(null)));
    expect(many.size).toBeGreaterThan(25);
    // bytes acima do limite são descartados (sem viés)
    let calls = 0;
    const rnd = (n: number) => (++calls === 1 ? new Uint8Array(n).fill(250) : new Uint8Array(n).fill(0));
    expect(suggestedNetworkName(null, rnd)).toBe("cubicase-aaaaaa");
  });
  it("o endereço omite a porta padrão do Minecraft", () => {
    expect(radminAddress("26.202.7.93", 25565)).toBe("26.202.7.93");
    expect(radminAddress("26.202.7.93", 25570)).toBe("26.202.7.93:25570");
  });
});
