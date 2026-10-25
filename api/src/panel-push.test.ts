// ============================================================
// Testes das notificações push do painel: regras puras (panel-push.ts) e inscrições no Durable Object
// ============================================================

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  buildMessage, detectStatusChange, diffPlayers, normalizeLang, normalizePrefs, parseBrowserSubscription, toPayload, wantsEvent,
  type PushEvent,
} from "./panel-push";

const P256DH = "B" + "A".repeat(86); // 87 caracteres base64url
const AUTH = "A".repeat(22);
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: P256DH, auth: AUTH } });

describe("diffPlayers", () => {
  it("separa quem entrou e quem saiu, sem diferenciar maiúsculas", () => {
    expect(diffPlayers(["Steve", "Alex"], ["alex", "Notch"])).toEqual({ joined: ["Notch"], left: ["Steve"] });
    expect(diffPlayers([], ["A"])).toEqual({ joined: ["A"], left: [] });
    expect(diffPlayers(["A"], ["A"])).toEqual({ joined: [], left: [] });
  });
});

describe("detectStatusChange", () => {
  it("só há mudança entre dois estados conhecidos e diferentes", () => {
    expect(detectStatusChange({ serverRunning: false }, { serverRunning: true })).toBe("started");
    expect(detectStatusChange({ serverRunning: true }, { serverRunning: false })).toBe("stopped");
    expect(detectStatusChange({ serverRunning: true }, { serverRunning: true })).toBeNull();
    expect(detectStatusChange(null, { serverRunning: true })).toBeNull(); // linha de base
    expect(detectStatusChange({}, { serverRunning: true })).toBeNull();
    expect(detectStatusChange({ serverRunning: "sim" }, { serverRunning: false })).toBeNull();
  });
});

describe("wantsEvent", () => {
  const all = { players: true, server: true, offline: true };
  const players: PushEvent = { kind: "players", joined: ["A"], left: [] };
  it("nomes de jogadores só para quem pode ver o console", () => {
    expect(wantsEvent(players, all, { viewConsole: true })).toBe(true);
    expect(wantsEvent(players, all, { viewConsole: false })).toBe(false);
  });
  it("respeita as preferências de cada tipo", () => {
    const off = { players: false, server: false, offline: false };
    const perms = { viewConsole: true };
    expect(wantsEvent(players, off, perms)).toBe(false);
    expect(wantsEvent({ kind: "server_stopped", serverName: null, by: null }, off, perms)).toBe(false);
    expect(wantsEvent({ kind: "server_started", serverName: null, by: null }, all, perms)).toBe(true);
    expect(wantsEvent({ kind: "agent_offline" }, { ...all, offline: false }, perms)).toBe(false);
    expect(wantsEvent({ kind: "agent_offline" }, all, { viewConsole: false })).toBe(true);
  });
});

describe("buildMessage", () => {
  it("jogadores: um nome, vários nomes e entrada + saída juntas", () => {
    expect(buildMessage({ kind: "players", joined: ["Steve"], left: [] }, "pt-BR", "d", false)).toMatchObject({ title: "Jogador online", body: "Steve entrou", tag: "players" });
    expect(buildMessage({ kind: "players", joined: ["A", "B"], left: [] }, "pt-BR", "d", false).body).toBe("A e B entraram");
    expect(buildMessage({ kind: "players", joined: ["A", "B", "C", "D", "E"], left: [] }, "pt-BR", "d", false).body).toBe("A, B, C e mais 2 entraram");
    expect(buildMessage({ kind: "players", joined: ["A"], left: ["B"] }, "en", "d", false).body).toBe("A joined; B left");
  });

  it("servidor parou: botão de iniciar só para quem pode iniciar; quem parou aparece", () => {
    const e: PushEvent = { kind: "server_stopped", serverName: "Survival", by: null };
    expect(buildMessage(e, "pt-BR", "d", true)).toMatchObject({ title: "Servidor parou", body: "Survival não está mais rodando.", action: "start", serverName: "Survival" });
    expect(buildMessage(e, "pt-BR", "d", false).action).toBeUndefined();
    expect(buildMessage({ ...e, by: "Ana" } as PushEvent, "pt-BR", "d", true).body).toBe("Ana desligou Survival.");
    expect(buildMessage({ kind: "server_started", serverName: "Survival", by: "Ana" }, "en", "d", false).body).toBe("Ana started Survival.");
  });

  it("limpa nomes vindos de fora (quebras de linha, tamanho)", () => {
    const m = buildMessage({ kind: "players", joined: ["Ev\nil\u0000" + "x".repeat(60)], left: [] }, "pt-BR", "d", false);
    expect(m.body).not.toMatch(/[\n\u0000]/);
    expect(m.body.length).toBeLessThan(40);
  });

  it("a carga do push é pequena e só leva o que o service worker usa", () => {
    const p = toPayload(buildMessage({ kind: "server_stopped", serverName: "S", by: null }, "en", "dev-1", true), "en");
    expect(Object.keys(p).sort()).toEqual(["action", "body", "deviceId", "lang", "serverName", "tag", "title"]);
    expect(JSON.stringify(p).length).toBeLessThan(400);
  });
});

describe("normalizações", () => {
  it("preferências: padrão ligado e só aceita booleanos", () => {
    expect(normalizePrefs(undefined)).toEqual({ players: true, server: true, offline: true });
    expect(normalizePrefs({ players: false, server: "não", offline: 0 })).toEqual({ players: false, server: true, offline: true });
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("pt-BR")).toBe("pt-BR");
    expect(normalizeLang(undefined)).toBe("pt-BR");
  });

  it("inscrição do navegador: endpoint de serviço conhecido e chaves no tamanho certo", () => {
    expect(parseBrowserSubscription(sub(1))).toEqual({ endpoint: sub(1).endpoint, p256dh: P256DH, auth: AUTH });
    expect(parseBrowserSubscription({ ...sub(1), endpoint: "https://evil.example.com/x" })).toBeNull();
    expect(parseBrowserSubscription({ endpoint: sub(1).endpoint, keys: { p256dh: "curta", auth: AUTH } })).toBeNull();
    expect(parseBrowserSubscription({ endpoint: sub(1).endpoint, keys: { p256dh: P256DH, auth: "a b" + "A".repeat(19) } })).toBeNull();
    expect(parseBrowserSubscription(null)).toBeNull();
  });
});

// ---- Inscrições dentro do Durable Object ----

function stub(deviceId: string) {
  return env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
}
async function post(deviceId: string, path: string, body: object) {
  return stub(deviceId).fetch(`https://host-channel.internal${path}`, { method: "POST", body: JSON.stringify(body) });
}
const subscribe = (deviceId: string, userId: string, n: number, extra: object = {}) =>
  post(deviceId, "/push-subscribe", { userId, isOwner: true, sub: parseBrowserSubscription(sub(n)), prefs: { players: false }, lang: "en", maxPerUser: 5, ...extra });
const check = async (deviceId: string, userId: string, n: number) =>
  (await (await post(deviceId, "/push-check", { userId, endpoint: sub(n).endpoint })).json()) as { subscribed: boolean; prefs?: object };

describe("inscrições no HostChannel", () => {
  it("inscreve, consulta, atualiza as preferências e cancela", async () => {
    const dev = "push-dev-1";
    expect(await check(dev, "u1", 1)).toEqual({ subscribed: false });
    expect((await subscribe(dev, "u1", 1)).status).toBe(200);
    expect(await check(dev, "u1", 1)).toEqual({ subscribed: true, prefs: { players: false, server: true, offline: true } });
    await subscribe(dev, "u1", 1, { prefs: { players: true, server: false } });
    expect((await check(dev, "u1", 1)).prefs).toEqual({ players: true, server: false, offline: true });
    expect((await post(dev, "/push-unsubscribe", { userId: "u1", endpoint: sub(1).endpoint })).status).toBe(204);
    expect((await check(dev, "u1", 1)).subscribed).toBe(false);
  });

  it("a inscrição é de quem a fez: outro usuário não vê nem cancela", async () => {
    const dev = "push-dev-2";
    await subscribe(dev, "u1", 1);
    expect((await check(dev, "u2", 1)).subscribed).toBe(false);
    await post(dev, "/push-unsubscribe", { userId: "u2", endpoint: sub(1).endpoint });
    expect((await check(dev, "u1", 1)).subscribed).toBe(true);
  });

  it("limite por pessoa: a inscrição mais antiga sai quando passa de 5 aparelhos", async () => {
    const dev = "push-dev-3";
    for (let i = 1; i <= 6; i++) {
      await subscribe(dev, "u1", i);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect((await check(dev, "u1", 1)).subscribed).toBe(false);
    for (let i = 2; i <= 6; i++) expect((await check(dev, "u1", i)).subscribed).toBe(true);
  });

  it("membro precisa de permissões válidas; remover o membro apaga as inscrições dele", async () => {
    const dev = "push-dev-4";
    expect((await subscribe(dev, "m1", 1, { isOwner: false })).status).toBe(400);
    const perms = { viewConsole: true, start: false, stop: false, restart: false, commands: { mode: "none", allowlist: [] } };
    expect((await subscribe(dev, "m1", 1, { isOwner: false, permissions: perms })).status).toBe(200);
    await subscribe(dev, "owner", 2);
    await post(dev, "/kick", { userId: "m1", removed: true });
    expect((await check(dev, "m1", 1)).subscribed).toBe(false);
    expect((await check(dev, "owner", 2)).subscribed).toBe(true);
  });

  it("recusa dados incompletos", async () => {
    expect((await post("push-dev-5", "/push-subscribe", { userId: "", sub: {} })).status).toBe(400);
    expect((await post("push-dev-5", "/push-check", { userId: "u" })).status).toBe(400);
  });
});
