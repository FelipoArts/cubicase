// ============================================================
// Testes do Worker (API Central)
// ============================================================
// Roda contra um Worker real, isolado, via Miniflare (não é um mock em JS —
// o KV aqui aplica as MESMAS regras do Cloudflare de verdade, incluindo o
// TTL mínimo de 60s — é exatamente esse tipo de teste que teria pego o bug
// do WAKE_COOLDOWN_SECONDS=20 na hora, sem precisar de duas máquinas reais
// pra descobrir em produção). Cada teste começa com storage isolado (ver
// @cloudflare/vitest-pool-workers), então não precisa limpar KV manualmente.
// ============================================================

import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const BASE = "https://example.com";

async function createTestServer(name = "TesteAutomatizado") {
  const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ name, version: "1.20.1", serverType: "vanilla", description: "" }),
  });
  const body = await res.json();
  return { status: res.status, body, shortCode: body?.data?.shortCode as string, secret: body?.data?.ownerSecret as string };
}

// Cabeçalhos de dono (segredo devolvido uma vez no cadastro).
const owner = (secret: string, json = true): Record<string, string> => ({ ...(json ? { "Content-Type": "application/json" } : {}), "X-Owner-Secret": secret });

describe("/health", () => {
  it("responde 200 sem tocar no KV", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, code: "SUCCESS" });
  });
});

describe("ciclo de vida do servidor", () => {
  it("cria, descobre e remove um servidor", async () => {
    const { status, body, shortCode, secret } = await createTestServer();
    expect(status).toBe(201);
    expect(body.code).toBe("SERVER_CREATED");
    expect(shortCode).toMatch(/^[A-Z0-9]{6}$/);

    const discoverRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    expect(discoverRes.status).toBe(200);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.data.server.shortCode).toBe(shortCode);
    // Sem sessão nenhuma ainda: nem rede nem Minecraft têm status.
    expect(discoverBody.data.session.networkStatus).toBeNull();
    expect(discoverBody.data.session.minecraftStatus).toBeNull();

    const deleteRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`, { method: "DELETE", headers: owner(secret, false) });
    expect(deleteRes.status).toBe(200);

    const afterDeleteRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    expect(afterDeleteRes.status).toBe(404);
  });

  it("descobrir um shortCode inexistente dá 404, não 500", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("SERVER_NOT_FOUND");
  });

  // Regressão: sync_update_server (desktop) já mandava PATCH /api/v1/servers/{sc}
  // há tempos, mas nenhuma rota respondia — toda renomeação/atualização
  // simplesmente 404ava e nunca chegava a aplicar (achado de pré-lançamento).
  it("PATCH atualiza nome/versão/descrição sem tocar em uuid/owner/createdAt", async () => {
    const { body: createBody, shortCode, secret } = await createTestServer("NomeOriginal");
    const original = createBody.data;

    const patchRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`, {
      method: "PATCH",
      headers: owner(secret),
      body: JSON.stringify({ shortCode, name: "NomeNovo", version: "1.21.1" }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.code).toBe("SERVER_UPDATED");
    expect(patchBody.data.name).toBe("NomeNovo");
    expect(patchBody.data.version).toBe("1.21.1");
    // Campos não mandados no PATCH continuam como estavam.
    expect(patchBody.data.description).toBe(original.description);
    // Identidade nunca muda num update.
    expect(patchBody.data.uuid).toBe(original.uuid);
    expect(patchBody.data.owner).toBe(original.owner);
    expect(patchBody.data.createdAt).toBe(original.createdAt);
    expect(patchBody.data.shortCode).toBe(shortCode);

    const discoverRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.data.server.name).toBe("NomeNovo");
  });

  it("PATCH num shortCode inexistente dá 404, não cria nada", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ`, {
      method: "PATCH",
      headers: owner("s".repeat(32)),
      body: JSON.stringify({ shortCode: "ZZZZZZ", name: "Fantasma" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("SERVER_NOT_FOUND");
  });

  // Regressão: um retry automático de sync_register_server (ex: resposta do
  // primeiro POST perdida por timeout, mas já aplicada no servidor) reenvia o
  // MESMO shortCode — antes disso gerava um `uuid`/`owner` novos e resetava
  // `createdAt` a cada tentativa, corrompendo a identidade do servidor em
  // silêncio (achado de pré-lançamento).
  it("POST com shortCode já existente é um retry idempotente, não recria identidade", async () => {
    const { body: createBody, shortCode, secret } = await createTestServer("Original");
    const original = createBody.data;

    // Espera 1 tick de relógio pra createdAt/updatedAt não empatarem por acaso.
    await new Promise((r) => setTimeout(r, 5));

    const retryRes = await SELF.fetch(`${BASE}/api/v1/servers`, {
      method: "POST",
      headers: owner(secret),
      body: JSON.stringify({ name: "Original", version: "1.20.1", serverType: "vanilla", description: "", shortCode }),
    });
    expect(retryRes.status).toBe(201);
    const retryBody = await retryRes.json();
    expect(retryBody.data.shortCode).toBe(shortCode);
    // A identidade do servidor não pode mudar entre o create original e o retry.
    expect(retryBody.data.uuid).toBe(original.uuid);
    expect(retryBody.data.owner).toBe(original.owner);
    expect(retryBody.data.createdAt).toBe(original.createdAt);
  });

  it("regenera o código, invalidando o antigo (e o segredo do dono acompanha)", async () => {
    const { shortCode, secret } = await createTestServer();

    const regenRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/regenerate-code`, { method: "POST", headers: owner(secret, false) });
    expect(regenRes.status).toBe(200);
    const regenBody = await regenRes.json();
    const newShortCode = regenBody.data.shortCode as string;
    expect(newShortCode).not.toBe(shortCode);

    // Código antigo não existe mais.
    const oldRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    expect(oldRes.status).toBe(404);

    // Código novo funciona.
    const newRes = await SELF.fetch(`${BASE}/api/v1/servers/${newShortCode}`);
    expect(newRes.status).toBe(200);

    // O mesmo segredo continua valendo no código novo.
    const hb = await SELF.fetch(`${BASE}/api/v1/servers/${newShortCode}/heartbeat`, { method: "POST", headers: owner(secret), body: "{}" });
    expect(hb.status).toBe(200);
  });
});

describe("heartbeat + wake-on-demand (ver incidente de 2026-09-14/15)", () => {
  it("host manda heartbeat 'sleeping' e não há pedido de despertar por padrão", async () => {
    const { shortCode, secret } = await createTestServer();

    const hbRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, {
      method: "POST",
      headers: owner(secret),
      body: JSON.stringify({ status: "sleeping", currentPlayers: 0 }),
    });
    expect(hbRes.status).toBe(200);
    const hbBody = await hbRes.json();
    expect(hbBody.data.wakeRequested).toBe(false);

    // O status "sleeping" já aparece pro convidado via discover.
    const discoverRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.data.session.minecraftStatus).toBe("sleeping");
  });

  it("wake -> próxima heartbeat reporta wakeRequested e consome o pedido (não repete na seguinte)", async () => {
    const { shortCode, secret } = await createTestServer();

    // Regressão direta do bug de 2026-09-14: isso já deu 500 em produção
    // (KV PUT com TTL de 20s, abaixo do mínimo de 60s do Cloudflare) — se
    // voltar a acontecer, é aqui que este teste falha.
    const wakeRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, { method: "POST" });
    expect(wakeRes.status).toBe(200);

    const hb1 = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, {
      method: "POST",
      headers: owner(secret),
      body: JSON.stringify({ status: "sleeping" }),
    });
    expect((await hb1.json()).data.wakeRequested).toBe(true);

    // Consumido — a próxima heartbeat não deve mais reportar wakeRequested.
    const hb2 = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, {
      method: "POST",
      headers: owner(secret),
      body: JSON.stringify({ status: "sleeping" }),
    });
    expect((await hb2.json()).data.wakeRequested).toBe(false);
  });

  it("wake logo em seguida (mesmo shortCode) é bloqueado pelo cooldown, não gera 500", async () => {
    const { shortCode } = await createTestServer();

    const first = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, { method: "POST" });
    expect(first.status).toBe(200);

    const second = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, { method: "POST" });
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("wake num shortCode que não existe dá 404, não 500", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ/wake`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("descoberta NÃO tem custo de escrita/rate-limit (guest pode fazer polling frequente)", async () => {
    // Regressão do incidente de escrita excessiva no KV: até pouco tempo
    // atrás, cada chamada de descoberta escrevia no KV pra contar o rate
    // limit — isso sozinho estourou a cota diária de escrita da conta.
    // Descoberta hoje é só leitura; bem mais que DISCOVER_RATE_LIMIT (antigo,
    // já removido) de chamadas seguidas não deve travar em 429 nunca.
    const { shortCode } = await createTestServer();
    for (let i = 0; i < 80; i++) {
      const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
      expect(res.status).toBe(200);
    }
  });

  it("wake tem rate limit por IP, além do cooldown por shortCode", async () => {
    // Usa um shortCode por chamada pra isolar o limite por IP do cooldown
    // por shortCode (testado separadamente acima).
    const ip = "203.0.113.50";
    let sawRateLimited = false;
    for (let i = 0; i < 15; i++) {
      const { shortCode } = await createTestServer(`WakeRL${i}`);
      const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
      });
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(sawRateLimited).toBe(true);
  });

  it("regenerar código tem rate limit por IP", async () => {
    const { shortCode } = await createTestServer();
    const ip = "203.0.113.51";
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/regenerate-code`, {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
      });
      // Depois da primeira, o shortCode já mudou — 404 é esperado nas
      // próximas, mas o rate limit é checado ANTES do handler rodar, então
      // 429 continua aparecendo independente disso.
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});

describe("link de convite personalizado (slug)", () => {
  it("definir sem autenticação dá 401", async () => {
    const { shortCode } = await createTestServer();
    const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/slug`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "meu-mundo" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  it("remover sem autenticação também dá 401", async () => {
    const { shortCode } = await createTestServer();
    const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/slug`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("definir num shortCode inexistente dá 401 (autenticação é checada antes de existir o servidor)", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ/slug`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "meu-mundo" }),
    });
    expect(res.status).toBe(401);
  });

  it("resolver um slug inexistente (GET by-slug, usado pela página estática) dá 404", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/by-slug/slug-que-nao-existe`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("todo servidor já resolve de graça pelo próprio shortCode em minúsculas, sem precisar assinar nada", async () => {
    const { shortCode } = await createTestServer("MundoGratis");
    const res = await SELF.fetch(`${BASE}/api/v1/servers/by-slug/${shortCode.toLowerCase()}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.shortCode).toBe(shortCode);
    expect(body.data.name).toBe("MundoGratis");
  });
});

describe("endereço de conexão personalizado (connect-name)", () => {
  it("definir sem autenticação dá 401", async () => {
    const { shortCode } = await createTestServer();
    const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connect-name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectName: "meu-mundo" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  it("remover sem autenticação também dá 401", async () => {
    const { shortCode } = await createTestServer();
    const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connect-name`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("definir num shortCode inexistente dá 401 (autenticação é checada antes de existir o servidor)", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ/connect-name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectName: "meu-mundo" }),
    });
    expect(res.status).toBe(401);
  });

  it("é um campo independente do slug do link de convite — não aparece no discover até ser definido", async () => {
    const { shortCode } = await createTestServer("MundoIndependente");
    const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    const body = await res.json();
    expect(body.data.server.connectName ?? null).toBeNull();
  });
});

describe("proxy CurseForge", () => {
  it("bloqueia endpoints fora do allowlist", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/curseforge/v1/games`);
    expect(res.status).toBe(404);
  });

  it("libera busca e listagem de arquivos, mas responde 503 sem a API key configurada", async () => {
    for (const path of ["/v1/mods/search?gameId=432&classId=6", "/v1/mods/306612/files?gameVersion=1.20.1", "/v1/categories?gameId=432&classId=6"]) {
      const res = await SELF.fetch(`${BASE}/api/v1/curseforge${path}`);
      expect(res.status).toBe(503);
    }
  });

  it("não aceita POST na busca", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/curseforge/v1/mods/search`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("segredo do dono (shortCode é público, não autoriza ações de dono)", () => {
  it("sem segredo ou com segredo errado: delete/patch/regenerate/heartbeat/POST-retry são negados", async () => {
    const { shortCode } = await createTestServer("Alvo");
    const wrong = owner("x".repeat(32));
    const calls: [string, string, any][] = [
      ["DELETE", `/api/v1/servers/${shortCode}`, undefined],
      ["PATCH", `/api/v1/servers/${shortCode}`, { name: "Hackeado" }],
      ["POST", `/api/v1/servers/${shortCode}/regenerate-code`, undefined],
      ["POST", `/api/v1/servers/${shortCode}/heartbeat`, { status: "online" }],
      ["POST", "/api/v1/servers", { name: "Hackeado", version: "1", serverType: "vanilla", shortCode }],
    ];
    for (const [method, path, payload] of calls) {
      const noSecret = await SELF.fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
      expect(noSecret.status, `${method} ${path} sem segredo`).toBe(401);
      const badSecret = await SELF.fetch(`${BASE}${path}`, { method, headers: wrong, body: payload ? JSON.stringify(payload) : undefined });
      expect(badSecret.status, `${method} ${path} segredo errado`).toBe(403);
    }
    const discover = await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`)).json();
    expect(discover.data.server.name).toBe("Alvo");
  });

  it("host-mode de ConnectionSession exige o segredo; guest não", async () => {
    const { shortCode, secret } = await createTestServer();
    const payload = (mode: string) => JSON.stringify({ requestId: crypto.randomUUID(), correlationId: "c", clientVersion: "t", installationId: "install-owner-01", mode, launcher: "link-v1" });
    const url = `${BASE}/api/v1/servers/${shortCode}/connection-sessions`;
    const hostNoSecret = await SELF.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload("host") });
    expect(hostNoSecret.status).toBe(401);
    const hostWrong = await SELF.fetch(url, { method: "POST", headers: owner("y".repeat(32)), body: payload("host") });
    expect(hostWrong.status).toBe(403);
    // Com o segredo certo a sessão do host é criada.
    const hostOk = await SELF.fetch(url, { method: "POST", headers: owner(secret), body: payload("host") });
    expect(hostOk.status).toBe(201);
    // O convidado não precisa de segredo.
    const guestOk = await SELF.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload("guest") });
    expect(guestOk.status).toBe(201);
  });

  it("servidor legado (sem hash) é reivindicado pelo primeiro dono que traz segredo; depois só ele", async () => {
    const { shortCode } = await createTestServer();
    const { env } = await import("cloudflare:test");
    await (env as any).CUBEFORGE_REGISTRY.delete(`owner:${shortCode}`); // simula servidor cadastrado antes desta versão
    const first = "a".repeat(32), other = "b".repeat(32);
    const claim = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, { method: "POST", headers: owner(first), body: "{}" });
    expect(claim.status).toBe(200);
    const intruder = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, { method: "POST", headers: owner(other), body: "{}" });
    expect(intruder.status).toBe(403);
  });

  it("cadastro valida shortCode e tamanho dos campos", async () => {
    const secret = "z".repeat(32);
    const bad = async (extra: object) =>
      (await SELF.fetch(`${BASE}/api/v1/servers`, { method: "POST", headers: owner(secret), body: JSON.stringify({ name: "n", version: "1", serverType: "vanilla", ...extra }) })).status;
    expect(await bad({ shortCode: "a:b" })).toBe(400);
    expect(await bad({ shortCode: "X".repeat(40) })).toBe(400);
    expect(await bad({ name: "n".repeat(500) })).toBe(400);
  });
});

describe("vários convidados ao mesmo tempo (regressão: 2º amigo recebia 409 OPERATION_IN_PROGRESS)", () => {
  const join = (shortCode: string, installationId: string, mode = "guest", headers: Record<string, string> = {}) =>
    SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connection-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ requestId: crypto.randomUUID(), correlationId: "c", clientVersion: "t", installationId, mode, launcher: "link-v1" }),
    });
  const sessionExists = async (id: string) => {
    const { env } = await import("cloudflare:test");
    return (await (env as any).CUBEFORGE_REGISTRY.get(`csession:${id}`)) !== null;
  };

  it("dois convidados (instalações diferentes) entram ao mesmo tempo", async () => {
    const { shortCode } = await createTestServer();
    const a = await join(shortCode, "install-aaaaaaaa");
    const b = await join(shortCode, "install-bbbbbbbb");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const [sa, sb] = [(await a.json()).data.sessionId, (await b.json()).data.sessionId];
    expect(sa).not.toBe(sb);
    expect(await sessionExists(sa)).toBe(true); // ninguém foi derrubado
    expect(await sessionExists(sb)).toBe(true);
  });

  it("a mesma instalação reconectando substitui a sessão antiga (sem 409)", async () => {
    const { shortCode } = await createTestServer();
    const first = await join(shortCode, "install-aaaaaaaa");
    expect(first.status).toBe(201);
    const firstId = (await first.json()).data.sessionId;
    const second = await join(shortCode, "install-aaaaaaaa");
    expect(second.status).toBe(201);
    expect(await sessionExists(firstId)).toBe(false);
    expect(await sessionExists((await second.json()).data.sessionId)).toBe(true);
  });

  it("o host (dono) reconectando logo após uma queda também não fica barrado", async () => {
    const { shortCode, secret } = await createTestServer();
    const h1 = await join(shortCode, "install-hhhhhhhh", "host", owner(secret, false));
    expect(h1.status).toBe(201);
    const h2 = await join(shortCode, "install-hhhhhhhh", "host", owner(secret, false));
    expect(h2.status).toBe(201);
  });

  it("apagar o servidor derruba as sessões de todos os convidados", async () => {
    const { shortCode, secret } = await createTestServer();
    const ja = await join(shortCode, "install-aaaaaaaa");
    const jb = await join(shortCode, "install-bbbbbbbb");
    expect([ja.status, jb.status]).toEqual([201, 201]);
    const [ida, idb] = [(await ja.json()).data.sessionId, (await jb.json()).data.sessionId];
    const del = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`, { method: "DELETE", headers: owner(secret, false) });
    expect(del.status).toBe(200);
    expect(await sessionExists(ida)).toBe(false);
    expect(await sessionExists(idb)).toBe(false);
  });
});

describe("app antigo (Tailscale foi descontinuado)", () => {
  const legacy = (shortCode: string, extra: object = {}, headers: Record<string, string> = { "Content-Type": "application/json" }, lang?: string) =>
    SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connection-sessions`, {
      method: "POST",
      headers: { ...headers, ...(lang ? { "Accept-Language": lang } : {}) },
      body: JSON.stringify({ requestId: crypto.randomUUID(), correlationId: "c", clientVersion: "t", installationId: "install-aaaaaaaa", mode: "guest", ...extra }),
    });

  it("quem não pede o launcher link-v1 (versões antigas) recebe um pedido claro de atualização, não um erro técnico", async () => {
    const { shortCode } = await createTestServer();
    const res = await legacy(shortCode);
    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.code).toBe("CLIENT_OUTDATED");
    expect(body.message).toMatch(/Atualize/);
    expect((await (await legacy(shortCode, { launcher: "tsnet-v1" })).json()).code).toBe("CLIENT_OUTDATED");
  });

  it("a mensagem de atualização também existe em inglês", async () => {
    const { shortCode } = await createTestServer();
    const body = await (await legacy(shortCode, {}, { "Content-Type": "application/json" }, "en")).json();
    expect(body.message).toMatch(/Update/);
  });

  it("o app antigo não consegue nem hospedar (o dono continua sendo checado antes)", async () => {
    const { shortCode, secret } = await createTestServer();
    expect((await legacy(shortCode, { mode: "host" })).status).toBe(401);
    expect((await legacy(shortCode, { mode: "host" }, owner(secret))).status).toBe(426);
  });

  it("PATCH da sessão ignora hostIp (o P2P não tem IP de malha) e não quebra", async () => {
    const { shortCode } = await createTestServer();
    const created = await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/connection-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), correlationId: "c", clientVersion: "t", installationId: "install-aaaaaaaa", mode: "guest", launcher: "link-v1" }),
    })).json();
    const res = await SELF.fetch(`${BASE}/api/v1/connection-sessions/${created.data.sessionId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.data.credentials.signalToken}` }, body: JSON.stringify({ status: "online", hostIp: "8.8.8.8" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("plano B: IP do Radmin no heartbeat do host", () => {
  const beat = (shortCode: string, secret: string, body: object) =>
    SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, { method: "POST", headers: owner(secret), body: JSON.stringify({ status: "online", ...body }) });
  const session = async (shortCode: string) => (await (await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`)).json()).data.session;

  it("publica o IP do Radmin e a porta do Minecraft, e a descoberta os devolve", async () => {
    const { shortCode, secret } = await createTestServer();
    expect((await beat(shortCode, secret, { radminIp: "26.202.7.93", port: 25570 })).status).toBe(200);
    const s = await session(shortCode);
    expect(s.radminIp).toBe("26.202.7.93");
    expect(s.minecraftPort).toBe(25570);
  });

  it("o IP some quando o host sai da rede do Radmin (null) e quando o heartbeat não o menciona, nada muda", async () => {
    const { shortCode, secret } = await createTestServer();
    await beat(shortCode, secret, { radminIp: "26.1.2.3" });
    await beat(shortCode, secret, { currentPlayers: 2 }); // não menciona: mantém
    expect((await session(shortCode)).radminIp).toBe("26.1.2.3");
    await beat(shortCode, secret, { radminIp: null });
    const s = await session(shortCode);
    expect(s.radminIp).toBeNull();
    expect(s.minecraftPort).toBeNull();
  });

  it("recusa qualquer coisa que não seja IP da faixa 26.0.0.0/8 (nunca devolve texto arbitrário aos convidados)", async () => {
    const { shortCode, secret } = await createTestServer();
    for (const bad of ["100.64.0.1", "26.300.1.1", "26.1.1", "26.1.1.1.1", "evil.example", "26.1.1.1:80", "<script>", 26, ""]) {
      await beat(shortCode, secret, { radminIp: bad });
      expect((await session(shortCode)).radminIp, String(bad)).toBeNull();
    }
  });

  it("porta fora da faixa é ignorada", async () => {
    const { shortCode, secret } = await createTestServer();
    await beat(shortCode, secret, { radminIp: "26.1.2.3", port: 80 });
    expect((await session(shortCode)).minecraftPort).toBe(25565);
    await beat(shortCode, secret, { port: 70000 });
    expect((await session(shortCode)).minecraftPort).toBe(25565);
  });

  it("só o dono publica (o heartbeat continua exigindo o segredo)", async () => {
    const { shortCode } = await createTestServer();
    const r = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radminIp: "26.1.2.3" }) });
    expect(r.status).toBe(401);
  });
});
