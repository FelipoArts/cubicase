// ============================================================
// Service worker do painel web (PWA) — só notificações push e abertura do painel
// ============================================================
// Propositalmente NÃO guarda nada em cache: o painel é uma tela ao vivo (WebSocket) e uma cópia velha da página
// depois de um deploy seria pior do que uma tela em branco sem internet. Por isso não há handler de `fetch`.
//
// Mensagem de push (JSON cifrado, ver api/src/panel-push.ts):
//   { title, body, tag, deviceId, lang, action?: "start", serverName? }
// Se o painel está aberto e visível, ele já mostra a mudança ao vivo: nesse caso o push é descartado em silêncio
// (os navegadores permitem isso quando há uma janela do site visível).
// ============================================================

const PANEL_PATH = "/painel/";
const ICON = "/assets/pwa/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function safeJson(event) {
  try { return event.data ? event.data.json() : null; } catch { return null; }
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

self.addEventListener("push", (event) => {
  const data = safeJson(event);
  if (!data || typeof data !== "object") return;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((c) => c.visibilityState === "visible" && new URL(c.url).pathname.startsWith(PANEL_PATH))) return;

    const en = data.lang === "en";
    const options = {
      body: str(data.body, 200),
      tag: str(data.tag, 40) || "cubicase",
      renotify: true,
      icon: ICON,
      badge: ICON,
      data: { deviceId: str(data.deviceId, 64), action: data.action === "start" ? "start" : "", serverName: str(data.serverName, 60) },
    };
    if (data.action === "start") options.actions = [{ action: "start", title: en ? "Start server" : "Iniciar servidor" }];
    await self.registration.showNotification(str(data.title, 80) || "Cubicase", options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  n.close();
  const d = n.data || {};
  const wantsStart = event.action === "start" && d.action === "start";
  const target = { deviceId: d.deviceId || "", doStart: wantsStart, serverName: d.serverName || "" };

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).pathname.startsWith(PANEL_PATH));
    if (open) {
      await open.focus();
      open.postMessage({ type: "open-device", ...target });
      return;
    }
    const q = new URLSearchParams();
    if (target.deviceId) q.set("device", target.deviceId);
    if (wantsStart) { q.set("do", "start"); if (target.serverName) q.set("server", target.serverName); }
    const qs = q.toString();
    await self.clients.openWindow(PANEL_PATH + (qs ? `?${qs}` : ""));
  })());
});
