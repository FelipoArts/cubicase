import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// O service worker do painel web (docs/painel/sw.js) roda fora do app; aqui ele é executado num contexto
// simulado para garantir o que importa: push só vira notificação com o painel fora de vista, dados de fora são
// limitados, e o toque na notificação abre/foca o painel no computador certo.

const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../docs/painel/sw.js"), "utf8");

type SwEvent = Record<string, unknown>;
interface FakeClient { url: string; visibilityState: "visible" | "hidden"; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }
const client = (url: string, visibilityState: "visible" | "hidden" = "hidden"): FakeClient => ({ url, visibilityState, focus: vi.fn(async () => undefined), postMessage: vi.fn() });

function loadSw(clients: FakeClient[]) {
  const handlers: Record<string, (e: SwEvent) => void> = {};
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const self = {
    addEventListener: (type: string, fn: (e: SwEvent) => void) => { handlers[type] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => clients), openWindow },
    registration: { showNotification },
  };
  vm.runInNewContext(SW_SOURCE, { self, URL, URLSearchParams, console });
  return { handlers, showNotification, openWindow };
}

async function push(sw: ReturnType<typeof loadSw>, data: unknown) {
  let pending: Promise<unknown> = Promise.resolve();
  sw.handlers.push({ data: data === undefined ? null : { json: () => { if (data === "invalid") throw new Error("json"); return data; } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
  await pending;
}

async function click(sw: ReturnType<typeof loadSw>, notificationData: object, action = "") {
  let pending: Promise<unknown> = Promise.resolve();
  const close = vi.fn();
  sw.handlers.notificationclick({ action, notification: { close, data: notificationData }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
  await pending;
  return close;
}

describe("sw.js do painel", () => {
  it("mostra a notificação quando o painel não está aberto", async () => {
    const sw = loadSw([]);
    await push(sw, { title: "Servidor parou", body: "Survival não está mais rodando.", tag: "server", deviceId: "dev-1", lang: "pt-BR", action: "start", serverName: "Survival" });
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0] as unknown as [string, NotificationOptions & { actions?: unknown[]; data: { action: string } }];
    expect(title).toBe("Servidor parou");
    expect(options).toMatchObject({ body: "Survival não está mais rodando.", tag: "server", data: { deviceId: "dev-1", action: "start", serverName: "Survival" } });
    expect(options.actions).toEqual([{ action: "start", title: "Iniciar servidor" }]);
  });

  it("não mostra nada se o painel está aberto e visível (a tela já mostra ao vivo)", async () => {
    const sw = loadSw([client("https://cubicase.net/painel/", "visible")]);
    await push(sw, { title: "x", body: "y", tag: "server", deviceId: "d" });
    expect(sw.showNotification).not.toHaveBeenCalled();
  });

  it("painel aberto mas em segundo plano, ou outra página do site visível: mostra", async () => {
    const hidden = loadSw([client("https://cubicase.net/painel/", "hidden")]);
    await push(hidden, { title: "x", body: "y", tag: "t", deviceId: "d" });
    expect(hidden.showNotification).toHaveBeenCalled();
    const otherPage = loadSw([client("https://cubicase.net/tutorial/", "visible")]);
    await push(otherPage, { title: "x", body: "y", tag: "t", deviceId: "d" });
    expect(otherPage.showNotification).toHaveBeenCalled();
  });

  it("ignora push sem corpo ou com JSON inválido, e limita o tamanho dos textos", async () => {
    const sw = loadSw([]);
    await push(sw, undefined);
    await push(sw, "invalid");
    expect(sw.showNotification).not.toHaveBeenCalled();
    await push(sw, { title: "T".repeat(500), body: "B".repeat(500), tag: "g".repeat(500), deviceId: "d".repeat(500), action: "formatar-disco" });
    const [title, options] = sw.showNotification.mock.calls[0] as unknown as [string, NotificationOptions & { actions?: unknown[]; data: { action: string } }];
    expect(title.length).toBe(80);
    expect(options.body!.length).toBe(200);
    expect(options.tag!.length).toBe(40);
    expect(options.data.action).toBe(""); // só "start" é uma ação conhecida
    expect(options.actions).toBeUndefined();
  });

  it("toque na notificação sem painel aberto: abre o painel direto no computador", async () => {
    const sw = loadSw([]);
    const close = await click(sw, { deviceId: "dev-1", action: "", serverName: "" });
    expect(close).toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith("/painel/?device=dev-1");
  });

  it("botão 'Iniciar servidor': leva o pedido de início (o painel ainda pede confirmação)", async () => {
    const sw = loadSw([]);
    await click(sw, { deviceId: "dev-1", action: "start", serverName: "Meu Mundo" }, "start");
    expect(sw.openWindow).toHaveBeenCalledWith("/painel/?device=dev-1&do=start&server=Meu+Mundo");
  });

  it("tocar na notificação em si (não no botão) nunca pede início", async () => {
    const sw = loadSw([]);
    await click(sw, { deviceId: "dev-1", action: "start", serverName: "S" }, "");
    expect(sw.openWindow).toHaveBeenCalledWith("/painel/?device=dev-1");
  });

  it("com o painel já aberto: foca a janela e avisa a página, sem abrir outra", async () => {
    const open = client("https://cubicase.net/painel/");
    const sw = loadSw([client("https://cubicase.net/tutorial/"), open]);
    await click(sw, { deviceId: "dev-1", action: "start", serverName: "S" }, "start");
    expect(open.focus).toHaveBeenCalled();
    expect(open.postMessage).toHaveBeenCalledWith({ type: "open-device", deviceId: "dev-1", doStart: true, serverName: "S" });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});
