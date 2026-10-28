// Teste de campo da conexão (host + vários convidados) usando o cubicase-link de verdade e a infraestrutura PUBLICADA:
// a API, a sala de sinalização (Durable Object) e o relay TURN. Não é um teste unitário: cria um servidor de teste na
// central, roda alguns segundos de tráfego e apaga o servidor no fim.
//
//   node scripts/e2e-link.mjs                       # padrão: 6 convidados, metade forçada pelo relay
//   node scripts/e2e-link.mjs --guests 8 --relay 4  # 8 convidados, 4 forçados pelo relay
//   node scripts/e2e-link.mjs --api https://...     # outra API (padrão: a de produção)
//
// O que verifica (tudo com os bytes conferidos por hash):
//   1. cada convidado entra e troca dados com o "Minecraft" do host, pelo caminho direto ou pelo relay;
//   2. todos ao mesmo tempo, com várias conexões por convidado;
//   3. um convidado que some de repente não atrapalha os outros, e um novo consegue entrar;
//   4. o host cai e volta: os convidados se recuperam.
//   node scripts/e2e-link.mjs --relay 3 --turn tcp  # relay só por TCP (UDP bloqueado); --turn tls = só porta 443
// O tráfego pelo relay conta na cota do servidor de teste (alguns MB) e é pequeno.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const API = arg("api", "https://cubeforge-api.cubeforge.workers.dev");
const GUESTS = Number(arg("guests", 6));
const RELAY_GUESTS = Number(arg("relay", Math.floor(GUESTS / 2)));
const BIN = arg("bin", path.join(ROOT, "src-tauri", "binaries", "cubicase-link-x86_64-pc-windows-msvc.exe"));
const PAYLOAD_MB = Number(arg("mb", 2));
// Como o relay é alcançado pelos convidados forçados: udp (padrão), tcp (UDP bloqueado) ou tls (só a porta 443, a que
// passa por quase todo firewall).
const TURN_MODE = arg("turn", "udp");

const MC_PORT = 39000;      // "Minecraft" falso do host (devolve tudo que recebe)
const GUEST_BASE = 39100;   // porta local de cada convidado
const MODS_BASE = 39200;    // porta do proxy de mods de cada convidado (não usada no teste, mas precisa ser única)
const REGISTRY_PORT = 39001;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const problems = [];
const check = (ok, what) => { if (!ok) { problems.push(what); log("  ✗ FALHOU:", what); } return ok; };

// ---------------- API ----------------
async function api(method, route, { body, headers } = {}) {
  const res = await fetch(API + route, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json)?.slice(0, 200)}`);
  return json?.data ?? json;
}

async function newSession(shortCode, mode, installationId, ownerSecret) {
  const data = await api("POST", `/api/v1/servers/${shortCode}/connection-sessions`, {
    headers: ownerSecret ? { "X-Owner-Secret": ownerSecret } : {},
    body: { requestId: randomUUID(), correlationId: randomUUID(), clientVersion: "e2e-0", installationId, launcher: "link-v1", mode },
  });
  return data.credentials;
}

// ---------------- processos do cubicase-link ----------------
class Peer {
  constructor(name, cfg) {
    this.name = name;
    this.events = [];
    this.waiters = [];
    this.proc = spawn(BIN, ["--stdin"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { this.onEvent(JSON.parse(line)); } catch { /* linha que não é JSON */ }
      }
    });
    this.stderr = [];
    this.proc.stderr.on("data", (d) => { this.stderr.push(...d.toString().split(/\r?\n/).filter(Boolean)); if (this.stderr.length > 400) this.stderr.splice(0, 200); });
    this.exited = new Promise((r) => this.proc.on("exit", r));
    this.proc.stdin.write(JSON.stringify(cfg) + "\n");
  }
  onEvent(ev) {
    this.events.push({ at: Date.now(), ...ev });
    this.waiters = this.waiters.filter((w) => !(w.test(ev) && (w.resolve(ev), true)));
  }
  waitFor(test, ms, label) {
    const found = this.events.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: sem "${label}" em ${ms / 1000}s (eventos: ${JSON.stringify(this.events.slice(-4))})`)), ms);
      this.waiters.push({ test, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }
  lastPath() { return [...this.events].reverse().find((e) => e.path)?.path ?? null; }
  kill() { try { this.proc.kill("SIGKILL"); } catch { /* já saiu */ } }
  async stop() { try { this.proc.stdin.end(); } catch { /* */ } await Promise.race([this.exited, sleep(3000)]); this.kill(); }
}

const baseCfg = (creds) => ({
  peerId: creds.peerId, signalUrl: creds.signalUrl, signalToken: creds.signalToken,
  ice: creds.ice,
});

// ---------------- o "Minecraft" do host: devolve tudo que recebe ----------------
const echo = net.createServer((sock) => { sock.on("data", (d) => sock.write(d)); sock.on("error", () => {}); });
const registry = net.createServer((sock) => { sock.on("error", () => {}); sock.end(); });

// ---------------- tráfego de um convidado ----------------
function roundTrip(port, payload, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks = [];
    let got = 0;
    const sock = net.connect({ host: "127.0.0.1", port }, () => sock.write(payload));
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`tempo esgotado (${got}/${payload.length} bytes)`)); }, timeoutMs);
    sock.on("data", (d) => {
      chunks.push(d); got += d.length;
      if (got >= payload.length) { clearTimeout(timer); sock.destroy(); resolve({ ms: Date.now() - started, back: Buffer.concat(chunks) }); }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.on("close", () => { if (got < payload.length) { clearTimeout(timer); reject(new Error(`fechou com ${got}/${payload.length} bytes`)); } });
  });
}

async function latency(port, n = 15) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const p = randomBytes(64);
    const r = await roundTrip(port, p, { timeoutMs: 15000 });
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
}

async function exchange(g, mb, tag) {
  const payload = randomBytes(Math.floor(mb * 1024 * 1024));
  try {
    const r = await roundTrip(g.port, payload);
    const same = sha(r.back) === sha(payload);
    check(same, `${g.name} ${tag}: os bytes devolvidos são diferentes dos enviados`);
    return { ok: same, mbps: (payload.length * 2 / 1048576) / (r.ms / 1000), ms: r.ms };
  } catch (e) {
    check(false, `${g.name} ${tag}: ${e.message}`);
    return { ok: false, mbps: 0, ms: 0 };
  }
}

// ---------------- cenário ----------------
let server, ownerSecret, host;
const guests = [];

async function startGuest(i, forceRelay) {
  const installationId = `e2e-guest-${randomUUID().slice(0, 12)}`;
  const creds = await newSession(server.shortCode, "guest", installationId);
  if (forceRelay && !creds.ice?.turn) throw new Error("o relay não foi liberado para este convidado (cota/relay desligado)");
  if (forceRelay && creds.ice?.turn && TURN_MODE !== "udp") {
    const urls = creds.ice.turn.urls.filter((u) => (TURN_MODE === "tls" ? u.startsWith("turns:") : u.startsWith("turn:") && u.includes("transport=tcp")));
    if (!urls.length) throw new Error(`a API não ofereceu relay no modo ${TURN_MODE}`);
    creds.ice.turn = { ...creds.ice.turn, urls };
  }
  const g = { name: `convidado${i}${forceRelay ? "(relay)" : "(direto)"}`, forceRelay, port: GUEST_BASE + i, creds, installationId };
  g.peer = new Peer(g.name, { mode: "guest", ...baseCfg(creds), relayOnly: forceRelay, localPort: g.port, modsPort: MODS_BASE + i, registryPort: REGISTRY_PORT });
  g.startedAt = Date.now();
  await g.peer.waitFor((e) => e.status === "online" || e.info === "listening" || e.path, 45000, "convidado pronto");
  return g;
}

async function main() {
  log(`API: ${API} | convidados: ${GUESTS} (${RELAY_GUESTS} forçados pelo relay, via ${TURN_MODE}) | carga: ${PAYLOAD_MB} MB por troca`);
  await new Promise((r) => echo.listen(MC_PORT, "127.0.0.1", r));
  await new Promise((r) => registry.listen(REGISTRY_PORT, "127.0.0.1", r));

  // 1. servidor de teste na central + host
  const created = await api("POST", "/api/v1/servers", { body: { name: `E2E-${Date.now().toString(36)}`, version: "1.20.1", serverType: "vanilla", description: "teste de campo (apagado ao final)" } });
  server = { shortCode: created.shortCode };
  ownerSecret = created.ownerSecret;
  log(`servidor de teste ${server.shortCode} criado`);

  const hostCreds = await newSession(server.shortCode, "host", `e2e-host-${randomUUID().slice(0, 8)}`, ownerSecret);
  log(`relay disponível: ${hostCreds.relay} | STUN: ${hostCreds.ice.stunUrls.join(",")} | TURN: ${hostCreds.ice.turn ? hostCreds.ice.turn.urls.join(",") : "nenhum"}`);
  host = new Peer("host", { mode: "host", ...baseCfg(hostCreds), relayOnly: false, localPort: MC_PORT, registryPort: REGISTRY_PORT, maxGuests: 20 });
  await host.waitFor((e) => e.status === "online", 30000, "host online");
  log("host online na sala de sinalização");

  // 2. convidados, um de cada vez (cada um tem a própria sessão e a própria instalação)
  for (let i = 1; i <= GUESTS; i++) {
    try {
      const g = await startGuest(i, i <= RELAY_GUESTS);
      guests.push(g);
      log(`${g.name} pronto em ${((Date.now() - g.startedAt) / 1000).toFixed(1)}s`);
    } catch (e) {
      check(false, `convidado ${i} não entrou: ${e.message}`);
    }
  }

  // 3. cada um sozinho: integridade, caminho usado e latência
  log("--- troca de dados, um convidado por vez");
  for (const g of guests) {
    const r = await exchange(g, PAYLOAD_MB, "um de cada vez");
    const lat = await latency(g.port).catch(() => ({ p50: -1, max: -1 }));
    g.path = g.peer.lastPath();
    g.solo = { ...r, ...lat };
    log(`  ${g.name.padEnd(20)} caminho=${String(g.path).padEnd(10)} ${r.ok ? "bytes ok" : "BYTES DIFERENTES"}  ${r.mbps.toFixed(1)} MB/s  latência p50=${lat.p50}ms max=${lat.max}ms`);
    if (g.forceRelay) check(g.path === "relay", `${g.name} devia estar pelo relay, mas o caminho foi ${g.path}`);
  }

  // 4. todos ao mesmo tempo, 3 conexões por convidado
  log("--- todos ao mesmo tempo (3 conexões por convidado)");
  const started = Date.now();
  const all = await Promise.all(guests.flatMap((g) => [0, 1, 2].map((k) => exchange(g, PAYLOAD_MB / 2, `simultâneo #${k + 1}`))));
  const okCount = all.filter((r) => r.ok).length;
  log(`  ${okCount}/${all.length} trocas corretas em ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // 5. um convidado some de repente; os outros seguem; um novo entra
  if (guests.length >= 3) {
    log("--- um convidado cai de repente");
    const victim = guests[1];
    victim.peer.kill();
    await sleep(2500);
    const others = guests.filter((g) => g !== victim);
    const after = await Promise.all(others.map((g) => exchange(g, 0.5, "depois da queda de outro")));
    log(`  demais convidados: ${after.filter((r) => r.ok).length}/${others.length} seguiram normalmente`);
    try {
      const fresh = await startGuest(GUESTS + 1, false);
      const r = await exchange(fresh, 0.5, "convidado novo");
      log(`  convidado novo entrou e trocou dados: ${r.ok ? "ok" : "FALHOU"}`);
      guests.push(fresh);
    } catch (e) { check(false, `convidado novo depois da queda: ${e.message}`); }
    guests.splice(guests.indexOf(victim), 1);
  }

  // 6. o host cai e volta
  log("--- o host cai e volta");
  const hostDownAt = Date.now();
  host.kill();
  await sleep(3000);
  const hostCreds2 = await newSession(server.shortCode, "host", `e2e-host-${randomUUID().slice(0, 8)}`, ownerSecret);
  host = new Peer("host", { mode: "host", ...baseCfg(hostCreds2), relayOnly: false, localPort: MC_PORT, registryPort: REGISTRY_PORT, maxGuests: 20 });
  await host.waitFor((e) => e.status === "online", 30000, "host online de novo").catch((e) => check(false, e.message));
  let recovered = 0;
  for (const g of guests) {
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      await sleep(3000);
      const r = await exchange({ ...g, name: g.name }, 0.25, `após o host voltar (tentativa ${attempt + 1})`).catch(() => ({ ok: false }));
      ok = r.ok;
    }
    if (ok) recovered++;
    else {
      log(`  registro interno (stderr) de ${g.name}, últimas linhas:`);
      g.peer.stderr.slice(-70).forEach((l) => log("    ", l.slice(0, 220)));
      log("  registro interno do host, últimas linhas:");
      host.stderr.slice(-60).forEach((l) => log("    ", l.slice(0, 220)));
      log(`  eventos de ${g.name} depois da queda do host:`);
      g.peer.events.filter((e) => e.at >= hostDownAt).forEach((e) => log("    ", JSON.stringify({ ...e, at: `+${((e.at - hostDownAt) / 1000).toFixed(1)}s` })));
    }
  }
  // as tentativas que falharam enquanto o host ainda voltava não são falha do produto: só vale o resultado final
  problems.splice(0, problems.length, ...problems.filter((p) => !p.includes("após o host voltar")));
  log(`  ${recovered}/${guests.length} convidados voltaram a trocar dados depois que o host voltou`);
  check(recovered === guests.length, `só ${recovered}/${guests.length} convidados se recuperaram depois da queda do host`);
}

async function cleanup() {
  for (const g of guests) await g.peer.stop();
  if (host) await host.stop();
  echo.close(); registry.close();
  if (server && ownerSecret) {
    await api("DELETE", `/api/v1/servers/${server.shortCode}`, { headers: { "X-Owner-Secret": ownerSecret } }).then(() => log("servidor de teste apagado da central"), (e) => log("não consegui apagar o servidor de teste:", e.message));
  }
}

try {
  await main();
} catch (e) {
  check(false, `erro inesperado: ${e.message}`);
} finally {
  await cleanup();
}

console.log("\n==== RESULTADO ====");
const summary = guests.map((g) => ({ convidado: g.name, caminho: g.path, "MB/s": g.solo ? Number(g.solo.mbps.toFixed(1)) : null, "lat p50 (ms)": g.solo?.p50 ?? null, "lat max (ms)": g.solo?.max ?? null }));
if (summary.length) console.table(summary);
if (problems.length) { console.log(`FALHAS (${problems.length}):`); problems.forEach((p) => console.log(" -", p)); process.exit(1); }
console.log("Nenhuma falha: todos os trocas de dados chegaram íntegras.");
process.exit(0);
