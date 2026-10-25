// ============================================================
// Bot do Discord: assinatura, vinculação por código (uso único, limites do plano grátis) e comandos
// ============================================================

import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  createLinkCode, redeemLinkCode, normalizeLinkCode, listServerGuilds, listGuildServers, unlinkGuild, unlinkAllGuilds,
  handleInteraction, INSTALL_PERMISSIONS, type DiscordEnv, type InteractionDeps,
} from "./discord";

const BASE = "https://example.com";
// Chave privada do par cuja pública está em vitest.config.mts (só para testes).
const PRIVATE_PKCS8 = "302e020100300506032b65700422042005ca418fb4cc31cdd133da78b59807d5a957b1ac5dfec1b7544c624d31123ca3";
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function sign(body: string, timestamp = "1700000000") {
  const key = await crypto.subtle.importKey("pkcs8", fromHex(PRIVATE_PKCS8), { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(timestamp + body));
  return { "X-Signature-Ed25519": hex(sig), "X-Signature-Timestamp": timestamp };
}
const post = async (payload: unknown, headers?: Record<string, string>) => {
  const body = JSON.stringify(payload);
  return SELF.fetch(`${BASE}/api/v1/discord/interactions`, { method: "POST", headers: headers ?? (await sign(body)), body });
};

let n = 0;
const uid = () => `user-${Date.now()}-${n++}`;
const sc = () => `T${String(Date.now()).slice(-5)}${n++}`.slice(0, 8).toUpperCase();
const guildId = () => String(900000000000000000n + BigInt(n++ * 7919 + Math.floor(Math.random() * 1000)));

const E = env as unknown as DiscordEnv;
const MANAGE = String(1 << 5);
const deps: InteractionDeps = {
  getStatus: async (code) => ({ name: `Servidor ${code}`, version: "1.20.1", slug: null, minecraftStatus: "online", currentPlayers: 3, maxPlayers: 20 }),
  api: null,
};
const command = (guild: string, sub: string, options: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: 2, guild_id: guild, locale: "pt-BR", member: { permissions: "0" }, data: { name: "cubicase", options: [{ type: 1, name: sub, options }] }, ...extra,
});

describe("assinatura do Discord", () => {
  it("PING assinado é respondido com PONG", async () => {
    const res = await post({ type: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("sem assinatura, com assinatura errada ou corpo adulterado: 401", async () => {
    expect((await post({ type: 1 }, {})).status).toBe(401);
    const good = await sign(JSON.stringify({ type: 1 }));
    expect((await post({ type: 1 }, { ...good, "X-Signature-Ed25519": "00".repeat(64) })).status).toBe(401);
    expect((await post({ type: 2 }, good)).status).toBe(401); // assinatura é de outro corpo
    expect((await post({ type: 1 }, { ...good, "X-Signature-Timestamp": "1" })).status).toBe(401);
  });
});

describe("link de instalação", () => {
  it("expõe o link do bot com as permissões mínimas", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/discord/install-url`);
    const url = ((await res.json()) as any).data.url as string;
    expect(url).toContain("client_id=123456789012345678");
    expect(url).toContain(`permissions=${INSTALL_PERMISSIONS}`);
    expect(BigInt(INSTALL_PERMISSIONS) & (1n << 3n)).toBe(0n); // nunca pede Administrador
  });
});

describe("vinculação por código", () => {
  it("o código vale uma vez só e liga nos dois sentidos", async () => {
    const server = sc(), guild = guildId(), user = uid();
    const { code } = await createLinkCode(E, server, user);
    expect(await redeemLinkCode(E, code, guild)).toEqual({ ok: true, shortCode: server });
    expect((await listServerGuilds(E, server)).map((g) => g.guildId)).toEqual([guild]);
    expect(await listGuildServers(E, guild)).toEqual([server]);
    expect(await redeemLinkCode(E, code, guildId())).toMatchObject({ ok: false, reason: "invalid_code" });
  });

  it("aceita o código com traço e em minúsculas; rejeita lixo", async () => {
    const server = sc(), guild = guildId();
    const { code } = await createLinkCode(E, server, uid());
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(normalizeLinkCode(typed)).toBe(code);
    expect(await redeemLinkCode(E, typed, guild)).toMatchObject({ ok: true });
    expect(await redeemLinkCode(E, "", guild)).toMatchObject({ ok: false, reason: "invalid_code" });
    expect(await redeemLinkCode(E, "ZZZZ-ZZZZ", guild)).toMatchObject({ ok: false, reason: "invalid_code" });
  });

  it("um código novo invalida o anterior do mesmo servidor", async () => {
    const server = sc();
    const first = await createLinkCode(E, server, uid());
    const second = await createLinkCode(E, server, uid());
    expect(await redeemLinkCode(E, first.code, guildId())).toMatchObject({ ok: false, reason: "invalid_code" });
    expect(await redeemLinkCode(E, second.code, guildId())).toMatchObject({ ok: true });
  });

  it("plano grátis: 1 Discord por servidor e 1 servidor por Discord", async () => {
    const user = uid(), s1 = sc(), s2 = sc(), g1 = guildId(), g2 = guildId();
    expect(await redeemLinkCode(E, (await createLinkCode(E, s1, user)).code, g1)).toMatchObject({ ok: true });
    expect(await redeemLinkCode(E, (await createLinkCode(E, s1, user)).code, g2)).toMatchObject({ ok: false, reason: "free_limit_server" });
    expect(await redeemLinkCode(E, (await createLinkCode(E, s2, user)).code, g1)).toMatchObject({ ok: false, reason: "free_limit_guild" });
    expect(await redeemLinkCode(E, (await createLinkCode(E, s1, user)).code, g1)).toMatchObject({ ok: false, reason: "already_linked" });
  });

  it("um Discord ligado a uma conta não aceita outra conta", async () => {
    const s1 = sc(), s2 = sc(), g = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, s1, uid())).code, g);
    expect(await redeemLinkCode(E, (await createLinkCode(E, s2, uid())).code, g)).toMatchObject({ ok: false, reason: "guild_other_account" });
  });

  it("servidor que passou para outra conta perde as ligações da anterior", async () => {
    const server = sc(), oldGuild = guildId(), newGuild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, oldGuild);
    expect(await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, newGuild)).toMatchObject({ ok: true });
    expect((await listServerGuilds(E, server)).map((g) => g.guildId)).toEqual([newGuild]);
    expect(await listGuildServers(E, oldGuild)).toEqual([]);
  });

  it("desvincular libera os dois lados; unlinkAll limpa tudo", async () => {
    const user = uid(), server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, user)).code, guild);
    expect(await unlinkGuild(E, server, guild)).toBe(true);
    expect(await unlinkGuild(E, server, guild)).toBe(false);
    expect(await listGuildServers(E, guild)).toEqual([]);
    await redeemLinkCode(E, (await createLinkCode(E, server, user)).code, guild);
    await unlinkAllGuilds(E, server);
    expect(await listServerGuilds(E, server)).toEqual([]);
  });
});

describe("comandos", () => {
  it("ping responde antes de qualquer outra coisa", async () => {
    expect(await handleInteraction(E, { type: 1 }, deps)).toEqual({ type: 1 });
  });

  it("vincular exige Gerenciar Servidor e funciona para quem tem", async () => {
    const server = sc(), guild = guildId();
    const { code } = await createLinkCode(E, server, uid());
    const opts = [{ name: "codigo", type: 3, value: code }];
    const denied: any = await handleInteraction(E, command(guild, "vincular", opts), deps);
    expect(denied.data.content).toContain("Gerenciar Servidor");
    expect(await listGuildServers(E, guild)).toEqual([]); // o código não foi gasto por quem não podia
    const done: any = await handleInteraction(E, command(guild, "vincular", opts, { member: { permissions: MANAGE } }), deps);
    expect(done.data.content).toContain(`Servidor ${server}`);
    expect(await listGuildServers(E, guild)).toEqual([server]);
  });

  it("nomes em inglês também funcionam, e a resposta sai em inglês", async () => {
    const server = sc(), guild = guildId();
    const { code } = await createLinkCode(E, server, uid());
    const res: any = await handleInteraction(E, command(guild, "link", [{ name: "code", type: 3, value: code }], { locale: "en-US", member: { permissions: MANAGE } }), deps);
    expect(res.data.content).toContain("linked to");
    const status: any = await handleInteraction(E, command(guild, "status", [], { locale: "en-US" }), deps);
    expect(status.data.embeds[0].description).toBe("🟢 Online");
  });

  it("status mostra jogadores e como entrar; qualquer membro pode pedir", async () => {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, guild);
    const res: any = await handleInteraction(E, command(guild, "status"), deps);
    const embed = res.data.embeds[0];
    expect(embed.title).toBe(`Servidor ${server}`);
    expect(embed.fields.find((f: any) => f.name === "Jogadores").value).toBe("3/20");
    expect(embed.fields.find((f: any) => f.name === "Como entrar").value).toContain(`play.cubicase.net/${server.toLowerCase()}`);
    expect(res.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("status de servidor desligado não mostra jogadores", async () => {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, guild);
    const off: InteractionDeps = { getStatus: async () => ({ name: "X", version: "1.20.1", slug: "meu-mundo", minecraftStatus: null, currentPlayers: 5, maxPlayers: 20 }), api: null };
    const res: any = await handleInteraction(E, command(guild, "status"), off);
    expect(res.data.embeds[0].description).toBe("🔴 Desligado");
    expect(res.data.embeds[0].fields.map((f: any) => f.name)).not.toContain("Jogadores");
    expect(JSON.stringify(res.data.embeds[0].fields)).toContain("https://play.cubicase.net/meu-mundo");
  });

  it("sem servidor ligado, o status explica o que fazer", async () => {
    const res: any = await handleInteraction(E, command(guildId(), "status"), deps);
    expect(res.data.content).toContain("não está ligado");
  });

  it("status de servidor que não está neste Discord é recusado", async () => {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, guild);
    const res: any = await handleInteraction(E, command(guild, "status", [{ name: "servidor", type: 3, value: "OUTRO1" }]), deps);
    expect(res.data.content).toContain("não está ligado a este Discord");
  });

  it("desvincular exige permissão e remove a ligação", async () => {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, guild);
    const denied: any = await handleInteraction(E, command(guild, "desvincular"), deps);
    expect(denied.data.content).toContain("Gerenciar Servidor");
    expect(await listGuildServers(E, guild)).toEqual([server]);
    await handleInteraction(E, command(guild, "desvincular", [], { member: { permissions: MANAGE } }), deps);
    expect(await listGuildServers(E, guild)).toEqual([]);
  });

  it("fora de um servidor do Discord (DM) o comando é recusado", async () => {
    const res: any = await handleInteraction(E, command("", "status", [], { guild_id: undefined }), deps);
    expect(res.data.content).toContain("dentro de um servidor");
  });

  it("autocomplete lista só os servidores deste Discord, filtrando pelo que foi digitado", async () => {
    const server = sc(), guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, server, uid())).code, guild);
    const ask = (typed: string) => handleInteraction(E, { type: 4, guild_id: guild, data: { name: "cubicase", options: [{ type: 1, name: "status", options: [{ name: "servidor", type: 3, value: typed, focused: true }] }] } }, deps) as Promise<any>;
    expect((await ask("")).data.choices.map((c: any) => c.value)).toEqual([server]);
    expect((await ask("zzz")).data.choices).toEqual([]);
  });
});

describe("rotas do app", () => {
  it("gerar código exige conta logada", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ABC123/discord/link-code`, { method: "POST", headers: { "CF-Connecting-IP": "10.77.0.1" } });
    expect(res.status).toBe(401);
  });

  it("listar e desvincular exigem o segredo do dono", async () => {
    const created = await SELF.fetch(`${BASE}/api/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.77.0.2" },
      body: JSON.stringify({ name: "Dc", version: "1.20.1", serverType: "vanilla", description: "" }),
    });
    const { shortCode, ownerSecret } = ((await created.json()) as any).data;
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, shortCode, uid())).code, guild);

    expect((await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord`)).status).toBe(401);
    const list = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord`, { headers: { "X-Owner-Secret": ownerSecret } });
    expect(((await list.json()) as any).data.guilds.map((g: any) => g.guildId)).toEqual([guild]);

    expect((await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord/${guild}`, { method: "DELETE" })).status).toBe(401);
    expect(await listGuildServers(E, guild)).toEqual([shortCode]);
    const del = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/discord/${guild}`, { method: "DELETE", headers: { "X-Owner-Secret": ownerSecret } });
    expect(del.status).toBe(200);
    expect(await listGuildServers(E, guild)).toEqual([]);
  });

  it("excluir o servidor da central apaga as ligações com o Discord", async () => {
    const created = await SELF.fetch(`${BASE}/api/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.77.0.3" },
      body: JSON.stringify({ name: "Dc2", version: "1.20.1", serverType: "vanilla", description: "" }),
    });
    const { shortCode, ownerSecret } = ((await created.json()) as any).data;
    const guild = guildId();
    await redeemLinkCode(E, (await createLinkCode(E, shortCode, uid())).code, guild);
    await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`, { method: "DELETE", headers: { "X-Owner-Secret": ownerSecret } });
    expect(await listGuildServers(E, guild)).toEqual([]);
    expect(await listServerGuilds(E, shortCode)).toEqual([]);
  });
});
