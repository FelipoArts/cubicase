// ============================================================
// Discord: o plano grátis depois que o Plus termina (7 dias de prazo, depois só a ligação mais antiga)
// ============================================================

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { enforcePlanLimits, activeGuilds, handleInteraction, LIMIT_GRACE_MS, type DiscordEnv, type InteractionDeps } from "./discord";
import type { DiscordApi } from "./discord-api";
import { saveConfig, newConfig } from "./discord-sync";
import { setDiscordApiForTests, watchDiscordContact } from "./index";

const E = env as unknown as DiscordEnv;
let n = 0;
const sc = () => `L${String(Date.now()).slice(-5)}${n++}`.slice(0, 8).toUpperCase();
const gid = () => String(600000000000000000n + BigInt(n++ * 7919 + Math.floor(Math.random() * 1000)));
const DAY = 24 * 60 * 60 * 1000;

/** Monta direto no KV um servidor com várias ligações (o que a conta Plus pôde fazer antes de vencer). */
async function seed(user: string, guildCount: number) {
  const server = sc();
  const guilds = Array.from({ length: guildCount }, () => gid());
  await env.CUBEFORGE_REGISTRY.put(`dserver:${server}`, JSON.stringify({ userId: user, guilds: guilds.map((g, i) => ({ guildId: g, linkedAt: new Date(1_700_000_000_000 + i * 1000).toISOString() })) }));
  for (const g of guilds) await env.CUBEFORGE_REGISTRY.put(`dguild:${g}`, JSON.stringify({ userId: user, servers: [server] }));
  return { server, guilds };
}
const stored = async (server: string) => JSON.parse((await env.CUBEFORGE_REGISTRY.get(`dserver:${server}`))!);
const never = async () => { throw new Error("não devia consultar o Plus"); };

describe("enforcePlanLimits", () => {
  it("dentro do plano grátis nem consulta o Plus", async () => {
    const { server } = await seed("u1", 1);
    expect(await enforcePlanLimits(E, server, never)).toEqual({ event: "none" });
  });

  it("com Plus, nada muda", async () => {
    const { server } = await seed("u2", 3);
    expect(await enforcePlanLimits(E, server, async () => true)).toEqual({ event: "none" });
    expect((await stored(server)).limitedSince).toBeUndefined();
  });

  it("sem Plus e com ligações demais: começa o prazo uma vez, e só pausa depois de 7 dias", async () => {
    const { server, guilds } = await seed("u3", 3);
    const t0 = 1_800_000_000_000;
    const first = await enforcePlanLimits(E, server, async () => false, t0);
    expect(first).toMatchObject({ event: "grace", endsAt: t0 + LIMIT_GRACE_MS });
    expect(await activeGuilds(E, server)).toEqual(guilds); // durante o prazo tudo continua

    expect(await enforcePlanLimits(E, server, async () => false, t0 + 6 * DAY)).toEqual({ event: "none" });
    const limited = await enforcePlanLimits(E, server, async () => false, t0 + 7 * DAY);
    expect(limited).toEqual({ event: "limited", guildIds: guilds });
    expect(await activeGuilds(E, server)).toEqual([guilds[0]]); // só a mais antiga
    expect(await enforcePlanLimits(E, server, async () => false, t0 + 8 * DAY)).toEqual({ event: "none" }); // não repete
    expect((await stored(server)).guilds).toHaveLength(3); // nada foi apagado
  });

  it("quando o Plus volta, reativa tudo e avisa", async () => {
    const { server, guilds } = await seed("u4", 2);
    const t0 = 1_800_000_000_000;
    await enforcePlanLimits(E, server, async () => false, t0);
    await enforcePlanLimits(E, server, async () => false, t0 + 8 * DAY);
    expect((await activeGuilds(E, server)).length).toBe(1);
    expect(await enforcePlanLimits(E, server, async () => true, t0 + 9 * DAY)).toEqual({ event: "restored", guildIds: guilds });
    expect(await activeGuilds(E, server)).toEqual(guilds);
    expect((await stored(server)).limited).toBeUndefined();
  });

  it("se as ligações voltam para dentro do plano grátis, o prazo é cancelado sem aviso", async () => {
    const { server, guilds } = await seed("u5", 2);
    await enforcePlanLimits(E, server, async () => false, 1_800_000_000_000);
    const rest = await stored(server);
    await env.CUBEFORGE_REGISTRY.put(`dserver:${server}`, JSON.stringify({ ...rest, guilds: [rest.guilds[0]] }));
    expect(await enforcePlanLimits(E, server, async () => false, 1_800_000_000_000 + DAY)).toEqual({ event: "none" });
    expect((await stored(server)).limitedSince).toBeUndefined();
    expect(guilds.length).toBe(2);
  });

  it("um Discord com vários servidores também conta como excesso", async () => {
    const user = "u6", s1 = sc(), s2 = sc(), g = gid();
    await env.CUBEFORGE_REGISTRY.put(`dserver:${s1}`, JSON.stringify({ userId: user, guilds: [{ guildId: g, linkedAt: new Date(1).toISOString() }] }));
    await env.CUBEFORGE_REGISTRY.put(`dguild:${g}`, JSON.stringify({ userId: user, servers: [s1, s2] }));
    expect((await enforcePlanLimits(E, s1, async () => false, 5)).event).toBe("grace");
    await enforcePlanLimits(E, s1, async () => false, 5 + 7 * DAY);
    expect(await activeGuilds(E, s1)).toEqual([g]); // s1 é o mais antigo do Discord: continua
    await env.CUBEFORGE_REGISTRY.put(`dserver:${s2}`, JSON.stringify({ userId: user, guilds: [{ guildId: g, linkedAt: new Date(2).toISOString() }], limited: true }));
    expect(await activeGuilds(E, s2)).toEqual([]); // s2 é o segundo: pausado
  });
});

describe("ligação pausada", () => {
  it("o controle pelo Discord é recusado com explicação", async () => {
    const { server, guilds } = await seed("u7", 2);
    await env.CUBEFORGE_REGISTRY.put(`dserver:${server}`, JSON.stringify({ ...(await stored(server)), limited: true }));
    const deps: InteractionDeps = {
      getStatus: async () => ({ name: "X", version: "1", minecraftStatus: null, currentPlayers: 0, maxPlayers: 20 }),
      api: null,
      control: async () => ({ ok: true }),
      isPlus: async () => true,
    };
    const interaction = (guild: string) => ({
      type: 2, guild_id: guild, locale: "pt-BR", member: { permissions: String(1 << 5), user: { id: String(500000 + n++), username: "ana" } },
      data: { name: "cubicase", options: [{ type: 1, name: "ligar", options: [] }] },
    });
    const paused: any = await handleInteraction(E, interaction(guilds[1]), deps);
    expect(paused.data.content).toContain("pausada");
    const active: any = await handleInteraction(E, interaction(guilds[0]), deps);
    expect(active.data.content).toContain("pediu para ligar");
  });
});

describe("rotina agendada", () => {
  const sent: { channelId: string; content: string }[] = [];
  beforeEach(() => {
    sent.length = 0;
    const api: DiscordApi = {
      send: async (channelId, body: any) => { sent.push({ channelId, content: body.content }); return { ok: true, data: { id: "m" } }; },
      edit: async () => ({ ok: true, data: null }), pin: async () => ({ ok: true, data: null }), unpin: async () => ({ ok: true, data: null }),
      me: async () => ({ ok: true, data: { id: "1", username: "b" } }), channel: async (id) => ({ ok: true, data: { id } }),
      guild: async (id) => ({ ok: true, data: { id, name: "D" } }), channels: async () => ({ ok: true, data: [] }), roles: async () => ({ ok: true, data: [] }),
    };
    setDiscordApiForTests(api);
  });

  it("avisa o início do prazo em cada Discord, uma vez só", async () => {
    const { server, guilds } = await seed("u8", 2);
    await env.CUBEFORGE_REGISTRY.put(`server:${server}`, JSON.stringify({ shortCode: server, uuid: "x", name: "Mundo Teste", version: "1.20.1", serverType: "vanilla", description: "", owner: "x", createdAt: "", updatedAt: "" }));
    for (const g of guilds) await saveConfig(E, server, g, { ...newConfig("pt"), alerts: { channelId: `9${g.slice(-5)}` } });

    await watchDiscordContact(E as any);
    const mine = sent.filter((m) => m.content.includes("Mundo Teste"));
    expect(mine).toHaveLength(2);
    expect(mine[0].content).toContain("terminou");
    await watchDiscordContact(E as any);
    expect(sent.filter((m) => m.content.includes("Mundo Teste"))).toHaveLength(2); // sem repetir
  });
});
