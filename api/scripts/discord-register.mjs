// Registra (ou atualiza) os comandos do bot no Discord. Rode de novo sempre que src/discord-commands.json mudar.
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node api/scripts/discord-register.mjs
// No PowerShell:
//   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; node api/scripts/discord-register.mjs
// Sem DISCORD_GUILD_ID o registro é GLOBAL (vale para todos os servidores onde o bot estiver; pode levar alguns minutos
// para aparecer). Com DISCORD_GUILD_ID, o comando fica só naquele servidor (bom para testar).
//
// Depois de registrar globalmente, limpe os comandos do servidor de teste para não aparecerem duplicados:
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node api/scripts/discord-register.mjs --clear
import { readFile } from "node:fs/promises";

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!appId || !token) {
  console.error("Defina DISCORD_APP_ID e DISCORD_BOT_TOKEN no ambiente (o token nunca vai na linha de comando).");
  process.exit(1);
}

const clear = process.argv.includes("--clear");
if (clear && !guildId) {
  console.error("--clear só funciona com DISCORD_GUILD_ID: ele remove os comandos DAQUELE servidor (os globais não são tocados).");
  process.exit(1);
}
const commands = clear ? [] : JSON.parse(await readFile(new URL("../src/discord-commands.json", import.meta.url), "utf8"));
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
console.log(clear
  ? `OK: comandos do servidor ${guildId} removidos (os globais continuam).`
  : `OK: ${registered.length} comando(s) registrado(s) ${guildId ? `no servidor ${guildId}` : "globalmente"}: ${registered.map((c) => "/" + c.name).join(", ")}`);
