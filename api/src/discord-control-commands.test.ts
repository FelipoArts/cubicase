// ============================================================
// Discord: comandos de controle (ligar, desligar, whitelist, console, operador) com o app do host falso
// ============================================================

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createLinkCode, redeemLinkCode, handleInteraction, adoptServerOwner, listServerGuilds, type DiscordEnv, type InteractionDeps } from "./discord";
import type { DiscordApi } from "./discord-api";
import { setAlertsChannel } from "./discord-sync";
import type { ServerStatusView } from "./discord-text";

const E = env as unknown as DiscordEnv;
const MANAGE = String(1 << 5);
const ROLE = "123456789012345678";

let n = 0;
const sc = () => `C${String(Date.now()).slice(-5)}${n++}`.slice(0, 8).toUpperCase();
const guildId = () => String(700000000000000000n + BigInt(n++ * 104729 + Math.floor(Math.random() * 1000)));
const view = (): ServerStatusView => ({ name: "Mundo", version: "1.20.1", slug: null, serverType: "forge", minecraftStatus: "online", currentPlayers: 2, maxPlayers: 20 });

type Ctl = { ok: true } | { ok: false; reason: any };
type Sent = { op: string; channelId: string; body?: any };

function setup() {
  const sent: { sc: string; action: any; by: string }[] = [];
  const notified: unknown[] = [];
  const messages: Sent[] = [];
  const state: { result: Ctl; plus: boolean } = { result: { ok: true }, plus: true };
  const api: DiscordApi = {
    send: async (channelId, body) => { messages.push({ op: "send", channelId, body }); return { ok: true, data: { id: `m${n++}` } }; },
    edit: async () => ({ ok: true, data: null }),
    pin: async () => ({ ok: true, data: null }),
    unpin: async () => ({ ok: true, data: null }),
    me: async () => ({ ok: true, data: { id: "123456789012345678", username: "Cubicase" } }),
    channel: async (id) => ({ ok: true, data: { id } }),
    roles: async () => ({ ok: true, data: [{ id: "123456789012345678", name: "Operadores" }, { id: "1", name: "Cubicase", managed: true }] }),
    guild: async (id) => ({ ok: true, data: { id, name: "D" } }),
    channels: async () => ({ ok: true, data: [] }),
  };
  const deps: InteractionDeps = {
    getStatus: async () => view(),
    api,
    control: async (code, action, by, notify) => { sent.push({ sc: code, action, by }); notified.push(notify); return state.result; },
    isPlus: async () => state.plus,
  };
  return { sent, notified, messages, state, deps, api };
}

const cmd = (guild: string, sub: string, options: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: 2, guild_id: guild, channel_id: "777777", locale: "pt-BR",
  member: { permissions: MANAGE, roles: [], user: { id: String(100000 + n++), username: "ana" } },
  data: { name: "cubicase", options: [{ type: 1, name: sub, options }] }, ...extra,
});
const asMember = (interaction: any, over: Record<string, unknown>) => ({ ...interaction, member: { ...interaction.member, ...over } });
const text = async (i: unknown, deps: InteractionDeps) => ((await handleInteraction(E, i, deps)) as any).data.content as string;

async function linked() {
  const server = sc(), guild = guildId();
  await redeemLinkCode(E, (await createLinkCode(E, server, `u-${n++}`)).code, guild);
  return { server, guild };
}

describe("comandos de controle", () => {
  it("quem gerencia o Discord liga o servidor e o pedido chega ao app com o nome dele", async () => {
    const { server, guild } = await linked();
    const { deps, sent } = setup();
    expect(await text(cmd(guild, "ligar"), deps)).toContain("pediu para ligar");
    expect(sent).toEqual([{ sc: server, action: { kind: "start" }, by: "ana" }]);
  });

  it("membro comum não controla; o cargo de operador libera", async () => {
    const { guild } = await linked();
    const { deps, sent } = setup();
    expect(await text(asMember(cmd(guild, "desligar"), { permissions: "0", roles: [] }), deps)).toContain("Operador");
    expect(sent).toHaveLength(0);

    await handleInteraction(E, cmd(guild, "operador", [{ name: "cargo", type: 8, value: ROLE }]), deps);
    expect(await text(asMember(cmd(guild, "desligar"), { permissions: "0", roles: [ROLE] }), deps)).toContain("desligar");
    expect(sent).toHaveLength(1);
  });

  it("sem o Plus do host, nada é enviado", async () => {
    const { guild } = await linked();
    const { deps, sent, state } = setup();
    state.plus = false;
    expect(await text(cmd(guild, "ligar"), deps)).toContain("Cubicase Plus");
    expect(sent).toHaveLength(0);
  });

  it("a mesma pessoa não dispara dois comandos em sequência", async () => {
    const { guild } = await linked();
    const { deps, sent } = setup();
    const first = cmd(guild, "ligar");
    await handleInteraction(E, first, deps);
    expect(await text({ ...first }, deps)).toContain("espere");
    expect(sent).toHaveLength(1);
  });

  it("cada motivo de recusa do host vira uma explicação, só para quem pediu", async () => {
    const { guild } = await linked();
    const { deps, state } = setup();
    const cases: [string, string][] = [
      ["agent_offline", "fechado"], ["no_device", "pareado"], ["already_running", "já está ligado"],
      ["other_running", "outro"], ["not_running", "desligado"], ["unknown_state", "estado"],
    ];
    for (const [reason, expected] of cases) {
      state.result = { ok: false, reason };
      const res: any = await handleInteraction(E, cmd(guild, "ligar"), deps);
      expect(res.data.content, reason).toContain(expected);
      expect(res.data.flags).toBe(64);
    }
  });

  it("whitelist valida o nome antes de enviar", async () => {
    const { server, guild } = await linked();
    const { deps, sent } = setup();
    expect(await text(cmd(guild, "whitelist", [{ name: "acao", type: 3, value: "add" }, { name: "jogador", type: 3, value: "Ana op" }]), deps)).toContain("não é válido");
    expect(await text(cmd(guild, "whitelist", [{ name: "acao", type: 3, value: "remove" }, { name: "jogador", type: 3, value: "Ana" }]), deps)).toContain("removeu");
    expect(sent).toEqual([{ sc: server, action: { kind: "whitelist", op: "remove", player: "Ana" }, by: "ana" }]);
  });

  it("console vem desligado, só funciona depois de liberado e tira a barra inicial", async () => {
    const { server, guild } = await linked();
    const { deps, sent } = setup();
    const opts = [{ name: "comando", type: 3, value: "/say oi" }];
    expect(await text(cmd(guild, "console", opts), deps)).toContain("desligado");
    await handleInteraction(E, cmd(guild, "operador", [{ name: "console", type: 5, value: true }]), deps);
    await handleInteraction(E, cmd(guild, "console", opts), deps);
    expect(sent).toEqual([{ sc: server, action: { kind: "console", command: "say oi" }, by: "ana" }]);
  });

  it("o nome de quem pediu não carrega formatação nem menção", async () => {
    const { guild } = await linked();
    const { deps, sent } = setup();
    const i: any = cmd(guild, "ligar");
    i.member.nick = "**@everyone** `x`";
    await handleInteraction(E, i, deps);
    expect(sent[0].by).toBe("everyone x");
  });

  it("deixa o registro no canal de avisos, com o comando do console sem crase", async () => {
    const { server, guild } = await linked();
    const { deps, messages, api } = setup();
    await setAlertsChannel(E, api, server, guild, "333333", "pt", view());
    await handleInteraction(E, cmd(guild, "operador", [{ name: "console", type: 5, value: true }]), deps);
    messages.length = 0;
    await handleInteraction(E, cmd(guild, "console", [{ name: "comando", type: 3, value: "say `oi`" }]), deps);
    const log = messages.find((m) => m.channelId === "333333");
    expect(log?.body.content).toContain("`/cubicase console say 'oi'`");
    expect(log?.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("operador mostra o estado, salva e o desativar remove o cargo", async () => {
    const { guild } = await linked();
    const { deps } = setup();
    expect(await text(cmd(guild, "operador"), deps)).toContain("ninguém");
    await handleInteraction(E, cmd(guild, "operador", [{ name: "cargo", type: 8, value: ROLE }]), deps);
    expect(await text(cmd(guild, "operador"), deps)).toContain(`<@&${ROLE}>`);
    await handleInteraction(E, cmd(guild, "desativar", [{ name: "tipo", type: 3, value: "operator" }]), deps);
    expect(await text(cmd(guild, "operador"), deps)).toContain("ninguém");
    expect(await text(cmd(guild, "operador", [{ name: "cargo", type: 8, value: "abc" }]), deps)).toContain("não é válido");
  });

  it("operador só pode ser definido por quem gerencia o Discord", async () => {
    const { guild } = await linked();
    const { deps } = setup();
    expect(await text(asMember(cmd(guild, "operador", [{ name: "cargo", type: 8, value: ROLE }]), { permissions: "0" }), deps)).toContain("Gerenciar Servidor");
  });
});

describe("canal do host (Durable Object)", () => {
  const ask = (device: string, body: unknown) =>
    env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(device)).fetch("https://host-channel.internal/discord-control", { method: "POST", body: JSON.stringify(body) });

  it("sem o app conectado, responde agent_offline", async () => {
    const res = await ask("dev-discord-offline", { action: { kind: "start" }, shortCode: "ABC123", by: "ana" });
    expect(await res.json()).toEqual({ ok: false, reason: "agent_offline" });
  });

  it("pedido malformado é recusado", async () => {
    expect(await (await ask("dev-discord-bad", "isto nao e json")).json()).toEqual({ ok: false, reason: "invalid" });
    expect(await (await ask("dev-discord-bad2", { shortCode: "ABC123" })).json()).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("diagnóstico", () => {
  it("só para quem gerencia o Discord", async () => {
    const { deps } = setup();
    expect(await text(asMember(cmd(guildId(), "diagnostico"), { permissions: "0" }), deps)).toContain("Gerenciar Servidor");
  });

  it("tudo certo: token, servidor e canal", async () => {
    const { deps } = setup();
    const out = await text(cmd(guildId(), "diagnostico"), deps);
    expect(out).toContain("Token do bot");
    expect(out).toContain("O bot está neste servidor");
    expect(out).toContain("enxerga este canal");
    expect(out).not.toContain("❌");
  });

  it("aponta token de outro aplicativo (o caso de 'sem acesso' em qualquer canal)", async () => {
    const { deps, api } = setup();
    deps.api = { ...api, me: async () => ({ ok: true, data: { id: "999999999999999999", username: "Outro" } }) };
    const out = await text(cmd(guildId(), "diagnostico"), deps);
    expect(out).toContain("bots diferentes");
  });

  it("aponta bot fora do servidor e canal invisível, com o código do Discord", async () => {
    const { deps, api } = setup();
    const denied = { ok: false as const, status: 403, code: 50001, gone: true, messageGone: false };
    deps.api = { ...api, guild: async () => denied, channel: async () => denied };
    const out = await text(cmd(guildId(), "diagnostico"), deps);
    expect(out).toContain("não está neste servidor (erro 403/50001)");
    expect(out).toContain("não enxerga");
  });

  it("token recusado", async () => {
    const { deps, api } = setup();
    deps.api = { ...api, me: async () => ({ ok: false, status: 401, gone: false, messageGone: false }) };
    expect(await text(cmd(guildId(), "diagnostico"), deps)).toContain("não aceitou o token");
  });
});

describe("troca de conta do dono", () => {
  it("o Plus é conferido na conta dona; ao trocar de conta, as ligações passam para ela sem perder a configuração", async () => {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, "conta-sem-plus")).code, guild);
    const { deps, sent } = setup();
    const checked: string[] = [];
    deps.isPlus = async (userId) => { checked.push(userId); return userId === "conta-com-plus"; };

    await handleInteraction(E, cmd(guild, "operador", [{ name: "console", type: 5, value: true }]), deps);
    expect(await text(cmd(guild, "ligar"), deps)).toContain("Cubicase Plus");
    expect(checked).toEqual(["conta-sem-plus"]);
    expect(sent).toHaveLength(0);

    await adoptServerOwner(E, server, "conta-com-plus");
    expect((await listServerGuilds(E, server)).map((g) => g.guildId)).toEqual([guild]); // ligação mantida
    await handleInteraction(E, cmd(guild, "ligar"), deps); // mesma pessoa pode, o cooldown vale por pessoa e o id muda a cada cmd()
    expect(checked[checked.length - 1]).toBe("conta-com-plus");
    expect(sent).toHaveLength(1);
    // a configuração (console liberado) continua lá
    await handleInteraction(E, cmd(guild, "console", [{ name: "comando", type: 3, value: "say oi" }]), deps);
    expect(sent).toHaveLength(2);
  });

  it("adotar com a mesma conta, ou um servidor sem ligações, não muda nada", async () => {
    const server = sc(), guild = guildId();
    await adoptServerOwner(E, server, "qualquer"); // sem ligações: nada acontece
    expect(await listServerGuilds(E, server)).toEqual([]);
    await redeemLinkCode(E, (await createLinkCode(E, server, "dono")).code, guild);
    await adoptServerOwner(E, server, "dono");
    expect((await listServerGuilds(E, server)).length).toBe(1);
  });

  it("não toma um Discord que pertence a outra conta", async () => {
    const s1 = sc(), s2 = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, s1, "contaA")).code, guild);
    // servidor s2 do mesmo Discord ainda não existe como ligação; adotar s1 por outra conta só mexe no que era da contaA
    await adoptServerOwner(E, s1, "contaB");
    expect(await redeemLinkCode(E, (await createLinkCode(E, s2, "contaC")).code, guild)).toMatchObject({ ok: false, reason: "guild_other_account" });
  });
});

describe("backup pelo Discord", () => {
  it("é um comando de controle: mesma permissão, Plus e registro", async () => {
    const { server, guild } = await linked();
    const { deps, sent, state } = setup();
    expect(await text(asMember(cmd(guild, "backup"), { permissions: "0", roles: [] }), deps)).toContain("Operador");
    expect(await text(cmd(guild, "backup"), deps)).toContain("pediu um backup");
    expect(sent).toEqual([{ sc: server, action: { kind: "backup" }, by: "ana" }]);
    state.plus = false;
    expect(await text(cmd(guild, "backup"), deps)).toContain("Cubicase Plus");
  });
});

describe("backup: resposta editada no fim", () => {
  it("o pedido leva o necessário para o Worker editar a resposta; outros comandos não levam", async () => {
    const { guild } = await linked();
    const { deps, notified } = setup();
    const backup: any = cmd(guild, "backup");
    backup.token = "t".repeat(40);
    await handleInteraction(E, backup, deps);
    expect(notified[0]).toEqual({ appId: "123456789012345678", token: "t".repeat(40), lang: "pt", user: "ana" });
    const start: any = cmd(guild, "ligar");
    start.token = "t".repeat(40);
    await handleInteraction(E, start, deps);
    expect(notified[1]).toBeUndefined();
  });
});
