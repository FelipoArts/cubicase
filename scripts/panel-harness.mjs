// Servidor local para ver o painel web (docs/painel) antes de publicar.
//
//   node scripts/panel-harness.mjs            → modo "fake" (porta 4173)
//   node scripts/panel-harness.mjs live       → modo "live" (porta 4173)
//   node scripts/panel-harness.mjs fake 5000  → outra porta
//
// FAKE — sem login, sem rede, sem Worker, sem app. Troca o Supabase e o
//   WebSocket por versões falsas. Abra http://localhost:4173/ , clique no
//   computador "PC Teste" e simule o que o app mandaria pelo console do
//   navegador:
//     __ws.push({type:'access', isOwner:true, permissions:{viewConsole:true,start:true,stop:true,restart:true,commands:{mode:'all',allowlist:[]}}})
//     __ws.push({type:'agent_connected'})
//     __ws.push({type:'status', serverRunning:true, serverName:'meu', playerCount:2, maxPlayers:20})
//     __ws.push({type:'players', players:['Steve','Alex_99']})
//     __ws.sent            // o que o painel enviou (player_action etc.)
//     __ws.push({type:'player_action_result', requestId:__ws.sent.at(-1).requestId, ok:true, action:'kick', player:'Steve', message:'Comando enviado ao servidor.'})
//   Valida só a interface; não passa pelo relay nem pelo agente Rust.
//
// LIVE — serve o painel REAL, sem alterações. Use junto com o Worker local e o
//   app em dev (passo a passo em scripts/panel-harness.md). Abra
//   http://localhost:4173/?relay=http://localhost:8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const mode = process.argv[2] === "live" ? "live" : "fake";
const port = Number(process.argv[3] ?? process.argv[2]) || 4173;

const FAKE_STUB = `<script>
window.__createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "x", user: { id: "u1" } } } }),
  onAuthStateChange() {}, signOut: async () => {}, signInWithOAuth() {}, signInWithOtp: async () => ({}) } });
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/v1/panel/devices")) return ok({ owned: [{ id: "d1", deviceName: "PC Teste", lastSeenAt: null }], shared: [], pendingInvites: [] });
  if (u.includes("/ws-ticket")) return ok({ ticket: "t1" });
  return realFetch(url, opts);
};
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.l = {}; window.__ws = this; setTimeout(() => { this.readyState = 1; this.emit("open", {}); }, 5); }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  emit(t, e) { (this.l[t] || []).forEach((f) => f(e)); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() {}
  push(o) { this.emit("message", { data: JSON.stringify(o) }); }
}
FakeWS.OPEN = 1; window.WebSocket = FakeWS;
</script>`;

// Lido a cada requisição: editar o painel e dar F5 já mostra a mudança.
function renderPanel() {
  const html = fs.readFileSync(path.join(DOCS, "painel/index.html"), "utf8");
  if (mode === "live") return html;
  return html
    .replace('import { createClient } from "https://esm.sh/@supabase/supabase-js@2";', "const createClient = window.__createClient;")
    .replace("<head>", "<head>" + FAKE_STUB);
}

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json" };

http
  .createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/" || p === "/painel/" || p === "/painel") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPanel());
    }
    const file = path.join(DOCS, p);
    if (file.startsWith(DOCS + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404);
    res.end("not found");
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Painel (${mode}) em http://localhost:${port}/` + (mode === "live" ? "?relay=http://localhost:8787" : ""));
  });
