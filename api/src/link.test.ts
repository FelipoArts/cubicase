// ============================================================
// Transporte P2P — tokens, credenciais e sala de sinalização (LinkRoom)
// ============================================================
// Roda o Worker e o Durable Object de verdade (Miniflare). Os segredos de teste vêm de
// vitest.config.mts (LINK_TOKEN_SECRET, LINK_MAX_GUESTS=3).
// ============================================================

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signLinkToken, verifyLinkToken, buildLinkCredentials, LINK_TOKEN_TTL_SECONDS } from "./link";

const BASE = "https://example.com";
const SECRET = "segredo-de-teste-do-link-0123456789";

// ---------------- tokens ----------------

describe("token de sinalização (JWT HS256)", () => {
  const e = { LINK_TOKEN_SECRET: SECRET };

  it("assina e verifica; carrega sala, papel e sessão", async () => {
    const t = await signLinkToken(e, { sc: "ABC123", role: "host", pid: "sess-1" });
    const c = await verifyLinkToken(e, t);
    expect(c).toMatchObject({ sc: "ABC123", role: "host", pid: "sess-1" });
    expect(c!.exp - c!.iat).toBe(LINK_TOKEN_TTL_SECONDS);
  });

  it("recusa assinatura adulterada, outro segredo, expirado e lixo", async () => {
    const t = await signLinkToken(e, { sc: "ABC123", role: "guest", pid: "p" });
    const [h, b, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sc: "OUTRA1", role: "host", pid: "p", iat: 1, exp: 9_999_999_999 })).toString("base64url");
    expect(await verifyLinkToken(e, `${h}.${forged}.${s}`)).toBeNull(); // payload trocado, assinatura antiga
    expect(await verifyLinkToken({ LINK_TOKEN_SECRET: "outro-segredo" }, t)).toBeNull();
    expect(await verifyLinkToken(e, t, Date.now() + (LINK_TOKEN_TTL_SECONDS + 5) * 1000)).toBeNull();
    for (const bad of ["", "a.b", "a.b.c.d", "x".repeat(5000), null, undefined]) {
      expect(await verifyLinkToken(e, bad as any), String(bad).slice(0, 20)).toBeNull();
    }
    expect(await verifyLinkToken({}, t)).toBeNull(); // sem segredo configurado nunca aceita nada
  });

  it("nunca aceita alg 'none'", async () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sc: "ABC123", role: "host", pid: "p", iat: 1, exp: 9_999_999_999 })).toString("base64url");
    expect(await verifyLinkToken(e, `${head}.${body}.`)).toBeNull();
    expect(await verifyLinkToken(e, `${head}.${body}.x`)).toBeNull();
  });
});

describe("credenciais de conexão (sem relay)", () => {
  it("só STUN; os campos antigos do relay ficam fixos para apps antigos", async () => {
    const c = await buildLinkCredentials({ LINK_TOKEN_SECRET: SECRET }, { origin: "https://api.exemplo.test", shortCode: "ABC123", role: "guest", peerId: "p" });
    expect(c.signalUrl).toBe("wss://api.exemplo.test/api/v1/link/ws/ABC123");
    expect(c.ice.stunUrls.length).toBeGreaterThan(0);
    expect((c.ice as any).turn).toBeUndefined();
    // Apps antigos ainda leem estes dois campos: nunca pedem relay nem mostram cota.
    expect(c.relayOnly).toBe(false);
    expect(c.relay).toBe("off");
  });
});

// ---------------- criação de sessão ----------------

async function createServer() {
  const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ name: "Teste", version: "1.20.1", serverType: "vanilla" }),
  });
  const body: any = await res.json();
  return { shortCode: body.data.shortCode as string, secret: body.data.ownerSecret as string };
}

// Os limites de taxa por IP (todos os testes saem do mesmo "IP") não fazem parte do que se testa aqui.
async function resetRateLimits() {
  for (const b of ["join", "link-ws"]) await env.CUBEFORGE_REGISTRY.delete(`ratelimit:${b}:unknown`);
}

async function createLinkSession(shortCode: string, mode: "host" | "guest", opts: { secret?: string; installationId?: string; relayOnly?: boolean } = {}) {
  await resetRateLimits();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.secret) headers["X-Owner-Secret"] = opts.secret;
  const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connection-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: crypto.randomUUID(), correlationId: "c", clientVersion: "t", mode, launcher: "link-v1",
      installationId: opts.installationId ?? `install-${mode}-0001`, ...(opts.relayOnly ? { relayOnly: true } : {}),
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("sessão link-v1 na API", () => {
  it("host (dono) e convidado recebem token da sala e credenciais ICE", async () => {
    const { shortCode, secret } = await createServer();
    const host = await createLinkSession(shortCode, "host", { secret });
    expect(host.status).toBe(201);
    const d = host.body.data;
    expect(d.launcher).toBe("link-v1");
    expect(d.credentials.signalUrl).toBe(`wss://example.com/api/v1/link/ws/${shortCode}`);
    expect(d.credentials.peerId).toBe(d.sessionId);
    expect(d.credentials.ice.stunUrls.length).toBeGreaterThan(0);
    expect(d.credentials.ice.turn).toBeUndefined(); // não há relay
    const claims = await verifyLinkToken({ LINK_TOKEN_SECRET: SECRET }, d.credentials.signalToken);
    expect(claims).toMatchObject({ sc: shortCode, role: "host", pid: d.sessionId });

    const guest = await createLinkSession(shortCode, "guest");
    expect(guest.status).toBe(201);
    expect(await verifyLinkToken({ LINK_TOKEN_SECRET: SECRET }, guest.body.data.credentials.signalToken)).toMatchObject({ role: "guest" });
  });

  it("host continua exigindo o segredo de dono", async () => {
    const { shortCode } = await createServer();
    expect((await createLinkSession(shortCode, "host")).status).toBe(401);
    expect((await createLinkSession(shortCode, "host", { secret: "x".repeat(32) })).status).toBe(403);
  });

  it("convidados de instalações diferentes coexistem; a mesma instalação substitui a sessão", async () => {
    const { shortCode } = await createServer();
    const a = await createLinkSession(shortCode, "guest", { installationId: "install-aaaaaaaa" });
    const b = await createLinkSession(shortCode, "guest", { installationId: "install-bbbbbbbb" });
    expect([a.status, b.status]).toEqual([201, 201]);
    const a2 = await createLinkSession(shortCode, "guest", { installationId: "install-aaaaaaaa" });
    expect(a2.status).toBe(201);
    expect(a2.body.data.sessionId).not.toBe(a.body.data.sessionId);
  });

  it("app antigo que pede o modo privado (relayOnly) recebe uma conexão normal, sem erro e sem relay", async () => {
    const { shortCode } = await createServer();
    const r = await createLinkSession(shortCode, "guest", { relayOnly: true });
    expect(r.status).toBe(201);
    expect(r.body.data.credentials.relayOnly).toBe(false);
    expect(r.body.data.credentials.relay).toBe("off");
    expect(r.body.data.credentials.ice.turn).toBeUndefined();
  });

  it("pedido sem o launcher link-v1 não vira Tailscale por engano: recebe 426", async () => {
    const { shortCode } = await createServer();
    const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connection-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), correlationId: "c", clientVersion: "t", mode: "guest", installationId: "install-legacy-1" }),
    });
    expect(res.status).toBe(426);
    expect(((await res.json()) as any).code).toBe("CLIENT_OUTDATED");
  });
});

// ---------------- sala de sinalização ----------------

interface Conn {
  ws: WebSocket;
  msgs: any[];
  closes: { code: number; reason: string }[];
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
}

async function connect(shortCode: string, token: string | null, path = `/api/v1/link/ws/${shortCode}`): Promise<Conn | { status: number }> {
  await resetRateLimits();
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await SELF.fetch(`${BASE}${path}`, { headers });
  if (resp.status !== 101) return { status: resp.status };
  const ws = resp.webSocket!;
  ws.accept();
  const msgs: any[] = [];
  const closes: { code: number; reason: string }[] = [];
  ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse(e.data as string)); } catch { /* "pong" */ } });
  ws.addEventListener("close", (e) => { closes.push({ code: e.code, reason: e.reason }); });
  const waitFor = async (pred: (m: any) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = msgs.find(pred);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`mensagem não chegou; recebidas: ${JSON.stringify(msgs)}`);
  };
  return { ws, msgs, closes, waitFor };
}

const asConn = (c: Conn | { status: number }) => c as Conn;

async function room() {
  const { shortCode, secret } = await createServer();
  const host = (await createLinkSession(shortCode, "host", { secret })).body.data;
  return { shortCode, secret, host };
}

async function guestToken(shortCode: string, installationId: string) {
  return (await createLinkSession(shortCode, "guest", { installationId })).body.data.credentials.signalToken as string;
}

describe("sala de sinalização: autenticação", () => {
  it("recusa sem token, token inválido e token de OUTRA sala", async () => {
    const { shortCode, host } = await room();
    expect(await connect(shortCode, null)).toEqual({ status: 401 });
    expect(await connect(shortCode, "lixo.lixo.lixo")).toEqual({ status: 401 });
    const other = await createServer();
    expect(await connect(other.shortCode, host.credentials.signalToken)).toEqual({ status: 401 });
  });
});

describe("sala de sinalização: encaminhamento", () => {
  it("convidado → host com from preenchido pela sala; host → convidado só por 'to' válido", async () => {
    const { shortCode, host } = await room();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));

    // o convidado é avisado de que o host está online, com a sessão do host
    const online = await g.waitFor((m) => m.t === "host_online");
    expect(online.peerId).toBe(host.sessionId);

    // oferta com um "from" FORJADO: a sala o substitui pelo id real do convidado
    g.ws.send(JSON.stringify({ t: "offer", sdp: "v=0 oferta", from: "host", to: "alguem", extra: "ignorado" }));
    const offer = await h.waitFor((m) => m.t === "offer");
    expect(offer.from).not.toBe("host");
    expect(offer.sdp).toBe("v=0 oferta");
    expect(offer.extra).toBeUndefined();

    // candidato ICE do convidado
    g.ws.send(JSON.stringify({ t: "ice", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host" } }));
    const ice = await h.waitFor((m) => m.t === "ice");
    expect(ice.from).toBe(offer.from);

    // resposta do host para o convidado certo
    h.ws.send(JSON.stringify({ t: "answer", to: offer.from, sdp: "v=0 resposta" }));
    expect((await g.waitFor((m) => m.t === "answer")).sdp).toBe("v=0 resposta");
  });

  it("convidado não consegue se passar pelo host nem falar com outro convidado", async () => {
    const { shortCode, host } = await room();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const g1 = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));
    const g2 = asConn(await connect(shortCode, await guestToken(shortCode, "install-bbbbbbbb")));
    await g1.waitFor((m) => m.t === "host_online");
    g2.ws.send(JSON.stringify({ t: "offer", sdp: "x" }));
    const o2 = await h.waitFor((m) => m.t === "offer");

    // g1 tenta mandar "answer" (só o host pode) e uma mensagem endereçada ao g2
    g1.ws.send(JSON.stringify({ t: "answer", to: o2.from, sdp: "forjada" }));
    g1.ws.send(JSON.stringify({ t: "ice", to: o2.from, candidate: { candidate: "x" } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(g2.msgs.find((m) => m.t === "answer")).toBeUndefined();
    expect(g2.msgs.find((m) => m.t === "ice")).toBeUndefined();
    // o ICE do g1 foi para o HOST (único destino possível), identificado como g1
    const icei = await h.waitFor((m) => m.t === "ice");
    expect(icei.from).not.toBe(o2.from);
  });

  it("host_left quando o host sai e host_online quando volta; peer_left quando o convidado sai", async () => {
    const { shortCode, secret, host } = await room();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));
    await g.waitFor((m) => m.t === "host_online");
    g.ws.send(JSON.stringify({ t: "offer", sdp: "x" }));
    const offer = await h.waitFor((m) => m.t === "offer");

    g.ws.close(1000, "tchau");
    expect((await h.waitFor((m) => m.t === "peer_left")).from).toBe(offer.from);

    const g2 = asConn(await connect(shortCode, await guestToken(shortCode, "install-bbbbbbbb")));
    await g2.waitFor((m) => m.t === "host_online");
    h.ws.close(1000, "saiu");
    await g2.waitFor((m) => m.t === "host_left");

    const host2 = (await createLinkSession(shortCode, "host", { secret })).body.data;
    asConn(await connect(shortCode, host2.credentials.signalToken));
    const back = await g2.waitFor((m) => m.t === "host_online" && m.peerId === host2.sessionId);
    expect(back.peerId).toBe(host2.sessionId);
  });

  it("host novo SUBSTITUI o antigo: a sessão velha é revogada e o convidado renegocia com o novo", async () => {
    const { shortCode, secret, host } = await room();
    const h1 = asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));
    await g.waitFor((m) => m.t === "host_online");
    const host2 = (await createLinkSession(shortCode, "host", { secret })).body.data;
    asConn(await connect(shortCode, host2.credentials.signalToken));
    await g.waitFor((m) => m.t === "host_online" && m.peerId === host2.sessionId);
    await new Promise((r) => setTimeout(r, 200));
    expect(h1.closes.some((c) => c.reason === "session-revoked")).toBe(true);
    // e o token antigo não entra mais na sala
    expect(await connect(shortCode, host.credentials.signalToken)).toMatchObject({ status: 401 });
  });
});

// ---------------- autenticação e revogação das sessões ----------------

describe("rotas /connection-sessions exigem o token da própria sessão", () => {
  const call = (method: string, sid: string, token?: string, path = "") =>
    SELF.fetch(`${BASE}/api/v1/connection-sessions/${sid}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === "DELETE" ? undefined : JSON.stringify({ status: "online" }),
    });

  it("sem token ou com o token de OUTRA sessão: 401 e nada muda", async () => {
    const { shortCode, secret } = await createServer();
    const host = (await createLinkSession(shortCode, "host", { secret })).body.data;
    const guest = (await createLinkSession(shortCode, "guest")).body.data;
    for (const method of ["PATCH", "DELETE"]) {
      expect((await call(method, host.sessionId)).status).toBe(401);
      // o convidado conhece o id do host (a sala o repassa), mas não tem o token dele
      expect((await call(method, host.sessionId, guest.credentials.signalToken)).status).toBe(401);
    }
    expect((await call("POST", host.sessionId, undefined, "/heartbeat")).status).toBe(401);
    expect(await env.CUBEFORGE_REGISTRY.get(`csession:${host.sessionId}`)).not.toBeNull();
  });

  it("com o token da própria sessão funciona, e o DELETE revoga o token na sala", async () => {
    const { shortCode, secret } = await createServer();
    const host = (await createLinkSession(shortCode, "host", { secret })).body.data;
    const tok = host.credentials.signalToken;
    expect((await call("PATCH", host.sessionId, tok)).status).toBe(200);
    const conn = asConn(await connect(shortCode, tok));
    expect((await call("DELETE", host.sessionId, tok)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.closes.some((c) => c.reason === "session-revoked")).toBe(true);
    expect(await connect(shortCode, tok)).toMatchObject({ status: 401 });
  });
});

describe("cadastro", () => {
  it("POST /servers tem limite por IP", async () => {
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" };
    await env.CUBEFORGE_REGISTRY.delete("ratelimit:create-server:198.51.100.77");
    const post = () => SELF.fetch(`${BASE}/api/v1/servers`, { method: "POST", headers, body: JSON.stringify({ name: "x", version: "1", serverType: "vanilla" }) });
    let last = 201;
    for (let i = 0; i < 25; i++) last = (await post()).status;
    expect(last).toBe(429);
  });
});

describe("sala de sinalização: limites", () => {
  it("sala cheia (LINK_MAX_GUESTS=3) recusa o convidado excedente com ROOM_FULL", async () => {
    const { shortCode } = await room();
    const keep: Conn[] = [];
    for (let i = 0; i < 3; i++) keep.push(asConn(await connect(shortCode, await guestToken(shortCode, `install-ok-000${i}`))));
    const extra = asConn(await connect(shortCode, await guestToken(shortCode, "install-extra-01")));
    const err = await extra.waitFor((m) => m.t === "error");
    expect(err.code).toBe("ROOM_FULL");
  });

  it("ignora mensagens enormes, JSON inválido e tipos desconhecidos (sem derrubar a sala)", async () => {
    const { shortCode, host } = await room();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));
    await g.waitFor((m) => m.t === "host_online");
    g.ws.send("{nao é json");
    g.ws.send(JSON.stringify({ t: "comando-estranho" }));
    g.ws.send(JSON.stringify({ t: "offer", sdp: "x".repeat(70_000) }));
    g.ws.send(JSON.stringify({ t: "offer", sdp: "ok" }));
    const offer = await h.waitFor((m) => m.t === "offer");
    expect(offer.sdp).toBe("ok");
    expect(h.msgs.filter((m) => m.t === "offer")).toHaveLength(1);
  });

  it("limite de taxa por conexão: rajada acima do teto recebe RATE_LIMITED", async () => {
    const { shortCode, host } = await room();
    asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));
    await g.waitFor((m) => m.t === "host_online");
    for (let i = 0; i < 200; i++) g.ws.send(JSON.stringify({ t: "ice", candidate: { candidate: `c${i}` } }));
    expect((await g.waitFor((m) => m.t === "error" && m.code === "RATE_LIMITED", 4000)).code).toBe("RATE_LIMITED");
  });

  it("o host, que fala por todos os convidados, aguenta a rajada de uma negociação em massa (o convidado continua limitado)", async () => {
    const { shortCode, host } = await room();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-bbbbbbbb")));
    await g.waitFor((m) => m.t === "host_online");
    // O convidado se apresenta ao host (oferta) e o host descobre o id que a sala deu a ele.
    g.ws.send(JSON.stringify({ t: "offer", sdp: "x" }));
    const offer = await h.waitFor((m) => m.t === "offer");
    // ~8 convidados negociando juntos = resposta + ~16 candidatos cada, tudo em segundos: 8 x 17 > 120.
    for (let i = 0; i < 400; i++) h.ws.send(JSON.stringify({ t: "ice", to: offer.from, candidate: { candidate: `c${i}` } }));
    h.ws.send(JSON.stringify({ t: "answer", to: offer.from, sdp: "resposta" }));
    expect((await g.waitFor((m) => m.t === "answer", 4000)).sdp).toBe("resposta"); // a última mensagem da rajada chegou
    expect(h.msgs.some((m) => m.t === "error" && m.code === "RATE_LIMITED")).toBe(false);
  });
});

describe("sala de sinalização: presença e ciclo de vida", () => {
  it("publica 'online' na sessão do host ao conectar e 'stopped' ao sair (descoberta lê isso)", async () => {
    const { shortCode, host } = await room();
    const status = async () => {
      const d: any = await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`)).json();
      return d.data.session.networkStatus as string | null;
    };
    expect(await status()).toBe("creating");
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    for (let i = 0; i < 100 && (await status()) !== "online"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await status()).toBe("online");
    h.ws.close(1000, "fim");
    for (let i = 0; i < 100 && (await status()) !== "stopped"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await status()).toBe("stopped");
  });

  it("apagar o servidor derruba a sala inteira", async () => {
    const { shortCode, secret, host } = await room();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const g = asConn(await connect(shortCode, await guestToken(shortCode, "install-aaaaaaaa")));
    await g.waitFor((m) => m.t === "host_online");
    const del = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`, { method: "DELETE", headers: { "X-Owner-Secret": secret } });
    expect(del.status).toBe(200);
    for (let i = 0; i < 100 && (h.closes.length === 0 || g.closes.length === 0); i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.closes[0]?.reason).toBe("room-closed");
    expect(g.closes[0]?.reason).toBe("room-closed");
  });
});


describe("descoberta lê a presença direto da sala (sem esperar o KV)", () => {
  it("host conectado aparece online com provider link-v1 NA HORA; ao sair deixa de aparecer", async () => {
    const { shortCode, host } = await room();
    // Apaga o que o KV teria publicado: a descoberta precisa depender só da sala.
    await env.CUBEFORGE_REGISTRY.delete(`csession-by-shortcode:${shortCode}:host`);
    const discover = async () => ((await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`)).json()) as any).data.session;

    expect((await discover()).networkStatus).toBeNull();
    const h = asConn(await connect(shortCode, host.credentials.signalToken));
    const d1 = await discover(); // sem espera: a sala é consistente
    expect(d1).toMatchObject({ networkStatus: "online", provider: "link-v1", hostIp: "" });

    h.ws.close(1000, "fim");
    for (let i = 0; i < 100 && (await discover()).networkStatus === "online"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await discover()).networkStatus).not.toBe("online");
  });
});

// ---------------- conta no token de link ----------------

describe("conta no token de link (uid)", () => {
  const e = { LINK_TOKEN_SECRET: SECRET };
  const UID = "123e4567-e89b-42d3-a456-426614174000";

  it("o uid viaja assinado no token e some sem conta", async () => {
    const withUid = await signLinkToken(e, { sc: "ABC123", role: "guest", pid: "p", uid: UID });
    expect(await verifyLinkToken(e, withUid)).toMatchObject({ uid: UID });
    const without = await signLinkToken(e, { sc: "ABC123", role: "guest", pid: "p" });
    expect((await verifyLinkToken(e, without))?.uid).toBeUndefined();
  });

  it("uid que não é texto invalida o token", async () => {
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sc: "ABC123", role: "guest", pid: "p", uid: 42, iat: 1, exp: 9_999_999_999 })).toString("base64url");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
    expect(await verifyLinkToken(e, `${head}.${body}.${sig}`)).toBeNull();
  });

  it("buildLinkCredentials só grava o uid quando recebe a conta", async () => {
    const base = { origin: "https://api.exemplo.test", shortCode: "ABC123", role: "guest" as const, peerId: "p" };
    const cfg = { ...e };
    const a = await buildLinkCredentials(cfg, { ...base, userId: UID });
    expect(await verifyLinkToken(e, a.signalToken)).toMatchObject({ uid: UID });
    const b = await buildLinkCredentials(cfg, base);
    expect((await verifyLinkToken(e, b.signalToken))?.uid).toBeUndefined();
  });
});

describe("contas online na sala (/online)", () => {
  const e = { LINK_TOKEN_SECRET: SECRET };
  const HOST_UID = "aaaaaaaa-e89b-42d3-a456-426614174001";
  const GUEST_UID = "bbbbbbbb-e89b-42d3-a456-426614174002";
  const online = async (sc: string) => {
    const stub = env.LINK_ROOM.get(env.LINK_ROOM.idFromName(sc));
    return (await (await stub.fetch("https://link-room.internal/online")).json()) as { uids: string[]; anonymous: number };
  };

  it("lista só as contas conectadas, sem repetir e sem quem entrou sem conta", async () => {
    const { shortCode } = await createServer();
    expect(await online(shortCode)).toEqual({ uids: [], anonymous: 0 });
    const hostTok = await signLinkToken(e, { sc: shortCode, role: "host", pid: "sess-host-0001", uid: HOST_UID });
    const guestTok = await signLinkToken(e, { sc: shortCode, role: "guest", pid: "sess-guest-001", uid: GUEST_UID });
    const guestTok2 = await signLinkToken(e, { sc: shortCode, role: "guest", pid: "sess-guest-002", uid: GUEST_UID }); // mesma conta, 2 aparelhos
    const anonTok = await signLinkToken(e, { sc: shortCode, role: "guest", pid: "sess-anon-0001" });
    const conns = [hostTok, guestTok, guestTok2, anonTok].map(async (t) => asConn(await connect(shortCode, t)));
    await Promise.all(conns);
    const now = await online(shortCode);
    expect(now.uids.sort()).toEqual([HOST_UID, GUEST_UID].sort());
    expect(now.anonymous).toBe(1); // só o convidado sem conta
  });
});
