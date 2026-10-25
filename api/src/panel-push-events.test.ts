// ============================================================
// Eventos do agent -> notificações push, dentro do Durable Object (host-channel.ts)
// ============================================================
// O agent real exige validar o device_token no Supabase (rede), então aqui o DO é exercitado por dentro
// (runInDurableObject), com inscrições reais (chaves de navegador geradas) e o serviço de push simulado.
// ============================================================

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { b64urlEncode } from "./webpush";

function stub(deviceId: string) {
  return env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
}

async function realSubscription(n: number) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { endpoint: `https://fcm.googleapis.com/fcm/send/real-${n}`, p256dh: b64urlEncode(pub), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

const VIEWER = { viewConsole: true, start: false, stop: false, restart: false, commands: { mode: "none", allowlist: [] } };
const BLIND = { ...VIEWER, viewConsole: false };

let pushes: { url: string; headers: Record<string, string> }[] = [];
let pushStatus = 201;

beforeEach(() => {
  pushes = [];
  pushStatus = 201;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://fcm.googleapis.com/")) {
      pushes.push({ url, headers: { ...(init?.headers ?? {}) } });
      return new Response(null, { status: pushStatus });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

async function withChannel(deviceId: string, run: (ch: any, st: DurableObjectState) => Promise<void>) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const vapidPub = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const vapidPriv = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!;
  await runInDurableObject(stub(deviceId), async (instance: any, state: DurableObjectState) => {
    instance.env = { ...instance.env, VAPID_PUBLIC_KEY: vapidPub, VAPID_PRIVATE_KEY: vapidPriv, VAPID_SUBJECT: "mailto:t@cubicase.net" };
    await state.storage.put("device_id", deviceId);
    await run(instance, state);
  });
}

async function seedSub(state: DurableObjectState, userId: string, n: number, o: { isOwner?: boolean; prefs?: object; perms?: object } = {}) {
  const s = await realSubscription(n);
  await state.storage.put(`push:${userId}:${n}`, {
    userId, isOwner: o.isOwner ?? true, ...s, prefs: { players: true, server: true, offline: true, ...(o.prefs ?? {}) }, lang: "pt-BR", createdAt: Date.now(),
  });
  if (o.perms) await state.storage.put(`perms:${userId}`, o.perms);
}

const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/real-${n}`;
const status = (running: boolean, serverName?: string) => ({ type: "status", serverRunning: running, serverName });
const raw = (o: object) => JSON.stringify(o);

describe("HostChannel: eventos viram push", () => {
  it("servidor ligou: avisa quem quer; sem retrato anterior ou sem mudança, não avisa", async () => {
    await withChannel("ev-1", async (ch, st) => {
      await seedSub(st, "owner", 1);
      await seedSub(st, "off", 2, { prefs: { server: false } });
      await ch.derivePushEvents(status(true, "S"), raw(status(false)));
      expect(pushes.map((p) => p.url)).toEqual([endpoint(1)]);
      expect(pushes[0].headers["Content-Encoding"]).toBe("aes128gcm");
      expect(pushes[0].headers.Authorization).toMatch(/^vapid t=/);
      expect(pushes[0].headers.Topic).toBe("server");
      pushes.length = 0;
      await ch.derivePushEvents(status(true), raw(status(true)));
      expect(pushes).toHaveLength(0);
    });
  });

  it("quem pediu a parada não é avisado; os outros sim; o marcador é consumido", async () => {
    await withChannel("ev-2", async (ch, st) => {
      await seedSub(st, "actor", 1);
      await seedSub(st, "other", 2);
      await ch.expectChange({ kind: "stop", userId: "actor", by: "Ana" }, 60_000);
      await ch.derivePushEvents(status(false, "S"), raw(status(true)));
      expect(pushes.map((p) => p.url)).toEqual([endpoint(2)]);
      expect(await st.storage.get("expected_change")).toBeUndefined();
    });
  });

  it("marcador vencido é ignorado (ninguém fica sem aviso por causa de um pedido antigo)", async () => {
    await withChannel("ev-2b", async (ch, st) => {
      await seedSub(st, "actor", 1);
      await st.storage.put("expected_change", { kind: "stop", userId: "actor", by: "Ana", expiresAt: Date.now() - 1 });
      await ch.derivePushEvents(status(false, "S"), raw(status(true)));
      expect(pushes.map((p) => p.url)).toEqual([endpoint(1)]);
    });
  });

  it("reinício: o desligamento do meio é silencioso e só o 'ligado' é avisado", async () => {
    await withChannel("ev-3", async (ch, st) => {
      await seedSub(st, "actor", 1);
      await seedSub(st, "other", 2);
      await ch.expectChange({ kind: "restart", userId: "actor", by: "Ana" }, 60_000);
      await ch.derivePushEvents(status(false), raw(status(true)));
      expect(pushes).toHaveLength(0);
      await ch.derivePushEvents(status(true, "S"), raw(status(false)));
      expect(pushes.map((p) => p.url)).toEqual([endpoint(2)]);
    });
  });

  it("jogadores: junta o lote, respeita a permissão de ver o console e ignora servidor parado", async () => {
    await withChannel("ev-4", async (ch, st) => {
      await seedSub(st, "owner", 1);
      await seedSub(st, "viewer", 2, { isOwner: false, perms: VIEWER });
      await seedSub(st, "blind", 3, { isOwner: false, perms: BLIND });
      await seedSub(st, "nolist", 4, { prefs: { players: false } });

      await st.storage.put("last:status", raw(status(false)));
      await ch.derivePushEvents({ type: "players", players: ["Steve"] }, raw({ type: "players", players: [] }));
      expect(ch.pendingPlayers).toEqual({ joined: [], left: [] });

      await st.storage.put("last:status", raw(status(true)));
      await ch.derivePushEvents({ type: "players", players: ["Steve", "Alex"] }, raw({ type: "players", players: [] }));
      await ch.derivePushEvents({ type: "players", players: ["Steve", "Alex", "Notch"] }, raw({ type: "players", players: ["Steve", "Alex"] }));
      expect(ch.pendingPlayers.joined).toEqual(["Steve", "Alex", "Notch"]);
      await ch.flushPlayersPush();
      expect(pushes.map((p) => p.url).sort()).toEqual([endpoint(1), endpoint(2)]);
      expect(pushes[0].headers.Topic).toBe("players");
    });
  });

  it("entrou e saiu no mesmo lote não gera aviso", async () => {
    await withChannel("ev-5", async (ch, st) => {
      await seedSub(st, "owner", 1);
      ch.queuePlayers(["Steve"], []);
      ch.queuePlayers([], ["steve"]);
      expect(ch.pendingPlayers).toEqual({ joined: [], left: [] });
      ch.dropPendingPlayers();
      await ch.flushPlayersPush();
      expect(pushes).toHaveLength(0);
    });
  });

  it("inscrição que o navegador cancelou (410) é apagada", async () => {
    await withChannel("ev-6", async (ch, st) => {
      await seedSub(st, "owner", 1);
      pushStatus = 410;
      await ch.notifyPush({ kind: "agent_offline" }, "ev-6");
      expect(pushes).toHaveLength(1);
      expect((await st.storage.list({ prefix: "push:" })).size).toBe(0);
    });
  });

  it("falha temporária (503) mantém a inscrição", async () => {
    await withChannel("ev-7", async (ch, st) => {
      await seedSub(st, "owner", 1);
      pushStatus = 503;
      await ch.notifyPush({ kind: "agent_offline" }, "ev-7");
      expect((await st.storage.list({ prefix: "push:" })).size).toBe(1);
    });
  });

  it("computador offline: o alarm avisa só depois da carência, uma vez, e só se o agent não voltou", async () => {
    await withChannel("ev-8", async (ch, st) => {
      await seedSub(st, "owner", 1);
      await ch.alarm(); // nada agendado
      expect(pushes).toHaveLength(0);

      await ch.scheduleOfflineNotice();
      await ch.alarm(); // ainda dentro da carência
      expect(pushes).toHaveLength(0);

      await st.storage.put("offline_due", Date.now() - 1);
      await ch.alarm();
      expect(pushes).toHaveLength(1);
      expect(await st.storage.get("offline_due")).toBeUndefined();
      await ch.alarm(); // não repete
      expect(pushes).toHaveLength(1);
    });
  });

  it("sem chaves VAPID configuradas, nada é enviado", async () => {
    await runInDurableObject(stub("ev-9"), async (ch: any, st: DurableObjectState) => {
      await seedSub(st, "owner", 1);
      await ch.notifyPush({ kind: "agent_offline" }, "ev-9");
      expect(pushes).toHaveLength(0);
    });
  });
});
