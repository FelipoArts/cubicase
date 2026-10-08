// Gera credenciais TURN temporárias (esquema REST do coturn) para TESTAR o relay à mão,
// sem passar pelo Worker. Mesma conta que api/src/link.ts (makeTurnCredentials).
//
//   node infra/relay/make-turn-creds.mjs <TURN_SECRET> [id] [horas]
//
// Imprime o argumento -turn do spikes/link-spike (url,usuario,senha) e um JSON.
import { createHmac } from "node:crypto";

const [secret, id = "teste", hours = "1"] = process.argv.slice(2);
if (!secret) {
  console.error("uso: node infra/relay/make-turn-creds.mjs <TURN_SECRET> [id] [horas]");
  process.exit(1);
}
const username = `${Math.floor(Date.now() / 1000) + Math.round(Number(hours) * 3600)}:${id}`;
const credential = createHmac("sha1", secret).update(username).digest("base64");
const host = process.env.TURN_HOST || "turn.cubicase.net";

console.log(JSON.stringify({ urls: [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`, `turns:${host}:443?transport=tcp`], username, credential }, null, 2));
console.log("\nPara o spike (relay forçado):");
console.log(`  -relay -turn "turn:${host}:3478,${username},${credential}"`);
