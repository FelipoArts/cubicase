// Teste ponta a ponta LOCAL do transporte P2P: sidecar Go real (cubicase-link) ⇄ sala real
// (Worker + Durable Object rodando em `wrangler dev`) ⇄ Minecraft falso + servidor HTTP de mods falso.
//
//   node scripts/e2e-link-local.mjs
//
// Pré-requisito: o binário do sidecar (npm run build:sidecar, ou
//   cd src-tauri/sidecars/cubicase-link && go build -o ../../binaries/cubicase-link-x86_64-pc-windows-msvc.exe .)
// Use LINK_BIN para apontar outro binário. Não usa Tailscale nem a internet (só STUN, que é opcional).
import { spawn } from "node:child_process";
import { createServer as createTcp, connect } from "node:net";
import { createServer as createHttp } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.LINK_BIN || path.join(ROOT, "src-tauri", "binaries", "cubicase-link-x86_64-pc-windows-msvc.exe");
const PORT = 8799;
const API = `http://127.0.0.1:${PORT}`;
const procs = [];
let failed = false;
let tmpDir = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log("•", ...a); }
function check(cond, msg) { if (!cond) { failed = true; console.error("✗", msg); } else console.log("✓", msg); }

function freePort() {
  return new Promise((res) => { const s = createTcp(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function lines(proc, onLine) {
  let buf = "";
  proc.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(50); }
  throw new Error(`tempo esgotado esperando: ${what}`);
}

async function main() {
  if (!existsSync(BIN)) throw new Error(`binário do sidecar não encontrado: ${BIN}`);
  const tmp = (tmpDir = mkdtempSync(path.join(tmpdir(), "link-e2e-")));

  log("subindo o Worker local (wrangler dev)…");
  const wr = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1",
    "--var", "LINK_TOKEN_SECRET:segredo-e2e-local-0123456789abcdef", "--persist-to", path.join(tmp, "state")],
  { cwd: path.join(ROOT, "api"), shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  procs.push(wr);
  let ready = false;
  wr.stdout.on("data", (d) => { if (String(d).includes("Ready on")) ready = true; });
  wr.stderr.on("data", () => {});
  await waitFor(() => ready, 90_000, "wrangler dev pronto");

  const post = async (url, body, headers = {}) => {
    const r = await fetch(API + url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const srv = await post("/api/v1/servers", { name: "E2E", version: "1.20.1", serverType: "vanilla" });
  const code = srv.body.data.shortCode;
  const owner = { "X-Owner-Secret": srv.body.data.ownerSecret };
  const sess = (mode, install, headers) => post(`/api/v1/servers/${code}/connection-sessions`, {
    requestId: randomUUID(), correlationId: "e2e", clientVersion: "e2e", installationId: install, mode, launcher: "link-v1",
  }, headers);
  const hostSess = await sess("host", "install-host-0001", owner);
  const guestSess = await sess("guest", "install-guest-0001", {});
  check(hostSess.status === 201 && guestSess.status === 201, "API emitiu as sessões link-v1 (sem Tailscale)");

  // serviços locais falsos
  const mcPort = await freePort();
  const mc = createTcp((c) => c.pipe(c)).listen(mcPort, "127.0.0.1"); // "Minecraft": eco
  const regPort = await freePort();
  const reg = createHttp((q, r) => r.end("mods-ok " + q.url)).listen(regPort, "127.0.0.1");
  const gamePort = await freePort();
  const modsPort = await freePort();

  const cfg = (mode, s, extra) => ({ mode, peerId: s.body.data.sessionId, signalUrl: s.body.data.credentials.signalUrl.replace("localhost", "127.0.0.1"),
    signalToken: s.body.data.credentials.signalToken, ice: { stunUrls: [] }, ...extra });
  const hostCfg = path.join(tmp, "host.json");
  const guestCfg = path.join(tmp, "guest.json");
  writeFileSync(hostCfg, JSON.stringify(cfg("host", hostSess, { localPort: mcPort, registryPort: regPort })));
  writeFileSync(guestCfg, JSON.stringify(cfg("guest", guestSess, { localPort: gamePort, modsPort })));

  const events = { host: [], guest: [] };
  const run = (role, file) => {
    const p = spawn(BIN, ["--config", file], { stdio: ["pipe", "pipe", "inherit"] });
    procs.push(p);
    lines(p, (l) => { try { events[role].push(JSON.parse(l)); } catch { /* ignora */ } });
    return p;
  };
  run("host", hostCfg);
  await waitFor(() => events.host.find((e) => e.status === "online"), 15_000, "host online");
  run("guest", guestCfg);
  await waitFor(() => events.guest.find((e) => e.status === "online"), 15_000, "convidado online");

  // Minecraft: 1 MiB de ida e volta pelo túnel real
  const payload = randomBytes(1024 * 1024);
  const echoed = await new Promise((resolve, reject) => {
    const c = connect(gamePort, "127.0.0.1");
    const chunks = []; let got = 0;
    const t = setTimeout(() => reject(new Error("eco não voltou em 40 s")), 40_000);
    c.on("data", (d) => { chunks.push(d); got += d.length; if (got >= payload.length) { clearTimeout(t); c.destroy(); resolve(Buffer.concat(chunks)); } });
    c.on("error", reject);
    c.write(payload);
  });
  check(Buffer.compare(echoed, payload) === 0, "1 MiB de ida e volta pelo túnel P2P com a sala real");

  const http = await (await fetch(`http://127.0.0.1:${modsPort}/mods?code=${code}`)).text();
  check(http === "mods-ok /mods?code=" + code, "proxy de mods atravessa o túnel até o HTTP do host");

  const pathEv = await waitFor(() => events.guest.find((e) => e.path), 15_000, "evento de caminho");
  check(["direct-v4", "direct-v6", "punched"].includes(pathEv.path), `caminho reportado: ${pathEv.path}${pathEv.rttMs != null ? ` (${pathEv.rttMs} ms)` : ""}`);

  // presença na descoberta
  const disc = await (await fetch(`${API}/api/v1/servers/${code}`)).json();
  check(disc.data.session.networkStatus === "online", "a descoberta mostra o host online (presença vinda da sala)");

  mc.close(); reg.close();
}

main()
  .catch((e) => { failed = true; console.error("✗", e.message); })
  .finally(() => {
    for (const p of procs) { try { p.kill(); } catch { /* já saiu */ } }
    // Limpeza depois de matar os processos (o wrangler segura arquivos por um instante; falhar aqui não importa).
    setTimeout(() => {
      try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignora */ }
      process.exit(failed ? 1 : 0);
    }, 1500);
  });
