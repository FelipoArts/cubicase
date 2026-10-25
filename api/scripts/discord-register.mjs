// Registra (ou atualiza) os comandos do bot no Discord. Rode de novo sempre que src/discord-commands.json mudar.
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node api/scripts/discord-register.mjs
// No PowerShell:
//   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; node api/scripts/discord-register.mjs
// Comandos globais podem levar alguns minutos para aparecer em todos os servidores. Para testar na hora em um servidor
// seu, informe também DISCORD_GUILD_ID (o comando fica só nele).
import { readFile } from "node:fs/promises";

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!appId || !token) {
  console.error("Defina DISCORD_APP_ID e DISCORD_BOT_TOKEN no ambiente (o token nunca vai na linha de comando).");
  process.exit(1);
}

const commands = JSON.parse(await readFile(new URL("../src/discord-commands.json", import.meta.url), "utf8"));
const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
const body = await res.text();
if (!res.ok) {
  console.error(`Falhou (${res.status}): ${body}`);
  process.exit(1);
}
const registered = JSON.parse(body);
console.log(`OK: ${registered.length} comando(s) registrado(s) ${guildId ? `no servidor ${guildId}` : "globalmente"}: ${registered.map((c) => "/" + c.name).join(", ")}`);
