// ============================================================
// Heartbeat do Minecraft: não regrava o que não mudou, e status velho deixa de valer na leitura
// ============================================================

import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BASE = "https://example.com";
let n = 0;
const ip = () => `10.8.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

async function createServer() {
  const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() },
    body: JSON.stringify({ name: "Hb", version: "1.20.1", serverType: "vanilla", description: "" }),
  });
  const body: any = await res.json();
  return { code: body.data.shortCode as string, secret: body.data.ownerSecret as string };
}

const heartbeat = (code: string, secret: string, body: object) =>
  SELF.fetch(`${BASE}/api/v1/servers/${code}/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Secret": secret }, body: JSON.stringify(body) });
const stored = async (code: string) => JSON.parse((await env.CUBEFORGE_REGISTRY.get(`session:${code}`))!);
const discover = async (code: string) => ((await (await SELF.fetch(`${BASE}/api/v1/servers/${code}`)).json()) as any).data.session;

/** Envelhece o registro como se o último heartbeat tivesse chegado há `ms`. */
async function ageSession(code: string, ms: number) {
  const s = await stored(code);
  s.lastHeartbeat = new Date(Date.now() - ms).toISOString();
  await env.CUBEFORGE_REGISTRY.put(`session:${code}`, JSON.stringify(s));
}

describe("heartbeat do Minecraft", () => {
  it("o primeiro cria o registro e aparece para os convidados", async () => {
    const { code, secret } = await createServer();
    expect((await heartbeat(code, secret, { status: "online", currentPlayers: 2 })).status).toBe(200);
    const s = await discover(code);
    expect(s.minecraftStatus).toBe("online");
    expect(s.currentPlayers).toBe(2);
  });

  it("heartbeat igual e recente não regrava (a data do registro fica como estava)", async () => {
    const { code, secret } = await createServer();
    await heartbeat(code, secret, { status: "online", currentPlayers: 2 });
    const first = (await stored(code)).lastHeartbeat;
    await new Promise((r) => setTimeout(r, 20));
    const res = await heartbeat(code, secret, { status: "online", currentPlayers: 2 });
    expect(res.status).toBe(200);
    expect((await stored(code)).lastHeartbeat).toBe(first);
  });

  it("qualquer mudança grava na hora: jogadores, status, porta e IP do Radmin", async () => {
    const { code, secret } = await createServer();
    let cur: Record<string, unknown> = { status: "online", currentPlayers: 2, port: 25565, radminIp: null };
    await heartbeat(code, secret, cur);
    // Cada passo muda UM campo em relação ao estado anterior.
    const steps: Record<string, unknown>[] = [{ currentPlayers: 3 }, { status: "stopping" }, { port: 25570 }, { radminIp: "26.1.2.3" }];
    for (const change of steps) {
      const before = (await stored(code)).lastHeartbeat;
      await new Promise((r) => setTimeout(r, 15));
      cur = { ...cur, ...change };
      await heartbeat(code, secret, cur);
      expect((await stored(code)).lastHeartbeat, JSON.stringify(change)).not.toBe(before);
    }
    expect(await stored(code)).toMatchObject({ status: "stopping", currentPlayers: 3, port: 25570, radminIp: "26.1.2.3" });
  });

  it("sinal de vida sem mudança, depois do prazo, renova o registro", async () => {
    const { code, secret } = await createServer();
    await heartbeat(code, secret, { status: "online", currentPlayers: 1 });
    await ageSession(code, 100_000); // mais velho que o prazo de renovação
    const old = (await stored(code)).lastHeartbeat;
    await heartbeat(code, secret, { status: "online", currentPlayers: 1 });
    expect((await stored(code)).lastHeartbeat).not.toBe(old);
  });

  it("status velho (host sumiu sem avisar) deixa de valer na leitura, mas um heartbeat novo o traz de volta", async () => {
    const { code, secret } = await createServer();
    await heartbeat(code, secret, { status: "online", currentPlayers: 4 });
    expect((await discover(code)).minecraftStatus).toBe("online");

    await ageSession(code, 6 * 60_000);
    const stale = await discover(code);
    expect(stale.minecraftStatus).toBeNull();

    await ageSession(code, 4 * 60_000); // ainda dentro da janela
    expect((await discover(code)).minecraftStatus).toBe("online");

    await ageSession(code, 6 * 60_000);
    await heartbeat(code, secret, { status: "online", currentPlayers: 4 });
    expect((await discover(code)).minecraftStatus).toBe("online");
  });

  it("o pedido de despertar continua sendo entregue mesmo quando o heartbeat não grava nada", async () => {
    const { code, secret } = await createServer();
    await heartbeat(code, secret, { status: "sleeping", currentPlayers: 0 });
    const wake = await SELF.fetch(`${BASE}/api/v1/servers/${code}/wake`, { method: "POST", headers: { "CF-Connecting-IP": ip() } });
    expect(wake.status).toBe(200);
    const res = await heartbeat(code, secret, { status: "sleeping", currentPlayers: 0 }); // igual ao anterior: sem gravação
    expect(((await res.json()) as any).data.wakeRequested).toBe(true);
    const again = await heartbeat(code, secret, { status: "sleeping", currentPlayers: 0 });
    expect(((await again.json()) as any).data.wakeRequested).toBe(false); // consumido uma vez só
  });
});
