// ============================================================
// Bot do Discord (Interactions via HTTP)
// ============================================================
// Um único bot oficial "Cubicase". O Discord chama POST /api/v1/discord/interactions quando alguém usa um /comando;
// respondemos na hora (o Worker não mantém conexão com o Discord). Este arquivo guarda a parte sem rota: conferir a
// assinatura, vincular um Discord a um servidor e responder aos comandos.
//
// Vinculação em duas etapas (ninguém consegue se passar pelo dono):
//   1. o dono do servidor Cubicase (segredo do servidor + conta) gera um código de uso único, válido por 10 min;
//   2. um admin do Discord (permissão Gerenciar Servidor) roda /cubicase vincular <código>.
//
// Dados no KV (escrita só quando a pessoa configura, nunca por evento):
//   dlcode:<CÓDIGO>     -> { shortCode, userId }            (10 min)
//   dlcode-sc:<sc>      -> CÓDIGO                           (para invalidar o código anterior)
//   dserver:<sc>        -> { userId, guilds: [{ guildId, linkedAt }] }
//   dguild:<guildId>    -> { userId, servers: [sc] }
//
// Plano grátis: 1 Discord por servidor e 1 servidor por Discord. Cubicase Plus: até 10 Discords por servidor e 25
// servidores por Discord. O limite só vale na hora de vincular; o que já está vinculado nunca é apagado por isso.
// ============================================================

import { userHasActiveSubscription, type SupabaseEnv } from './supabase';
import { TEXTS, langOf, statusEmbed, describeSendFailure, type Lang, type ServerStatusView } from './discord-text';

import type { DiscordApi } from './discord-api';
import {
  deleteConfig, getConfig, setStatusChannel, setAlertsChannel, postInvite, disableChannel, setEvent, setControl,
  type ChannelKind, type EventKind, type GuildConfig,
} from './discord-sync';
import { WHITELIST_NAME, type ControlAction, type ControlReason } from './discord-control';

export type { ServerStatusView } from './discord-text';

export interface DiscordEnv extends SupabaseEnv {
  CUBEFORGE_REGISTRY: KVNamespace;
  /** Chave pública do app (portal do Discord > General Information). Sem ela o bot fica desligado. */
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APP_ID?: string;
  DISCORD_BOT_TOKEN?: string;
}

export const LINK_CODE_TTL_SECONDS = 600;
/** Quanto tempo as ligações extras continuam funcionando depois que o Plus termina. */
export const LIMIT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const FREE_GUILDS_PER_SERVER = 1;
export const FREE_SERVERS_PER_GUILD = 1;
export const PLUS_GUILDS_PER_SERVER = 10;
export const PLUS_SERVERS_PER_GUILD = 25;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const GUILD_ID_RE = /^\d{5,25}$/;
const SHORT_CODE_RE = /^[A-Z0-9]{4,12}$/;

// Permissões do bot ao ser adicionado: ver canais, enviar mensagens, incorporar links, ler histórico e fixar mensagens.
const PERMISSION_BITS = [10n, 11n, 14n, 16n, 51n];
export const INSTALL_PERMISSIONS = PERMISSION_BITS.reduce((acc, bit) => acc | (1n << bit), 0n).toString();

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
const EPHEMERAL = 64;

// ---------------- assinatura ----------------

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** O Discord assina `timestamp + corpo` com Ed25519; sem assinatura válida a requisição é descartada. */
export async function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): Promise<boolean> {
  const key = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (!key || !sig || key.length !== 32 || sig.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sig, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export function discordInstallUrl(env: DiscordEnv): string | null {
  if (!env.DISCORD_APP_ID || !/^\d+$/.test(env.DISCORD_APP_ID)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APP_ID}&scope=${encodeURIComponent('bot applications.commands')}&permissions=${INSTALL_PERMISSIONS}`;
}

export function discordConfigured(env: DiscordEnv): boolean {
  return !!env.DISCORD_PUBLIC_KEY && !!env.DISCORD_APP_ID;
}

// ---------------- vinculação ----------------

interface CodeRecord { shortCode: string; userId: string }
interface ServerLinks {
  userId: string;
  guilds: { guildId: string; linkedAt: string }[];
  /** Desde quando o dono está sem Plus com mais ligações do que o plano grátis permite (começa o prazo de 7 dias). */
  limitedSince?: string;
  /** O prazo acabou: só a ligação mais antiga continua ativa (nada foi apagado). */
  limited?: boolean;
}
interface GuildLinks { userId: string; servers: string[] }

const readJson = async <T>(env: DiscordEnv, key: string): Promise<T | null> => {
  const raw = await env.CUBEFORGE_REGISTRY.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};
const writeJson = (env: DiscordEnv, key: string, value: unknown) => env.CUBEFORGE_REGISTRY.put(key, JSON.stringify(value));

/** Tira traços, espaços e caixa: o admin pode digitar "abcd-2345". */
export function normalizeLinkCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newLinkCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_CHARS[b % CODE_CHARS.length];
  return out;
}

/** Gera o código de vinculação do servidor; o anterior (se houver) deixa de valer. */
export async function createLinkCode(env: DiscordEnv, shortCode: string, userId: string): Promise<{ code: string; expiresInSeconds: number }> {
  const previous = await env.CUBEFORGE_REGISTRY.get(`dlcode-sc:${shortCode}`);
  if (previous) await env.CUBEFORGE_REGISTRY.delete(`dlcode:${previous}`);
  const code = newLinkCode();
  const record: CodeRecord = { shortCode, userId };
  await env.CUBEFORGE_REGISTRY.put(`dlcode:${code}`, JSON.stringify(record), { expirationTtl: LINK_CODE_TTL_SECONDS });
  await env.CUBEFORGE_REGISTRY.put(`dlcode-sc:${shortCode}`, code, { expirationTtl: LINK_CODE_TTL_SECONDS });
  return { code, expiresInSeconds: LINK_CODE_TTL_SECONDS };
}

export type RedeemResult =
  | { ok: true; shortCode: string }
  | { ok: false; reason: 'invalid_code' | 'guild_other_account' | 'already_linked' | 'free_limit_server' | 'free_limit_guild' | 'plus_limit' };

/** Consome o código e grava a ligação entre `guildId` e o servidor. */
export async function redeemLinkCode(env: DiscordEnv, rawCode: string, guildId: string): Promise<RedeemResult> {
  const code = normalizeLinkCode(rawCode);
  if (code.length !== CODE_LENGTH || !GUILD_ID_RE.test(guildId)) return { ok: false, reason: 'invalid_code' };
  const record = await readJson<CodeRecord>(env, `dlcode:${code}`);
  if (!record || !SHORT_CODE_RE.test(record.shortCode)) return { ok: false, reason: 'invalid_code' };
  // Uso único: apaga antes de qualquer outra coisa, assim dois admins digitando juntos não vinculam duas vezes.
  await env.CUBEFORGE_REGISTRY.delete(`dlcode:${code}`);
  await env.CUBEFORGE_REGISTRY.delete(`dlcode-sc:${record.shortCode}`);

  const { shortCode, userId } = record;
  let server = await readJson<ServerLinks>(env, `dserver:${shortCode}`);
  // O servidor mudou de dono (outra conta passou a gerenciá-lo): as ligações da conta anterior não valem mais.
  if (server && server.userId !== userId) {
    for (const g of server.guilds) { await removeServerFromGuild(env, g.guildId, shortCode); await deleteConfig(env, shortCode, g.guildId); }
    server = null;
  }
  const guild = await readJson<GuildLinks>(env, `dguild:${guildId}`);
  if (guild && guild.userId !== userId && guild.servers.length > 0) return { ok: false, reason: 'guild_other_account' };

  const guilds = server?.guilds ?? [];
  const servers = guild && guild.userId === userId ? guild.servers : [];
  if (guilds.some((g) => g.guildId === guildId)) return { ok: false, reason: 'already_linked' };

  const plus = await userHasActiveSubscription(env, userId);
  if (guilds.length >= (plus ? PLUS_GUILDS_PER_SERVER : FREE_GUILDS_PER_SERVER)) return { ok: false, reason: plus ? 'plus_limit' : 'free_limit_server' };
  if (servers.length >= (plus ? PLUS_SERVERS_PER_GUILD : FREE_SERVERS_PER_GUILD)) return { ok: false, reason: plus ? 'plus_limit' : 'free_limit_guild' };

  await writeJson(env, `dserver:${shortCode}`, { userId, guilds: [...guilds, { guildId, linkedAt: new Date().toISOString() }] } satisfies ServerLinks);
  await writeJson(env, `dguild:${guildId}`, { userId, servers: [...servers, shortCode] } satisfies GuildLinks);
  return { ok: true, shortCode };
}

async function removeServerFromGuild(env: DiscordEnv, guildId: string, shortCode: string): Promise<void> {
  const guild = await readJson<GuildLinks>(env, `dguild:${guildId}`);
  if (!guild) return;
  const servers = guild.servers.filter((s) => s !== shortCode);
  if (servers.length === 0) await env.CUBEFORGE_REGISTRY.delete(`dguild:${guildId}`);
  else await writeJson(env, `dguild:${guildId}`, { ...guild, servers } satisfies GuildLinks);
}

export async function listServerGuilds(env: DiscordEnv, shortCode: string): Promise<{ guildId: string; linkedAt: string }[]> {
  return (await readJson<ServerLinks>(env, `dserver:${shortCode}`))?.guilds ?? [];
}

export async function listGuildServers(env: DiscordEnv, guildId: string): Promise<string[]> {
  return (await readJson<GuildLinks>(env, `dguild:${guildId}`))?.servers ?? [];
}

/** Desfaz a ligação nos dois sentidos. Devolve false se ela não existia. */
export async function unlinkGuild(env: DiscordEnv, shortCode: string, guildId: string): Promise<boolean> {
  const server = await readJson<ServerLinks>(env, `dserver:${shortCode}`);
  const had = !!server?.guilds.some((g) => g.guildId === guildId);
  if (server && had) {
    const guilds = server.guilds.filter((g) => g.guildId !== guildId);
    if (guilds.length === 0) await env.CUBEFORGE_REGISTRY.delete(`dserver:${shortCode}`);
    else await writeJson(env, `dserver:${shortCode}`, { ...server, guilds } satisfies ServerLinks);
  }
  await removeServerFromGuild(env, guildId, shortCode);
  await deleteConfig(env, shortCode, guildId);
  return had;
}

/** Para o fim de uma ação demorada (backup) editar de volta a resposta do comando, que o Discord deixa mudar por 15 min. */
export interface ControlNotify { appId: string; token: string; lang: Lang; user: string }

export type LimitEvent =
  | { event: 'none' }
  | { event: 'grace'; endsAt: number; guildIds: string[] }
  | { event: 'limited'; guildIds: string[] }
  | { event: 'restored'; guildIds: string[] };

const exceedsFreePlan = async (env: DiscordEnv, server: ServerLinks): Promise<boolean> => {
  if (server.guilds.length > FREE_GUILDS_PER_SERVER) return true;
  for (const g of server.guilds) {
    const guild = await readJson<GuildLinks>(env, `dguild:${g.guildId}`);
    if ((guild?.servers.length ?? 0) > FREE_SERVERS_PER_GUILD) return true;
  }
  return false;
};

/**
 * Sem o Plus, só vale o que o plano grátis permite: o Discord mais antigo do servidor e, em cada Discord, o servidor
 * mais antigo. O que passa disso continua guardado, mas pausa depois de 7 dias. Chamada pela rotina agendada: devolve
 * o que mudou para quem chama avisar. Só consulta o Plus quando há ligações demais (ou um prazo em andamento).
 */
export async function enforcePlanLimits(env: DiscordEnv, shortCode: string, isPlus: (userId: string) => Promise<boolean>, now = Date.now()): Promise<LimitEvent> {
  const server = await readJson<ServerLinks>(env, `dserver:${shortCode}`);
  if (!server) return { event: 'none' };
  const guildIds = server.guilds.map((g) => g.guildId);
  const excess = await exceedsFreePlan(env, server);
  const tracking = !!server.limitedSince || !!server.limited;
  if (!excess && !tracking) return { event: 'none' };

  const plus = await isPlus(server.userId);
  if (plus || !excess) {
    if (!tracking) return { event: 'none' };
    const { limitedSince: _s, limited: _l, ...rest } = server;
    await writeJson(env, `dserver:${shortCode}`, rest satisfies ServerLinks);
    return plus ? { event: 'restored', guildIds } : { event: 'none' };
  }
  if (!server.limitedSince) {
    await writeJson(env, `dserver:${shortCode}`, { ...server, limitedSince: new Date(now).toISOString() } satisfies ServerLinks);
    return { event: 'grace', endsAt: now + LIMIT_GRACE_MS, guildIds };
  }
  if (!server.limited && now - Date.parse(server.limitedSince) >= LIMIT_GRACE_MS) {
    await writeJson(env, `dserver:${shortCode}`, { ...server, limited: true } satisfies ServerLinks);
    return { event: 'limited', guildIds };
  }
  return { event: 'none' };
}

/** Discords em que este servidor está ativo agora (todos, a não ser que o prazo do plano grátis tenha acabado). */
export async function activeGuilds(env: DiscordEnv, shortCode: string): Promise<string[]> {
  const server = await readJson<ServerLinks>(env, `dserver:${shortCode}`);
  if (!server) return [];
  if (!server.limited) return server.guilds.map((g) => g.guildId);
  const first = server.guilds[0]?.guildId;
  if (!first) return [];
  const guild = await readJson<GuildLinks>(env, `dguild:${first}`);
  return guild?.servers[0] === shortCode ? [first] : [];
}

/**
 * Quem tem o segredo do servidor é o dono de verdade. Se a conta que está gerenciando agora for outra (trocou de
 * conta no app), as ligações existentes passam para ela, com os canais e avisos como estavam: é nela que o Plus é
 * conferido. Só mexe no que pertencia à conta anterior.
 */
export async function adoptServerOwner(env: DiscordEnv, shortCode: string, userId: string): Promise<void> {
  const server = await readJson<ServerLinks>(env, `dserver:${shortCode}`);
  if (!server || server.userId === userId) return;
  await writeJson(env, `dserver:${shortCode}`, { ...server, userId } satisfies ServerLinks);
  for (const g of server.guilds) {
    const guild = await readJson<GuildLinks>(env, `dguild:${g.guildId}`);
    if (guild && guild.userId === server.userId) await writeJson(env, `dguild:${g.guildId}`, { ...guild, userId } satisfies GuildLinks);
  }
}

/** Apaga todas as ligações de um servidor (usado quando o servidor é excluído da central). */
export async function unlinkAllGuilds(env: DiscordEnv, shortCode: string): Promise<void> {
  for (const g of await listServerGuilds(env, shortCode)) await unlinkGuild(env, shortCode, g.guildId);
}

// ---------------- interações ----------------

export interface InteractionDeps {
  /** Lê o nome e o status de um servidor (null se ele não existe mais). */
  getStatus(shortCode: string): Promise<ServerStatusView | null>;
  /** Cliente do Discord para publicar mensagens (null = bot sem token: os comandos de canal avisam que não dá). */
  api: DiscordApi | null;
  /** Manda uma ação de controle ao app do host (ligar, desligar...). Ausente = controle indisponível. */
  control?(shortCode: string, action: ControlAction, by: string, notify?: ControlNotify): Promise<{ ok: true } | { ok: false; reason: ControlReason }>;
  /** Se a conta dona tem o Plus (por padrão consulta o Supabase; os testes trocam). */
  isPlus?(userId: string): Promise<boolean>;
}

const reply = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });
const embedReply = (embed: Record<string, unknown>) => ({ type: 4, data: { embeds: [embed], allowed_mentions: { parse: [] } } });

function canManageGuild(interaction: any): boolean {
  try {
    const perms = BigInt(interaction?.member?.permissions ?? '0');
    return (perms & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

// Subcomandos e opções existem em português e inglês (o Discord manda o nome que a pessoa viu, conforme o idioma dela).
type Sub = 'backup' | 'diagnose' | 'link' | 'status' | 'unlink' | 'help' | 'channel' | 'alerts' | 'disable' | 'invite' | 'start' | 'stop' | 'restart' | 'whitelist' | 'console' | 'operator';
const SUBCOMMANDS: Record<string, Sub> = {
  diagnostico: 'diagnose', diagnostics: 'diagnose', vincular: 'link', link: 'link', status: 'status', desvincular: 'unlink', unlink: 'unlink', ajuda: 'help', help: 'help',
  canal: 'channel', channel: 'channel', avisos: 'alerts', alerts: 'alerts', desativar: 'disable', disable: 'disable', convite: 'invite', invite: 'invite',
  backup: 'backup', ligar: 'start', start: 'start', desligar: 'stop', stop: 'stop', reiniciar: 'restart', restart: 'restart',
  whitelist: 'whitelist', console: 'console', operador: 'operator', operator: 'operator',
};
const CONTROL_SUBS = new Set<Sub>(['start', 'stop', 'restart', 'backup', 'whitelist', 'console']);
const SNOWFLAKE = /^\d{5,25}$/;
const CONTROL_COOLDOWN_MS = 8000;
const CHANNEL_KINDS = new Set<string>(['status', 'alerts', 'invite']);
const EVENT_KINDS_SET = new Set<string>(['joins', 'power', 'offline']);
const optionBool = (options: any[] | undefined, ...names: string[]): boolean | null => {
  const found = options?.find((o) => names.includes(o?.name));
  return typeof found?.value === 'boolean' ? found.value : null;
};
const optionValue = (options: any[] | undefined, ...names: string[]): string | null => {
  const found = options?.find((o) => names.includes(o?.name));
  return typeof found?.value === 'string' ? found.value : null;
};

/** Confere, de dentro do Worker, o que o bot realmente enxerga: de quem é o token, se está no servidor e se vê o canal. */
async function diagnose(env: DiscordEnv, api: DiscordApi | null, guildId: string, channelId: string, lang: Lang): Promise<string> {
  const pt = lang === 'pt';
  if (!api) return pt ? '❌ O Worker não tem o segredo DISCORD_BOT_TOKEN.' : '❌ The Worker has no DISCORD_BOT_TOKEN secret.';
  const lines: string[] = [];
  const me = await api.me();
  if (!me.ok) {
    lines.push(pt ? `❌ O Discord não aceitou o token do bot (erro ${me.status}). Grave de novo o segredo DISCORD_BOT_TOKEN.` : `❌ Discord rejected the bot token (error ${me.status}). Set the DISCORD_BOT_TOKEN secret again.`);
    return lines.join('\n');
  }
  const sameApp = !env.DISCORD_APP_ID || me.data.id === env.DISCORD_APP_ID;
  lines.push(sameApp
    ? (pt ? `✅ Token do bot: **${me.data.username}** (${me.data.id}), o mesmo aplicativo configurado.` : `✅ Bot token: **${me.data.username}** (${me.data.id}), same as the configured app.`)
    : (pt ? `❌ O token é do bot **${me.data.username}** (${me.data.id}), mas o DISCORD_APP_ID é ${env.DISCORD_APP_ID}. O token e o aplicativo são de bots diferentes: grave o token do aplicativo certo.` : `❌ The token belongs to **${me.data.username}** (${me.data.id}) but DISCORD_APP_ID is ${env.DISCORD_APP_ID}. Token and app are from different bots: set the token of the right app.`));
  const guild = await api.guild(guildId);
  lines.push(guild.ok
    ? (pt ? '✅ O bot está neste servidor.' : '✅ The bot is in this server.')
    : (pt ? `❌ Com esse token, o bot não está neste servidor (erro ${guild.status}${guild.code ? `/${guild.code}` : ''}).` : `❌ With this token the bot is not in this server (error ${guild.status}${guild.code ? `/${guild.code}` : ''}).`));
  if (GUILD_ID_RE.test(channelId)) {
    const channel = await api.channel(channelId);
    lines.push(channel.ok
      ? (pt ? `✅ O bot enxerga este canal (<#${channelId}>).` : `✅ The bot can see this channel (<#${channelId}>).`)
      : (pt ? `❌ O bot não enxerga <#${channelId}> (erro ${channel.status}${channel.code ? `/${channel.code}` : ''}). Revise as permissões do canal e da categoria.` : `❌ The bot can't see <#${channelId}> (error ${channel.status}${channel.code ? `/${channel.code}` : ''}). Review the channel and category permissions.`));
  }
  return lines.join('\n');
}

/** Quem pode controlar: quem gerencia o Discord, ou quem tem o cargo de Operador definido para este servidor. */
function canOperate(interaction: any, cfg: GuildConfig | null): boolean {
  if (canManageGuild(interaction)) return true;
  const role = cfg?.control?.operatorRoleId;
  return !!role && Array.isArray(interaction?.member?.roles) && interaction.member.roles.includes(role);
}

const displayName = (interaction: any): string => {
  const user = interaction?.member?.user ?? interaction?.user;
  const raw = String(interaction?.member?.nick ?? user?.global_name ?? user?.username ?? '?');
  return raw.replace(/[\u0000-\u001f\u007f*_~`|>@#:\[\]()]/g, '').trim().slice(0, 32) || '?';
};

/** Ligar, desligar, reiniciar, whitelist e console: só com o Plus do host, para quem pode, sem repetir em sequência. */
async function runControl(env: DiscordEnv, interaction: any, deps: InteractionDeps, shortCode: string, guildId: string, sub: Sub, options: any[] | undefined, lang: Lang): Promise<unknown> {
  const t = TEXTS[lang];
  const cfg = await getConfig(env, shortCode, guildId);
  if (!canOperate(interaction, cfg)) return reply(t.controlNeedOperator);
  if (!deps.control) return reply(t.notConfigured);

  let action: ControlAction;
  let audit: string;
  if (sub === 'whitelist') {
    const op = optionValue(options, 'acao', 'action');
    const player = (optionValue(options, 'jogador', 'player') ?? '').trim();
    if ((op !== 'add' && op !== 'remove') || !WHITELIST_NAME.test(player)) return reply(t.reasonInvalid);
    action = { kind: 'whitelist', op, player };
    audit = `whitelist ${op} ${player}`;
  } else if (sub === 'console') {
    if (!cfg?.control?.console) return reply(t.consoleDisabled);
    const command = (optionValue(options, 'comando', 'command') ?? '').trim().replace(/^\/+/, '');
    if (!command) return reply(t.reasonInvalid);
    action = { kind: 'console', command };
    audit = `console ${command.replace(/`/g, "'").slice(0, 100)}`;
  } else {
    action = { kind: sub as 'start' | 'stop' | 'restart' | 'backup' };
    audit = sub;
  }

  // Intervalo mínimo entre comandos de controle de uma mesma pessoa (o KV só guarda por 60 s no mínimo; vale o carimbo).
  const userId = String(interaction?.member?.user?.id ?? '');
  if (SNOWFLAKE.test(userId)) {
    const key = `dcool:${guildId}:${userId}`;
    const last = Number(await env.CUBEFORGE_REGISTRY.get(key));
    if (Number.isFinite(last) && Date.now() - last < CONTROL_COOLDOWN_MS) return reply(t.controlCooldown);
    await env.CUBEFORGE_REGISTRY.put(key, String(Date.now()), { expirationTtl: 60 });
  }

  const owner = await readJson<ServerLinks>(env, `dserver:${shortCode}`);
  if (owner?.limited && !(await activeGuilds(env, shortCode)).includes(guildId)) return reply(t.linkPaused);
  if (!owner || !(await (deps.isPlus ?? ((u) => userHasActiveSubscription(env, u)))(owner.userId))) return reply(t.controlPlusOnly);

  const user = displayName(interaction);
  const notify: ControlNotify | undefined = action.kind === 'backup' && env.DISCORD_APP_ID && typeof interaction.token === 'string'
    ? { appId: env.DISCORD_APP_ID, token: interaction.token, lang, user }
    : undefined;
  const result = await deps.control(shortCode, action, user, notify);
  if (!result.ok) {
    const msg = {
      agent_offline: t.reasonAgentOffline, no_device: t.reasonNoDevice, already_running: t.reasonAlreadyRunning, other_running: t.reasonOtherRunning,
      not_running: t.reasonNotRunning, unknown_state: t.reasonUnknown, invalid: t.reasonInvalid, server_gone: t.reasonGone,
    }[result.reason];
    return reply(msg);
  }

  // Registro de quem fez o quê no canal de avisos (se houver), para ninguém mexer no servidor sem deixar rastro.
  if (cfg?.alerts && !cfg.broken?.alerts && deps.api) {
    await deps.api.send(cfg.alerts.channelId, { content: t.auditLine(user, audit), allowed_mentions: { parse: [] } });
  }
  const done = {
    start: t.ctlStart(user), stop: t.ctlStop(user), restart: t.ctlRestart(user), backup: t.ctlBackup(user),
    whitelist: action.kind === 'whitelist' ? t.ctlWhitelist(user, action.op, action.player) : '', console: t.ctlConsole(user),
  }[sub as 'start' | 'stop' | 'restart' | 'backup' | 'whitelist' | 'console'];
  return reply(done, { flags: 0 });
}

async function pickServer(env: DiscordEnv, guildId: string, wanted: string | null, lang: Lang): Promise<{ shortCode: string } | { error: string }> {
  const t = TEXTS[lang];
  const servers = await listGuildServers(env, guildId);
  if (servers.length === 0) return { error: t.noServers };
  if (wanted) {
    const code = wanted.toUpperCase();
    return servers.includes(code) ? { shortCode: code } : { error: t.notLinked };
  }
  return servers.length === 1 ? { shortCode: servers[0] } : { error: t.pickServer };
}

async function handleAutocomplete(env: DiscordEnv, interaction: any, deps: InteractionDeps) {
  const guildId = String(interaction.guild_id ?? '');
  const sub = interaction.data?.options?.[0];
  const typed = String(sub?.options?.find((o: any) => o?.focused)?.value ?? '').toLowerCase();
  const choices: { name: string; value: string }[] = [];
  if (GUILD_ID_RE.test(guildId)) {
    for (const sc of await listGuildServers(env, guildId)) {
      const view = await deps.getStatus(sc);
      const label = `${view?.name ?? sc} (${sc})`;
      if (!typed || label.toLowerCase().includes(typed)) choices.push({ name: label.slice(0, 100), value: sc });
      if (choices.length >= 25) break;
    }
  }
  return { type: 8, data: { choices } };
}

export async function handleInteraction(env: DiscordEnv, interaction: any, deps: InteractionDeps): Promise<unknown> {
  if (interaction?.type === 1) return { type: 1 }; // PING
  const lang = langOf(interaction);
  const t = TEXTS[lang];
  if (interaction?.type === 4) return handleAutocomplete(env, interaction, deps);
  if (interaction?.type !== 2 || interaction?.data?.name !== 'cubicase') return reply(t.unknown);

  const guildId = String(interaction.guild_id ?? '');
  if (!GUILD_ID_RE.test(guildId)) return reply(t.onlyInGuild);

  const subRaw = interaction.data?.options?.[0];
  const sub = SUBCOMMANDS[String(subRaw?.name ?? '')];
  if (!sub) return reply(t.unknown);

  if (sub === 'help') return embedReply({ title: t.helpTitle, description: t.help, color: 0x6366f1 });

  if (sub === 'diagnose') {
    if (!canManageGuild(interaction)) return reply(t.needManage);
    return reply(await diagnose(env, deps.api, guildId, String(interaction.channel_id ?? ''), lang));
  }

  if (sub === 'link') {
    if (!canManageGuild(interaction)) return reply(t.needManage);
    const result = await redeemLinkCode(env, optionValue(subRaw.options, 'codigo', 'code') ?? '', guildId);
    if (!result.ok) {
      const msg = {
        invalid_code: t.linkInvalid, guild_other_account: t.linkOtherAccount, already_linked: t.linkAlready,
        free_limit_server: t.linkFreeServer, free_limit_guild: t.linkFreeGuild, plus_limit: t.linkPlusLimit,
      }[result.reason];
      return reply(msg);
    }
    const view = await deps.getStatus(result.shortCode);
    return reply(t.linkDone(view?.name ?? result.shortCode), { flags: 0 });
  }

  const picked = await pickServer(env, guildId, optionValue(subRaw.options, 'servidor', 'server'), lang);
  if ('error' in picked) return reply(picked.error);

  if (sub === 'status') {
    const view = await deps.getStatus(picked.shortCode);
    if (!view) return reply(t.serverGone);
    return embedReply(statusEmbed(lang, picked.shortCode, view));
  }

  if (CONTROL_SUBS.has(sub)) return runControl(env, interaction, deps, picked.shortCode, guildId, sub, subRaw.options, lang);

  if (!canManageGuild(interaction)) return reply(t.needManage);
  const view = await deps.getStatus(picked.shortCode);

  if (sub === 'unlink') {
    await unlinkGuild(env, picked.shortCode, guildId);
    return reply(t.unlinked(view?.name ?? picked.shortCode), { flags: 0 });
  }

  // As mensagens automáticas saem no idioma do Discord (e não no de quem configurou).
  const guildLang = langOf({ locale: interaction.guild_locale ?? interaction.locale });

  if (sub === 'alerts') {
    const event = optionValue(subRaw.options, 'evento', 'event');
    const on = optionBool(subRaw.options, 'ligado', 'enabled');
    if (!event || !EVENT_KINDS_SET.has(event) || on === null) return reply(t.unknown);
    const cfg = await getConfig(env, picked.shortCode, guildId);
    if (!cfg?.alerts) return reply(t.alertsNeedChannel);
    await setEvent(env, picked.shortCode, guildId, event as EventKind, on);
    const label = { joins: t.eventJoins, power: t.eventPower, offline: t.eventOffline }[event as EventKind];
    return reply(t.eventSet(label, on), { flags: 0 });
  }

  if (sub === 'operator') {
    const role = optionValue(subRaw.options, 'cargo', 'role');
    const consoleOn = optionBool(subRaw.options, 'console');
    const current = await getConfig(env, picked.shortCode, guildId);
    if (role === null && consoleOn === null) return reply(t.operatorShow(current?.control?.operatorRoleId ?? null, !!current?.control?.console));
    if (role !== null && !SNOWFLAKE.test(role)) return reply(t.reasonInvalid);
    const next = await setControl(env, picked.shortCode, guildId, guildLang, { operatorRoleId: role ?? undefined, console: consoleOn ?? undefined });
    return reply(t.operatorSaved(next.control?.operatorRoleId ?? null, !!next.control?.console), { flags: 0 });
  }

  if (sub === 'disable') {
    const kind = optionValue(subRaw.options, 'tipo', 'type');
    if (kind === 'operator') {
      await setControl(env, picked.shortCode, guildId, guildLang, { operatorRoleId: null });
      return reply(t.disabledDone(t.kindOperator), { flags: 0 });
    }
    if (!kind || !CHANNEL_KINDS.has(kind)) return reply(t.unknown);
    const done = await disableChannel(env, picked.shortCode, guildId, kind as ChannelKind);
    const what = { status: t.kindStatus, alerts: t.kindAlerts, invite: t.kindInvite }[kind as ChannelKind];
    return reply(done ? t.disabledDone(what) : t.nothingToDisable, { flags: done ? 0 : EPHEMERAL });
  }

  // channel / invite: publicam mensagens, então precisam do Discord e do servidor ainda existindo na central.
  if (!view) return reply(t.serverGone);
  if (!deps.api) return reply(t.notConfigured);
  const kind: ChannelKind | null = sub === 'invite' ? 'invite' : (optionValue(subRaw.options, 'tipo', 'type') as ChannelKind | null);
  if (!kind || !CHANNEL_KINDS.has(kind)) return reply(t.unknown);
  const channelId = sub === 'invite' ? String(interaction.channel_id ?? '') : (optionValue(subRaw.options, 'canal', 'channel') ?? '');
  if (!GUILD_ID_RE.test(channelId)) return reply(t.channelNotText);
  const channelType = interaction.data?.resolved?.channels?.[channelId]?.type;
  if (sub === 'channel' && channelType !== undefined && channelType !== 0 && channelType !== 5) return reply(t.channelNotText);

  const run = { status: setStatusChannel, alerts: setAlertsChannel, invite: postInvite }[kind];
  const result = await run(env, deps.api, picked.shortCode, guildId, channelId, guildLang, view);
  if (!result.ok) return reply(describeSendFailure(guildLang, channelId, result.failure));
  const done = { status: t.channelStatusDone, alerts: t.channelAlertsDone, invite: t.channelInviteDone }[kind](channelId);
  return reply(done, { flags: 0 });
}
