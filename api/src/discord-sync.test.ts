// ============================================================
// Discord: status ao vivo, "como entrar", avisos e host que some — com um Discord falso
// ============================================================

import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createLinkCode, redeemLinkCode, handleInteraction, type DiscordEnv, type InteractionDeps } from "./discord";
import type { DiscordApi, ApiResult } from "./discord-api";
import {
  deriveNotices, getConfig, setStatusChannel, setAlertsChannel, postInvite, notifyChange, notifyContactLost, disableChannel,
  newConfig, saveConfig, type McSnapshot,
} from "./discord-sync";
import type { ServerStatusView } from "./discord-text";
import { setDiscordApiForTests, watchDiscordContact } from "./index";

const E = env as unknown as DiscordEnv;
const BASE = "https://example.com";

type Call = { op: "send" | "edit" | "pin" | "unpin"; channelId: string; messageId?: string; body?: any };
function fakeApi() {
  const calls: Call[] = [];
  const behavior: { edit?: () => ApiResult<unknown>; send?: () => ApiResult<{ id: string }>; guild?: () => ApiResult<{ id: string; name: string }>; channels?: () => ApiResult<{ id: string; name: string; type: number }[]> } = {};
  let n = 0;
  const api: DiscordApi = {
    send: async (channelId, body) => { calls.push({ op: "send", channelId, body }); return behavior.send?.() ?? { ok: true, data: { id: `msg${++n}` } }; },
    edit: async (channelId, messageId, body) => { calls.push({ op: "edit", channelId, messageId, body }); return behavior.edit?.() ?? { ok: true, data: null }; },
    pin: async (channelId, messageId) => { calls.push({ op: "pin", channelId, messageId }); return { ok: true, data: null }; },
    unpin: async (channelId, messageId) => { calls.push({ op: "unpin", channelId, messageId }); return { ok: true, data: null }; },
    me: async () => ({ ok: true, data: { id: "123456789012345678", username: "Cubicase" } }),
    channel: async (id) => ({ ok: true, data: { id } }),
    roles: async () => ({ ok: true, data: [{ id: "123456789012345678", name: "Operadores" }, { id: "1", name: "Cubicase", managed: true }] }),
    guild: async (id) => behavior.guild?.() ?? { ok: true, data: { id, name: "Meu Discord" } },
    channels: async () => behavior.channels?.() ?? { ok: true, data: [{ id: "111111", name: "status", type: 0 }, { id: "333333", name: "avisos", type: 0 }, { id: "444444", name: "geral", type: 5 }, { id: "555555", name: "voz", type: 2 }] },
  };
  return { api, calls, behavior };
}
const GONE = { ok: false, status: 404, code: 10003, gone: true, messageGone: false } as const;
const MSG_GONE = { ok: false, status: 404, code: 10008, gone: false, messageGone: true } as const;

let n = 0;
const sc = () => `D${String(Date.now()).slice(-5)}${n++}`.slice(0, 8).toUpperCase();
const guildId = () => String(800000000000000000n + BigInt(n++ * 104729 + Math.floor(Math.random() * 1000)));
const view = (over: Partial<ServerStatusView> = {}): ServerStatusView => ({ name: "Mundo", version: "1.20.1", slug: null, serverType: "forge", minecraftStatus: "online", currentPlayers: 2, maxPlayers: 20, ...over });
const snap = (status: string, names: string[] | null, max = 20): McSnapshot => ({ status, players: names?.length ?? 0, maxPlayers: max, names });
const events = { joins: true, power: true, offline: true };

describe("deriveNotices", () => {
  it("ligar, desligar e cair", () => {
    expect(deriveNotices(snap("starting", []), snap("online", []), events, "pt", "Mundo")).toEqual(["🟢 **Mundo** está ligado! Bora jogar."]);
    expect(deriveNotices(snap("online", []), snap("offline", []), events, "pt", "Mundo")).toEqual(["🔴 **Mundo** foi desligado."]);
    expect(deriveNotices(snap("online", []), snap("crashed", []), events, "pt", "Mundo")[0]).toContain("inesperada");
    expect(deriveNotices(null, snap("online", []), events, "en", "Mundo")[0]).toContain("is online");
  });

  it("ficar online de novo sem mudar de estado não repete o aviso", () => {
    expect(deriveNotices(snap("online", ["Ana"]), snap("online", ["Ana"]), events, "pt", "Mundo")).toEqual([]);
    expect(deriveNotices(snap("sleeping", []), snap("offline", []), events, "pt", "Mundo")).toEqual([]);
  });

  it("entrou e saiu, agrupado", () => {
    const out = deriveNotices(snap("online", ["Ana", "Bia"]), snap("online", ["Bia", "Caio", "Davi"]), events, "pt", "Mundo");
    expect(out).toEqual(["➕ **Caio, Davi** entraram — 3/20 online", "➖ **Ana** saiu — 3/20 online"]);
  });

  it("ao ligar ou desligar a lista inteira muda, mas isso não vira 'entrou/saiu'", () => {
    expect(deriveNotices(snap("starting", []), snap("online", ["Ana"]), events, "pt", "M").filter((x) => x.startsWith("➕"))).toEqual([]);
    expect(deriveNotices(snap("online", ["Ana"]), snap("stopping", []), events, "pt", "M")).toEqual([]);
  });

  it("sem nomes (servidor sem Discord) não há aviso de jogador", () => {
    expect(deriveNotices(snap("online", null), snap("online", null), events, "pt", "M")).toEqual([]);
  });

  it("cada tipo de aviso pode ser desligado", () => {
    expect(deriveNotices(snap("starting", []), snap("online", []), { ...events, power: false }, "pt", "M")).toEqual([]);
    expect(deriveNotices(snap("online", ["A"]), snap("online", []), { ...events, joins: false }, "pt", "M")).toEqual([]);
    expect(deriveNotices(snap("online", []), snap("crashed", []), { ...events, offline: false }, "pt", "M")).toEqual([]);
  });

  it("nomes não viram formatação nem menção", () => {
    const out = deriveNotices(snap("online", []), snap("online", ["**@everyone**", "a_b"]), events, "pt", "M");
    expect(out[0]).not.toContain("@");
    expect(out[0]).not.toContain("*@");
    expect(out[0]).toContain("everyone, ab");
  });
});

describe("configuração e publicação", () => {
  it("status: publica uma mensagem e depois só edita", async () => {
    const server = sc(), guild = guildId(), { api, calls } = fakeApi();
    expect(await setStatusChannel(E, api, server, guild, "111111", "pt", view())).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.embeds[0].title).toBe("Mundo");
    expect(calls[0].body.components[0].components[0].url).toBe(`https://play.cubicase.net/${server.toLowerCase()}`);
    expect((await getConfig(E, server, guild))?.status).toEqual({ channelId: "111111", messageId: "msg1" });

    await notifyChange(E, api, server, [guild], snap("online", ["Ana"]), snap("online", ["Ana", "Bia"]), view({ currentPlayers: 2 }));
    expect(calls.map((c) => c.op)).toEqual(["send", "edit"]);
    expect(calls[1]).toMatchObject({ channelId: "111111", messageId: "msg1" });
  });

  it("mensagem apagada por alguém: recria e passa a editar a nova", async () => {
    const server = sc(), guild = guildId(), { api, calls, behavior } = fakeApi();
    await setStatusChannel(E, api, server, guild, "111111", "pt", view());
    behavior.edit = () => MSG_GONE;
    await notifyChange(E, api, server, [guild], null, snap("online", []), view());
    expect(calls.map((c) => c.op)).toEqual(["send", "edit", "send"]);
    expect((await getConfig(E, server, guild))?.status?.messageId).toBe("msg2");
  });

  it("canal apagado ou permissão retirada: marca como quebrado e para de tentar", async () => {
    const server = sc(), guild = guildId(), { api, calls, behavior } = fakeApi();
    await setStatusChannel(E, api, server, guild, "111111", "pt", view());
    behavior.edit = () => GONE;
    await notifyChange(E, api, server, [guild], null, snap("online", []), view());
    expect((await getConfig(E, server, guild))?.broken?.status).toBe(true);
    const before = calls.length;
    await notifyChange(E, api, server, [guild], null, snap("online", []), view());
    expect(calls).toHaveLength(before); // nada mais é enviado
    // configurar de novo conserta
    behavior.edit = undefined;
    await setStatusChannel(E, api, server, guild, "222222", "pt", view());
    expect((await getConfig(E, server, guild))?.broken?.status).toBe(false);
  });

  it("falha ao publicar não guarda um canal onde o bot não escreve", async () => {
    const server = sc(), guild = guildId(), { api, behavior } = fakeApi();
    behavior.send = () => ({ ...GONE, status: 403, code: 50001 });
    const res = await setStatusChannel(E, api, server, guild, "111111", "pt", view());
    expect(res.ok).toBe(false);
    expect(await getConfig(E, server, guild)).toBeNull();
  });

  it("avisos: uma mensagem por mudança, sem menções", async () => {
    const server = sc(), guild = guildId(), { api, calls } = fakeApi();
    await setAlertsChannel(E, api, server, guild, "333333", "pt", view());
    calls.length = 0;
    await notifyChange(E, api, server, [guild], snap("online", ["Ana"]), snap("online", ["Ana", "Bia"]), view());
    expect(calls).toHaveLength(1);
    expect(calls[0].body.content).toBe("➕ **Bia** entrou — 2/20 online");
    expect(calls[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("'como entrar' é fixado; repetir no mesmo canal edita em vez de duplicar", async () => {
    const server = sc(), guild = guildId(), { api, calls } = fakeApi();
    await postInvite(E, api, server, guild, "444444", "pt", view());
    expect(calls.map((c) => c.op)).toEqual(["send", "pin"]);
    expect(calls[0].body.embeds[0].title).toBe("Como entrar em Mundo");
    await postInvite(E, api, server, guild, "444444", "pt", view({ name: "Mundo 2" }));
    expect(calls.map((c) => c.op)).toEqual(["send", "pin", "edit"]);
    await postInvite(E, api, server, guild, "555555", "pt", view());
    expect(calls.slice(3).map((c) => c.op)).toEqual(["send", "pin"]); // outro canal: mensagem nova
  });

  it("desativar remove só o que foi pedido", async () => {
    const server = sc(), guild = guildId(), { api } = fakeApi();
    await setStatusChannel(E, api, server, guild, "111111", "pt", view());
    await setAlertsChannel(E, api, server, guild, "333333", "pt", view());
    expect(await disableChannel(E, server, guild, "status")).toBe(true);
    expect(await disableChannel(E, server, guild, "status")).toBe(false);
    const cfg = await getConfig(E, server, guild);
    expect(cfg?.status).toBeUndefined();
    expect(cfg?.alerts).toEqual({ channelId: "333333" });
  });

  it("host que some: avisa uma vez, mostra como desligado e volta ao normal quando ele reaparece", async () => {
    const server = sc(), guild = guildId(), { api, calls } = fakeApi();
    await setStatusChannel(E, api, server, guild, "111111", "pt", view());
    await setAlertsChannel(E, api, server, guild, "333333", "pt", view());
    calls.length = 0;
    await notifyContactLost(E, api, server, [guild], view());
    await notifyContactLost(E, api, server, [guild], view()); // segunda rodada da rotina: não repete
    expect(calls.map((c) => c.op)).toEqual(["edit", "send"]);
    expect(calls[0].body.embeds[0].description).toBe("🔴 Desligado");
    expect(calls[1].body.content).toContain("parou de responder");
    expect((await getConfig(E, server, guild))?.contactLost).toBe(true);
    await notifyChange(E, api, server, [guild], null, snap("online", []), view());
    expect((await getConfig(E, server, guild))?.contactLost).toBe(false);
  });
});

describe("comandos de canal", () => {
  const MANAGE = String(1 << 5);
  const cmd = (guild: string, sub: string, options: unknown[], extra: Record<string, unknown> = {}) => ({
    type: 2, guild_id: guild, channel_id: "777777", locale: "pt-BR", member: { permissions: MANAGE },
    data: { name: "cubicase", options: [{ type: 1, name: sub, options }], resolved: { channels: { "666666": { type: 0 } } } }, ...extra,
  });
  const base = (api: DiscordApi | null): InteractionDeps => ({ getStatus: async () => view(), api });

  async function linked() {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, `u-${n++}`)).code, guild);
    return { server, guild };
  }

  it("canal status publica o status e responde para todos verem", async () => {
    const { guild } = await linked();
    const { api, calls } = fakeApi();
    const res: any = await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "status" }, { name: "canal", type: 7, value: "666666" }]), base(api));
    expect(res.data.content).toContain("<#666666>");
    expect(res.data.flags).toBe(0);
    expect(calls[0]).toMatchObject({ op: "send", channelId: "666666" });
  });

  it("quem não gerencia o Discord não configura nada", async () => {
    const { guild } = await linked();
    const { api, calls } = fakeApi();
    const res: any = await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "status" }, { name: "canal", type: 7, value: "666666" }], { member: { permissions: "0" } }), base(api));
    expect(res.data.content).toContain("Gerenciar Servidor");
    expect(calls).toHaveLength(0);
  });

  it("sem acesso ao canal, explica as permissões que faltam", async () => {
    const { guild } = await linked();
    const { api, behavior } = fakeApi();
    behavior.send = () => ({ ...GONE, status: 403, code: 50001 });
    const res: any = await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "alerts" }, { name: "canal", type: 7, value: "666666" }]), base(api));
    expect(res.data.content).toContain("Ver Canal");
  });

  it("canal que não é de texto é recusado", async () => {
    const { guild } = await linked();
    const { api, calls } = fakeApi();
    const interaction: any = cmd(guild, "canal", [{ name: "tipo", type: 3, value: "status" }, { name: "canal", type: 7, value: "666666" }]);
    interaction.data.resolved.channels["666666"].type = 2; // canal de voz
    const res: any = await handleInteraction(E, interaction, base(api));
    expect(res.data.content).toContain("canal de texto");
    expect(calls).toHaveLength(0);
  });

  it("convite publica no canal onde o comando foi usado", async () => {
    const { guild } = await linked();
    const { api, calls } = fakeApi();
    const res: any = await handleInteraction(E, cmd(guild, "convite", []), base(api));
    expect(res.data.content).toContain("<#777777>");
    expect(calls.map((c) => c.op)).toEqual(["send", "pin"]);
  });

  it("avisos só ligam depois de escolher o canal dos avisos", async () => {
    const { server, guild } = await linked();
    const { api } = fakeApi();
    const opts = [{ name: "evento", type: 3, value: "joins" }, { name: "ligado", type: 5, value: false }];
    const before: any = await handleInteraction(E, cmd(guild, "avisos", opts), base(api));
    expect(before.data.content).toContain("/cubicase canal");
    await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "alerts" }, { name: "canal", type: 7, value: "666666" }]), base(api));
    const after: any = await handleInteraction(E, cmd(guild, "avisos", opts), base(api));
    expect(after.data.content).toContain("Desligado");
    expect((await getConfig(E, server, guild))?.events.joins).toBe(false);
  });

  it("desativar e desvincular limpam a configuração", async () => {
    const { server, guild } = await linked();
    const { api } = fakeApi();
    await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "status" }, { name: "canal", type: 7, value: "666666" }]), base(api));
    const off: any = await handleInteraction(E, cmd(guild, "desativar", [{ name: "tipo", type: 3, value: "status" }]), base(api));
    expect(off.data.content).toContain("desativado");
    const again: any = await handleInteraction(E, cmd(guild, "desativar", [{ name: "tipo", type: 3, value: "status" }]), base(api));
    expect(again.data.content).toContain("não estava configurado");
    await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "alerts" }, { name: "canal", type: 7, value: "666666" }]), base(api));
    await handleInteraction(E, cmd(guild, "desvincular", []), base(api));
    expect(await getConfig(E, server, guild)).toBeNull();
  });

  it("sem token do bot os comandos de canal avisam em vez de quebrar", async () => {
    const { guild } = await linked();
    const res: any = await handleInteraction(E, cmd(guild, "canal", [{ name: "tipo", type: 3, value: "status" }, { name: "canal", type: 7, value: "666666" }]), base(null));
    expect(res.data.content).toContain("não está configurado");
  });
});

describe("heartbeat e rotina agendada", () => {
  let fake: ReturnType<typeof fakeApi>;
  beforeEach(() => { fake = fakeApi(); setDiscordApiForTests(fake.api); });

  async function createServer(ipSuffix: number) {
    const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.66.0.${ipSuffix}` },
      body: JSON.stringify({ name: "Hb Discord", version: "1.20.1", serverType: "vanilla", description: "" }),
    });
    const b: any = (await res.json()).data;
    return { shortCode: b.shortCode as string, secret: b.ownerSecret as string };
  }
  const heartbeat = (code: string, secret: string, body: object) =>
    SELF.fetch(`${BASE}/api/v1/servers/${code}/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Secret": secret }, body: JSON.stringify(body) });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it("sem Discord ligado, os nomes dos jogadores não são guardados", async () => {
    const { shortCode, secret } = await createServer(11);
    await heartbeat(shortCode, secret, { status: "online", currentPlayers: 1, playerNames: ["Ana"] });
    const stored = JSON.parse((await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`))!);
    expect(stored.playerNames).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("com Discord ligado: atualiza o status e avisa quem entrou", async () => {
    const { shortCode, secret } = await createServer(12);
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, shortCode, `u-${n++}`)).code, guild);
    await setStatusChannel(E, fake.api, shortCode, guild, "111111", "pt", view());
    await setAlertsChannel(E, fake.api, shortCode, guild, "333333", "pt", view());
    fake.calls.length = 0;

    await heartbeat(shortCode, secret, { status: "online", currentPlayers: 1, playerNames: ["Ana"] });
    await settle();
    expect(fake.calls.some((c) => c.op === "edit" && c.channelId === "111111")).toBe(true);
    expect(fake.calls.find((c) => c.op === "send")?.body.content).toContain("está ligado");

    fake.calls.length = 0;
    await heartbeat(shortCode, secret, { status: "online", currentPlayers: 2, playerNames: ["Ana", "Bia"] });
    await settle();
    expect(fake.calls.find((c) => c.op === "send")?.body.content).toBe("➕ **Bia** entrou — 2/20 online");

    // heartbeat idêntico: nada a avisar nem a editar
    fake.calls.length = 0;
    await heartbeat(shortCode, secret, { status: "online", currentPlayers: 2, playerNames: ["Ana", "Bia"] });
    await settle();
    expect(fake.calls).toHaveLength(0);
  });

  it("nomes inválidos são ignorados", async () => {
    const { shortCode, secret } = await createServer(13);
    await redeemLinkCode(E, (await createLinkCode(E, shortCode, `u-${n++}`)).code, guildId());
    await heartbeat(shortCode, secret, { status: "online", currentPlayers: 3, playerNames: ["Ana", 5, "x".repeat(40), "a\nb", "Ana", ""] });
    const stored = JSON.parse((await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`))!);
    expect(stored.playerNames).toEqual(["Ana"]);
  });

  it("a rotina agendada percebe o host que sumiu e avisa uma vez", async () => {
    const { shortCode, secret } = await createServer(14);
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, shortCode, `u-${n++}`)).code, guild);
    await saveConfig(E, shortCode, guild, { ...newConfig("pt"), alerts: { channelId: "333333" } });
    await heartbeat(shortCode, secret, { status: "online", currentPlayers: 0, playerNames: [] });
    await settle();

    const raw = JSON.parse((await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`))!);
    raw.lastHeartbeat = new Date(Date.now() - 6 * 60_000).toISOString();
    await env.CUBEFORGE_REGISTRY.put(`session:${shortCode}`, JSON.stringify(raw));
    fake.calls.length = 0;

    await watchDiscordContact(E as any);
    await watchDiscordContact(E as any);
    const alerts = fake.calls.filter((c) => c.op === "send" && c.body.content?.includes("parou de responder"));
    expect(alerts).toHaveLength(1);
  });

  it("servidor que nunca ligou não gera aviso de 'sumiu'", async () => {
    const { shortCode } = await createServer(15);
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, shortCode, `u-${n++}`)).code, guild);
    await saveConfig(E, shortCode, guild, { ...newConfig("pt"), alerts: { channelId: "333333" } });
    fake.calls.length = 0;
    await watchDiscordContact(E as any);
    expect(fake.calls.filter((c) => c.body?.content?.includes(shortCode) || c.body?.content?.includes("parou"))).toHaveLength(0);
  });
});

describe("rotas de configuração do app", () => {
  let fake: ReturnType<typeof fakeApi>;
  beforeEach(() => { fake = fakeApi(); setDiscordApiForTests(fake.api); });

  async function setup(ipSuffix: number) {
    const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.67.0.${ipSuffix}` },
      body: JSON.stringify({ name: "Cfg Discord", version: "1.20.1", serverType: "forge", description: "" }),
    });
    const b: any = (await res.json()).data;
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, b.shortCode, `u-${n++}`)).code, guild);
    const headers = { "Content-Type": "application/json", "X-Owner-Secret": b.ownerSecret as string, "CF-Connecting-IP": `10.67.1.${ipSuffix}` };
    const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
      SELF.fetch(`${BASE}/api/v1/servers/${b.shortCode}/discord/${guild}${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { shortCode: b.shortCode as string, guild, call, headers };
  }

  it("exigem o segredo do dono e um Discord realmente ligado ao servidor", async () => {
    const { shortCode, guild } = await setup(21);
    const bare = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord/${guild}/channels`);
    expect(bare.status).toBe(401);
    const { call } = await setup(22);
    const other = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord/${guildId()}/channels`, { headers: { "X-Owner-Secret": "x".repeat(30) } });
    expect([401, 403]).toContain(other.status);
    expect((await call("GET", "/channels")).status).toBe(200);
  });

  it("lista só canais de texto e de avisos", async () => {
    const { call } = await setup(23);
    const body: any = await (await call("GET", "/channels")).json();
    expect(body.data.channels.map((c: any) => c.name)).toEqual(["status", "avisos", "geral"]);
  });

  it("escolher canal publica a mensagem e a lista mostra nome, canais e saúde", async () => {
    const { shortCode, call, headers } = await setup(24);
    const put = await call("PUT", "/config", { kind: "status", channelId: "111111" });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).data.config.status).toBe("111111");
    expect(fake.calls.some((c) => c.op === "send" && c.channelId === "111111")).toBe(true);

    const list: any = await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord`, { headers })).json();
    expect(list.data.guilds[0]).toMatchObject({ guildName: "Meu Discord", botPresent: true, config: { status: "111111", alerts: null } });
  });

  it("canal de voz ou de outro Discord é recusado", async () => {
    const { call } = await setup(25);
    expect((await call("PUT", "/config", { kind: "alerts", channelId: "555555" })).status).toBe(400); // voz
    expect((await call("PUT", "/config", { kind: "alerts", channelId: "999999" })).status).toBe(400); // não está na lista
    expect((await call("PUT", "/config", { kind: "nada", channelId: "111111" })).status).toBe(400);
    expect(fake.calls.filter((c) => c.op === "send")).toHaveLength(0);
  });

  it("bot sem permissão no canal: 422 e nada fica guardado", async () => {
    const { shortCode, guild, call } = await setup(26);
    fake.behavior.send = () => ({ ...GONE, status: 403, code: 50001 });
    expect((await call("PUT", "/config", { kind: "alerts", channelId: "333333" })).status).toBe(422);
    expect(await getConfig(E, shortCode, guild)).toBeNull();
  });

  it("avisos podem ser ligados e desligados, e o canal removido", async () => {
    const { shortCode, guild, call } = await setup(27);
    await call("PUT", "/config", { kind: "alerts", channelId: "333333" });
    const res: any = await (await call("PUT", "/config", { events: { joins: false, power: true, offline: "sim" } })).json();
    expect(res.data.config.events).toEqual({ joins: false, power: true, offline: true }); // valor que não é booleano é ignorado
    const removed: any = await (await call("PUT", "/config", { kind: "alerts", channelId: null })).json();
    expect(removed.data.config.alerts).toBeNull();
    expect((await getConfig(E, shortCode, guild))?.events.joins).toBe(false);
  });

  it("o teste manda a mensagem aos avisos; sem canal configurado, explica", async () => {
    const { call } = await setup(28);
    expect((await call("POST", "/test")).status).toBe(400);
    await call("PUT", "/config", { kind: "alerts", channelId: "333333" });
    fake.calls.length = 0;
    expect((await call("POST", "/test")).status).toBe(200);
    expect(fake.calls[0].body.content).toContain("Teste do Cubicase");
  });

  it("teste com o canal quebrado marca a ligação como quebrada", async () => {
    const { shortCode, guild, call } = await setup(29);
    await call("PUT", "/config", { kind: "alerts", channelId: "333333" });
    fake.behavior.send = () => GONE;
    expect((await call("POST", "/test")).status).toBe(422);
    expect((await getConfig(E, shortCode, guild))?.broken?.alerts).toBe(true);
  });

  it("bot removido do Discord: a lista mostra e as rotas avisam", async () => {
    const { shortCode, call, headers } = await setup(30);
    fake.behavior.guild = () => ({ ...GONE, status: 403, code: 50001 });
    fake.behavior.channels = () => ({ ...GONE, status: 403, code: 50001 });
    const list: any = await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord`, { headers })).json();
    expect(list.data.guilds[0].botPresent).toBe(false);
    expect((await call("GET", "/channels")).status).toBe(409);
  });

  it("falha de rede com o Discord não derruba a ligação na tela", async () => {
    const { shortCode, headers } = await setup(31);
    fake.behavior.guild = () => ({ ok: false, status: 0, gone: false, messageGone: false });
    const list: any = await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord`, { headers })).json();
    expect(list.data.guilds[0]).toMatchObject({ botPresent: true, guildName: null });
  });
});

describe("cargo de operador e console pelo app", () => {
  let fake: ReturnType<typeof fakeApi>;
  beforeEach(() => { fake = fakeApi(); setDiscordApiForTests(fake.api); });

  async function setup(ipSuffix: number) {
    const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.68.0.${ipSuffix}` },
      body: JSON.stringify({ name: "Roles", version: "1.20.1", serverType: "vanilla", description: "" }),
    });
    const b: any = (await res.json()).data;
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, b.shortCode, `u-${n++}`)).code, guild);
    const headers = { "Content-Type": "application/json", "X-Owner-Secret": b.ownerSecret as string, "CF-Connecting-IP": `10.68.1.${ipSuffix}` };
    const call = (method: string, path: string, body?: unknown) =>
      SELF.fetch(`${BASE}/api/v1/servers/${b.shortCode}/discord/${guild}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { shortCode: b.shortCode as string, guild, call };
  }

  it("lista só cargos que dá para escolher (sem os de bot)", async () => {
    const { call } = await setup(41);
    const body: any = await (await call("GET", "/roles")).json();
    expect(body.data.roles).toEqual([{ id: "123456789012345678", name: "Operadores" }]);
  });

  it("salva o cargo e o console, e a lista devolve os dois", async () => {
    const { shortCode, guild, call } = await setup(42);
    const saved: any = await (await call("PUT", "/config", { control: { operatorRoleId: "123456789012345678", console: true } })).json();
    expect(saved.data.config.control).toEqual({ operatorRoleId: "123456789012345678", console: true });
    expect((await getConfig(E, shortCode, guild))?.control).toEqual({ operatorRoleId: "123456789012345678", console: true });
    const cleared: any = await (await call("PUT", "/config", { control: { operatorRoleId: null } })).json();
    expect(cleared.data.config.control).toEqual({ operatorRoleId: null, console: true });
  });

  it("recusa cargo que não existe, que é de bot ou que é o @everyone", async () => {
    const { guild, call } = await setup(43);
    expect((await call("PUT", "/config", { control: { operatorRoleId: "999999999999999999" } })).status).toBe(400);
    expect((await call("PUT", "/config", { control: { operatorRoleId: "1" } })).status).toBe(400); // cargo de bot
    expect((await call("PUT", "/config", { control: { operatorRoleId: guild } })).status).toBe(400); // @everyone tem o id do servidor
  });
});
