// ============================================================
// Testes de gerenciar os próprios computadores no painel: listar com "online", remover, renomear e limpar duplicados
// (Supabase e Durable Object simulados)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanDeviceName, handlePanelAccessRoute, type PanelDeps } from "./panel-members";

const ME = "aaaaaaaa-e89b-42d3-a456-426614174001";
const OTHER = "bbbbbbbb-e89b-42d3-a456-426614174002";
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 24 * 3600 * 1000;
const id = (n: number) => `${String(n).padStart(8, "0")}-e89b-42d3-a456-426614174000`;

interface Dev { id: string; user_id: string; device_name: string; last_seen_at: string | null; created_at: string }
let devices: Dev[] = [];
let members: { device_id: string; user_id: string }[] = [];
let invites: { device_id: string }[] = [];
let online = new Set<string>();
let unpaired: string[] = [];

function fakeSupabase() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/auth/v1/user")) return Response.json({ id: ME, email: "eu@teste.dev", user_metadata: {} });
    const eq = (k: string) => { const v = url.searchParams.get(k); return v && v.startsWith("eq.") ? v.slice(3) : undefined; };
    const inList = (k: string) => (url.searchParams.get(k) ?? "").replace(/^in\.\(|\)$/g, "").split(",");
    if (url.pathname.endsWith("/rest/v1/panel_devices")) {
      const match = (d: Dev) => (!eq("id") || d.id === eq("id")) && (!eq("user_id") || d.user_id === eq("user_id")) && (!url.searchParams.get("id")?.startsWith("in.") || inList("id").includes(d.id));
      if (method === "DELETE") { devices = devices.filter((d) => !match(d)); return new Response(null, { status: 204 }); }
      if (method === "PATCH") { devices.filter(match).forEach((d) => Object.assign(d, JSON.parse(String(init!.body)))); return new Response(null, { status: 204 }); }
      return Response.json(devices.filter(match));
    }
    if (url.pathname.endsWith("/rest/v1/panel_device_members")) {
      if (url.searchParams.get("device_id")?.startsWith("in.")) return Response.json(members.filter((m) => inList("device_id").includes(m.device_id)));
      return Response.json(members.filter((m) => !eq("user_id") || m.user_id === eq("user_id")).map((m) => ({ ...m, permissions: {}, panel_devices: devices.find((d) => d.id === m.device_id) })));
    }
    if (url.pathname.endsWith("/rest/v1/panel_device_invites")) {
      if (url.searchParams.get("device_id")?.startsWith("in.")) return Response.json(invites.filter((i) => inList("device_id").includes(i.device_id)));
      return Response.json([]);
    }
    return new Response("[]", { status: 404 });
  }));
}

function deps(): PanelDeps {
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (u: string) => {
        if (u.endsWith("/presence")) return Response.json({ agentOnline: online.has(name) });
        if (u.endsWith("/unpair")) { unpaired.push(name); return new Response(null, { status: 204 }); }
        return new Response(null, { status: 404 });
      },
    }),
  };
  return { env: { SUPABASE_SERVICE_ROLE_KEY: "k", HOST_CHANNEL: ns as unknown as DurableObjectNamespace }, rateLimit: async () => true };
}

const call = (method: string, path: string, body?: unknown) => {
  const req = new Request("https://x.test" + path, { method, headers: { Authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return handlePanelAccessRoute(req, deps(), method, path, new URL(req.url));
};
const dev = (n: number, name: string, seen: number | null, user = ME): Dev => ({ id: id(n), user_id: user, device_name: name, last_seen_at: seen === null ? null : iso(seen), created_at: iso(NOW - 40 * DAY + n) });

afterEach(() => { vi.unstubAllGlobals(); devices = []; members = []; invites = []; online = new Set(); unpaired = []; });

describe("cleanDeviceName", () => {
  it("arruma espaços, tira caracteres de controle e limita de 1 a 40 caracteres", () => {
    expect(cleanDeviceName("  PC   do  Felipo ")).toBe("PC do Felipo");
    expect(cleanDeviceName("a\u0007b")).toBe("a b");
    expect(cleanDeviceName("")).toBeNull();
    expect(cleanDeviceName("   ")).toBeNull();
    expect(cleanDeviceName(42)).toBeNull();
    expect(cleanDeviceName("x".repeat(41))).toBeNull();
    expect(cleanDeviceName("x".repeat(40))).toBe("x".repeat(40));
  });
});

describe("GET /devices", () => {
  it("devolve o estado online de cada computador e a data de criação, sem expor o token", async () => {
    fakeSupabase();
    devices = [dev(1, "PC", NOW), dev(2, "PC", null)];
    online = new Set([id(1)]);
    const r = await call("GET", "/api/v1/panel/devices");
    expect(r?.status).toBe(200);
    const owned = (r!.data as any).owned;
    expect(owned.map((d: any) => [d.id, d.online])).toEqual([[id(1), true], [id(2), false]]);
    expect(owned[0].createdAt).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain("device_token");
  });
});

describe("DELETE /devices/{id}", () => {
  it("o dono remove o computador e o Durable Object derruba as conexões", async () => {
    fakeSupabase();
    devices = [dev(1, "PC", NOW), dev(2, "Outro", NOW)];
    const r = await call("DELETE", `/api/v1/panel/devices/${id(1)}`);
    expect(r?.status).toBe(200);
    expect(devices.map((d) => d.id)).toEqual([id(2)]);
    expect(unpaired).toEqual([id(1)]);
  });

  it("não remove computador de outra conta nem inexistente", async () => {
    fakeSupabase();
    devices = [dev(1, "PC", NOW, OTHER)];
    expect((await call("DELETE", `/api/v1/panel/devices/${id(1)}`))?.status).toBe(404);
    expect((await call("DELETE", `/api/v1/panel/devices/${id(9)}`))?.status).toBe(404);
    expect(devices).toHaveLength(1);
    expect(unpaired).toEqual([]);
  });
});

describe("PATCH /devices/{id}", () => {
  it("renomeia com o nome arrumado e recusa nome inválido ou de outra conta", async () => {
    fakeSupabase();
    devices = [dev(1, "PC", NOW), dev(2, "X", NOW, OTHER)];
    const ok = await call("PATCH", `/api/v1/panel/devices/${id(1)}`, { deviceName: "  Casa   da vó " });
    expect(ok).toMatchObject({ status: 200, data: { deviceName: "Casa da vó" } });
    expect(devices[0].device_name).toBe("Casa da vó");
    expect((await call("PATCH", `/api/v1/panel/devices/${id(1)}`, { deviceName: "  " }))?.status).toBe(400);
    expect((await call("PATCH", `/api/v1/panel/devices/${id(1)}`, {}))?.status).toBe(400);
    expect((await call("PATCH", `/api/v1/panel/devices/${id(2)}`, { deviceName: "roubado" }))?.status).toBe(404);
    expect(devices[1].device_name).toBe("X");
  });
});

describe("POST /devices/cleanup", () => {
  it("entre os de mesmo nome fica o visto por último; some quem nunca conectou ou está parado há dias", async () => {
    fakeSupabase();
    devices = [
      dev(1, "FELIPOSYSTEM", NOW - 10 * 60_000),   // o mais recente: fica
      dev(2, "FELIPOSYSTEM", null),                // nunca conectou: sai
      dev(3, "feliposystem ", NOW - 20 * DAY),     // parado há dias (nome com outra caixa): sai
      dev(4, "Notebook", NOW - 30 * DAY),          // nome único: fica, mesmo parado
    ];
    const r = await call("POST", "/api/v1/panel/devices/cleanup");
    expect(r).toMatchObject({ status: 200, data: { removed: 2 } });
    expect(devices.map((d) => d.id).sort()).toEqual([id(1), id(4)]);
    expect(unpaired.sort()).toEqual([id(2), id(3)]);
    // idempotente
    expect(await call("POST", "/api/v1/panel/devices/cleanup")).toMatchObject({ data: { removed: 0 } });
  });

  it("não mexe em quem foi visto nas últimas 24 horas, em quem está online, em quem tem acesso compartilhado nem em convite pendente", async () => {
    fakeSupabase();
    devices = [
      dev(1, "PC", NOW - 1000),
      dev(2, "PC", NOW - 3 * 3600_000),            // visto há 3 horas: pode ser outro computador com o mesmo nome
      dev(3, "PC", null),                          // nunca conectou, mas está online agora
      dev(4, "PC", null),                          // tem membro
      dev(5, "PC", null),                          // tem convite pendente
    ];
    online = new Set([id(3)]);
    members = [{ device_id: id(4), user_id: OTHER }];
    invites = [{ device_id: id(5) }];
    expect(await call("POST", "/api/v1/panel/devices/cleanup")).toMatchObject({ status: 200, data: { removed: 0 } });
    expect(devices).toHaveLength(5);
  });

  it("não remove um computador recém-criado, mesmo sem ter conectado ainda", async () => {
    fakeSupabase();
    devices = [dev(1, "PC", NOW - 3 * DAY), { ...dev(2, "PC", null), created_at: iso(NOW - 60_000) }];
    expect(await call("POST", "/api/v1/panel/devices/cleanup")).toMatchObject({ data: { removed: 0 } });
    expect(devices).toHaveLength(2);
  });

  it("não remove nada de outra conta", async () => {
    fakeSupabase();
    devices = [dev(1, "PC", null, OTHER), dev(2, "PC", null, OTHER), dev(3, "PC", null)];
    expect(await call("POST", "/api/v1/panel/devices/cleanup")).toMatchObject({ data: { removed: 0 } });
    expect(devices).toHaveLength(3);
  });
});
