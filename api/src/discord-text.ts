// ============================================================
// Textos e mensagens do bot do Discord (português e inglês)
// ============================================================
// O idioma de cada resposta vem do `locale` de quem usou o comando; as mensagens automáticas (status, avisos, convite)
// usam o idioma guardado quando o canal foi configurado.
// ============================================================

export interface ServerStatusView {
  name: string;
  version: string;
  slug?: string | null;
  serverType?: string;
  minecraftStatus: string | null;
  currentPlayers: number;
  maxPlayers: number;
}

// ---------------- textos ----------------

export type Lang = 'pt' | 'en';
export const TEXTS = {
  pt: {
    notConfigured: 'O bot ainda não está configurado.',
    onlyInGuild: 'Use este comando dentro de um servidor do Discord.',
    needManage: 'Só quem tem a permissão **Gerenciar Servidor** pode fazer isso.',
    linkInvalid: 'Código inválido ou expirado. No Cubicase, abra o servidor, vá em **Discord** e gere um novo código (vale por 10 minutos).',
    linkOtherAccount: 'Este Discord já está ligado a servidores de **outra conta** do Cubicase. Peça para a pessoa desvincular antes.',
    linkAlready: 'Este Discord já está ligado a esse servidor.',
    linkFreeServer: 'Esse servidor já está ligado a outro Discord. Ligar a mais de um Discord faz parte do **Cubicase Plus**.',
    linkFreeGuild: 'Este Discord já está ligado a um servidor. Ligar mais de um servidor ao mesmo Discord faz parte do **Cubicase Plus**.',
    linkPlusLimit: 'Você chegou ao limite de ligações para esse servidor ou Discord.',
    linkDone: (name: string) => `✅ Pronto! Este Discord agora está ligado a **${name}**. Use \`/cubicase status\` para ver como ele está.`,
    noServers: 'Este Discord ainda não está ligado a nenhum servidor. Gere um código no Cubicase e use `/cubicase vincular`.',
    pickServer: 'Este Discord tem mais de um servidor ligado. Escolha qual no campo **servidor**.',
    notLinked: 'Esse servidor não está ligado a este Discord.',
    serverGone: 'Esse servidor não existe mais no Cubicase.',
    unlinked: (name: string) => `Pronto, **${name}** não está mais ligado a este Discord.`,
    statusOnline: '🟢 Ligado', statusStarting: '🟡 Iniciando', statusStopping: '🟠 Desligando', statusSleeping: '😴 Em espera (acorda quando alguém entrar)',
    statusOffline: '🔴 Desligado',
    fieldPlayers: 'Jogadores', fieldVersion: 'Versão', fieldJoin: 'Como entrar',
    joinWithSlug: (url: string) => `Abra ${url} ou use o código`,
    footer: 'Cubicase',
    helpTitle: 'Cubicase no Discord',
    help: 'Este bot mostra o estado do seu servidor de Minecraft do Cubicase.\n\n**Para configurar** (quem administra o Discord):\n1. No Cubicase, abra o servidor e vá em **Discord**.\n2. Gere o código e rode `/cubicase vincular` aqui com ele.\n\n**Comandos**\n`/cubicase status` — se está ligado e quem joga\n`/cubicase canal` — escolhe onde ficam o status, os avisos e o "como entrar"\n`/cubicase avisos` — liga ou desliga cada tipo de aviso\n`/cubicase desativar` — desliga status, avisos ou "como entrar"\n`/cubicase convite` — publica de novo o "como entrar"\n`/cubicase ligar` · `desligar` · `reiniciar` · `backup` · `whitelist` · `console` — controlam o servidor (Cubicase Plus)\n`/cubicase operador` — define quem mais pode controlar\n`/cubicase desvincular` — remove a ligação\n`/cubicase ajuda` — esta mensagem',
    unknown: 'Não conheço esse comando.',
    controlPlusOnly: 'Controlar o servidor pelo Discord faz parte do **Cubicase Plus**. O Plus é conferido na conta que ligou este servidor ao Discord: se você trocou de conta, abra a aba **Discord** do servidor no app, logado na conta com Plus, e clique em **Gerar código** (isso passa a conta, sem perder a configuração).',
    controlNeedOperator: 'Só quem gerencia o Discord ou tem o cargo de **Operador** pode controlar o servidor. Quem gerencia define o cargo com `/cubicase operador`.',
    controlCooldown: 'Calma, espere alguns segundos antes de usar outro comando de controle.',
    consoleDisabled: 'O console pelo Discord está desligado. Quem gerencia o Discord liga com `/cubicase operador console:verdadeiro`.',
    ctlStart: (user: string) => `⏳ **${user}** pediu para ligar o servidor. O host está iniciando…`,
    ctlStop: (user: string) => `⏳ **${user}** pediu para desligar o servidor.`,
    ctlRestart: (user: string) => `⏳ **${user}** pediu para reiniciar o servidor.`,
    ctlBackup: (user: string) => `💾 **${user}** pediu um backup do mundo. O host está salvando… (pode levar alguns minutos; vou avisar aqui quando terminar)`,
    backupDone: (user: string, file: string, size: string) => `✅ Backup do mundo concluído (pedido por **${user}**): \`${file}\`, ${size}.`,
    backupFailed: (user: string, error: string) => `❌ O backup pedido por **${user}** falhou: ${error}`,
    ctlWhitelist: (user: string, op: string, player: string) => `✅ **${user}** ${op === 'add' ? 'adicionou' : 'removeu'} **${player}** ${op === 'add' ? 'à' : 'da'} whitelist.`,
    ctlConsole: (user: string) => `✅ **${user}** enviou um comando ao console.`,
    reasonAgentOffline: 'O Cubicase do host está fechado ou sem internet. Peça para abrirem o app.',
    reasonNoDevice: 'O painel remoto ainda não foi pareado no computador do host (abra o Cubicase com a conta Plus ao menos uma vez).',
    reasonAlreadyRunning: 'O servidor já está ligado.',
    reasonOtherRunning: 'O host está com **outro** servidor ligado agora.',
    reasonNotRunning: 'O servidor está desligado.',
    reasonUnknown: 'Ainda não sei o estado do servidor. Tente de novo em alguns segundos.',
    reasonInvalid: 'Esse pedido não é válido.',
    reasonGone: 'Esse servidor não foi encontrado no computador do host.',
    operatorShow: (role: string | null, consoleOn: boolean) => `**Operador:** ${role ? `<@&${role}>` : 'ninguém (só quem gerencia o Discord)'}\n**Console pelo Discord:** ${consoleOn ? 'ligado' : 'desligado'}`,
    operatorSaved: (role: string | null, consoleOn: boolean) => `✅ Salvo.\n${role ? `<@&${role}>` : '—'}`,
    auditLine: (user: string, what: string) => `🛠️ **${user}** usou \`/cubicase ${what}\``,
    kindOperator: 'o cargo de operador',
    channelStatusDone: (ch: string) => `✅ O status ao vivo agora fica em <#${ch}>.`,
    channelAlertsDone: (ch: string) => `✅ Os avisos agora vão para <#${ch}>.`,
    channelInviteDone: (ch: string) => `✅ A mensagem de "como entrar" foi publicada em <#${ch}>.`,
    channelNoAccess: (ch: string) => `Não consegui escrever em <#${ch}>. Dê ao bot as permissões **Ver Canal**, **Enviar Mensagens** e **Inserir Links** nesse canal e tente de novo.`,
    channelNotText: 'Escolha um canal de texto.',
    eventJoins: 'entrada e saída de jogadores', eventPower: 'servidor ligando e desligando', eventOffline: 'servidor caindo ou sumindo',
    eventSet: (label: string, on: boolean) => `${on ? '🔔 Ligado' : '🔕 Desligado'}: aviso de ${label}.`,
    disabledDone: (what: string) => `Pronto, ${what} foi desativado.`,
    kindStatus: 'o status ao vivo', kindAlerts: 'os avisos', kindInvite: 'a mensagem de "como entrar"',
    alertsNeedChannel: 'Antes, escolha o canal dos avisos com `/cubicase canal`.',
    nothingToDisable: 'Isso não estava configurado.',
    inviteTitle: (name: string) => `Como entrar em ${name}`,
    inviteSteps: (url: string, dl: string) => `**1.** Instale o Cubicase: ${dl}\n**2.** Abra o link do servidor: ${url}\n**3.** Clique em **Entrar**. Quando o servidor estiver ligado, o Cubicase mostra o endereço para colar no Minecraft (Multijogador > Adicionar servidor).`,
    inviteButton: 'Entrar no servidor',
    fieldType: 'Tipo',
    linkPaused: 'Esta ligação está pausada porque o Cubicase Plus do host terminou. Renove o Plus para reativar (nada foi apagado).',
    noticeGrace: (name: string, endsAt: number) => `⚠️ O Cubicase Plus de **${name}** terminou. Até <t:${Math.floor(endsAt / 1000)}:D> tudo continua como está; depois, só a ligação mais antiga segue ativa (nada é apagado). Renove o Plus para manter todas.`,
    noticeLimited: (name: string) => `⏸️ Sem o Cubicase Plus, as ligações extras de **${name}** foram pausadas (este Discord pode estar entre elas). Renove o Plus para reativar tudo.`,
    noticeRestored: (name: string) => `✅ O Cubicase Plus de **${name}** voltou: todas as ligações estão ativas de novo.`,
    testMessage: (name: string) => `🔔 Teste do Cubicase: os avisos de **${name}** estão funcionando.`,
    noticeStarted: (name: string) => `🟢 **${name}** está ligado! Bora jogar.`,
    noticeStopped: (name: string) => `🔴 **${name}** foi desligado.`,
    noticeCrashed: (name: string) => `⚠️ **${name}** parou de funcionar de forma inesperada.`,
    noticeLost: (name: string) => `⚠️ **${name}** parou de responder. O computador do host pode estar desligado ou sem internet.`,
    noticeJoined: (names: string, n: number, count: number, max: number) => `➕ **${names}** ${n === 1 ? 'entrou' : 'entraram'} — ${count}/${max} online`,
    noticeLeft: (names: string, n: number, count: number, max: number) => `➖ **${names}** ${n === 1 ? 'saiu' : 'saíram'} — ${count}/${max} online`,
  },
  en: {
    notConfigured: 'The bot is not configured yet.',
    onlyInGuild: 'Use this command inside a Discord server.',
    needManage: 'Only members with the **Manage Server** permission can do that.',
    linkInvalid: 'Invalid or expired code. In Cubicase, open the server, go to **Discord** and generate a new code (valid for 10 minutes).',
    linkOtherAccount: 'This Discord is already linked to servers from **another** Cubicase account. Ask them to unlink first.',
    linkAlready: 'This Discord is already linked to that server.',
    linkFreeServer: 'That server is already linked to another Discord. Linking more than one Discord is part of **Cubicase Plus**.',
    linkFreeGuild: 'This Discord is already linked to a server. Linking more than one server to the same Discord is part of **Cubicase Plus**.',
    linkPlusLimit: 'You reached the link limit for that server or Discord.',
    linkDone: (name: string) => `✅ Done! This Discord is now linked to **${name}**. Use \`/cubicase status\` to see how it is doing.`,
    noServers: 'This Discord is not linked to any server yet. Generate a code in Cubicase and use `/cubicase link`.',
    pickServer: 'This Discord has more than one linked server. Choose one in the **server** field.',
    notLinked: 'That server is not linked to this Discord.',
    serverGone: 'That server no longer exists in Cubicase.',
    unlinked: (name: string) => `Done, **${name}** is no longer linked to this Discord.`,
    statusOnline: '🟢 Online', statusStarting: '🟡 Starting', statusStopping: '🟠 Stopping', statusSleeping: '😴 Standby (wakes up when someone joins)',
    statusOffline: '🔴 Offline',
    fieldPlayers: 'Players', fieldVersion: 'Version', fieldJoin: 'How to join',
    joinWithSlug: (url: string) => `Open ${url} or use the code`,
    footer: 'Cubicase',
    helpTitle: 'Cubicase on Discord',
    help: 'This bot shows the state of your Cubicase Minecraft server.\n\n**Setup** (for whoever manages the Discord):\n1. In Cubicase, open the server and go to **Discord**.\n2. Generate the code and run `/cubicase link` here with it.\n\n**Commands**\n`/cubicase status` — whether it is online and who is playing\n`/cubicase channel` — picks where the status, alerts and "how to join" go\n`/cubicase alerts` — turns each alert type on or off\n`/cubicase disable` — turns off status, alerts or "how to join"\n`/cubicase invite` — posts the "how to join" again\n`/cubicase start` · `stop` · `restart` · `backup` · `whitelist` · `console` — control the server (Cubicase Plus)\n`/cubicase operator` — sets who else can control it\n`/cubicase unlink` — removes the link\n`/cubicase help` — this message',
    unknown: "I don't know that command.",
    controlPlusOnly: 'Controlling the server from Discord is part of **Cubicase Plus**. Plus is checked on the account that linked this server to Discord: if you switched accounts, open the server\'s **Discord** tab in the app, signed in with the Plus account, and click **Generate code** (this moves the link to that account, keeping your settings).',
    controlNeedOperator: 'Only members who manage the Discord or have the **Operator** role can control the server. Managers set the role with `/cubicase operator`.',
    controlCooldown: 'Easy, wait a few seconds before another control command.',
    consoleDisabled: 'Console from Discord is off. Whoever manages the Discord turns it on with `/cubicase operator console:true`.',
    ctlStart: (user: string) => `⏳ **${user}** asked to start the server. The host is starting it…`,
    ctlStop: (user: string) => `⏳ **${user}** asked to stop the server.`,
    ctlRestart: (user: string) => `⏳ **${user}** asked to restart the server.`,
    ctlBackup: (user: string) => `💾 **${user}** asked for a world backup. The host is saving it… (it can take a few minutes; I'll update this message when it's done)`,
    backupDone: (user: string, file: string, size: string) => `✅ World backup finished (requested by **${user}**): \`${file}\`, ${size}.`,
    backupFailed: (user: string, error: string) => `❌ The backup requested by **${user}** failed: ${error}`,
    ctlWhitelist: (user: string, op: string, player: string) => `✅ **${user}** ${op === 'add' ? 'added' : 'removed'} **${player}** ${op === 'add' ? 'to' : 'from'} the whitelist.`,
    ctlConsole: (user: string) => `✅ **${user}** sent a command to the console.`,
    reasonAgentOffline: "The host's Cubicase is closed or offline. Ask them to open the app.",
    reasonNoDevice: "The remote panel isn't paired on the host's computer yet (open Cubicase with the Plus account at least once).",
    reasonAlreadyRunning: 'The server is already on.',
    reasonOtherRunning: 'The host has a **different** server running right now.',
    reasonNotRunning: 'The server is off.',
    reasonUnknown: "I don't know the server's state yet. Try again in a few seconds.",
    reasonInvalid: "That request isn't valid.",
    reasonGone: "That server wasn't found on the host's computer.",
    operatorShow: (role: string | null, consoleOn: boolean) => `**Operator:** ${role ? `<@&${role}>` : 'nobody (only Discord managers)'}\n**Console from Discord:** ${consoleOn ? 'on' : 'off'}`,
    operatorSaved: (role: string | null, consoleOn: boolean) => `✅ Saved.\n${role ? `<@&${role}>` : '—'}`,
    auditLine: (user: string, what: string) => `🛠️ **${user}** used \`/cubicase ${what}\``,
    kindOperator: 'the operator role',
    channelStatusDone: (ch: string) => `✅ The live status now lives in <#${ch}>.`,
    channelAlertsDone: (ch: string) => `✅ Alerts now go to <#${ch}>.`,
    channelInviteDone: (ch: string) => `✅ The "how to join" message was posted in <#${ch}>.`,
    channelNoAccess: (ch: string) => `I couldn't write in <#${ch}>. Give the bot **View Channel**, **Send Messages** and **Embed Links** there and try again.`,
    channelNotText: 'Pick a text channel.',
    eventJoins: 'players joining and leaving', eventPower: 'the server starting and stopping', eventOffline: 'the server going down or vanishing',
    eventSet: (label: string, on: boolean) => `${on ? '🔔 On' : '🔕 Off'}: alert for ${label}.`,
    disabledDone: (what: string) => `Done, ${what} was turned off.`,
    kindStatus: 'the live status', kindAlerts: 'the alerts', kindInvite: 'the "how to join" message',
    alertsNeedChannel: 'First, pick the alerts channel with `/cubicase channel`.',
    nothingToDisable: 'That was not set up.',
    inviteTitle: (name: string) => `How to join ${name}`,
    inviteSteps: (url: string, dl: string) => `**1.** Install Cubicase: ${dl}\n**2.** Open the server link: ${url}\n**3.** Click **Join**. When the server is on, Cubicase shows the address to paste in Minecraft (Multiplayer > Add server).`,
    inviteButton: 'Join the server',
    fieldType: 'Type',
    linkPaused: 'This link is paused because the host\'s Cubicase Plus ended. Renew Plus to turn it back on (nothing was deleted).',
    noticeGrace: (name: string, endsAt: number) => `⚠️ Cubicase Plus for **${name}** ended. Until <t:${Math.floor(endsAt / 1000)}:D> everything stays as it is; after that only the oldest link stays active (nothing is deleted). Renew Plus to keep them all.`,
    noticeLimited: (name: string) => `⏸️ Without Cubicase Plus, the extra links of **${name}** were paused (this Discord may be one of them). Renew Plus to turn everything back on.`,
    noticeRestored: (name: string) => `✅ Cubicase Plus for **${name}** is back: all links are active again.`,
    testMessage: (name: string) => `🔔 Cubicase test: the alerts for **${name}** are working.`,
    noticeStarted: (name: string) => `🟢 **${name}** is online! Let's play.`,
    noticeStopped: (name: string) => `🔴 **${name}** was shut down.`,
    noticeCrashed: (name: string) => `⚠️ **${name}** stopped working unexpectedly.`,
    noticeLost: (name: string) => `⚠️ **${name}** stopped responding. The host's computer may be off or offline.`,
    noticeJoined: (names: string, n: number, count: number, max: number) => `➕ **${names}** joined — ${count}/${max} online`,
    noticeLeft: (names: string, n: number, count: number, max: number) => `➖ **${names}** left — ${count}/${max} online`,
  },
} as const;

export const langOf = (interaction: any): Lang => (String(interaction?.locale ?? interaction?.guild_locale ?? '').toLowerCase().startsWith('pt') ? 'pt' : 'en');


const STATUS_COLOR: Record<string, number> = { online: 0x57f287, starting: 0xfee75c, stopping: 0xe67e22, sleeping: 0x5865f2, offline: 0xed4245 };

export function statusEmbed(lang: Lang, shortCode: string, view: ServerStatusView): Record<string, unknown> {
  const t = TEXTS[lang];
  const state = ['online', 'starting', 'stopping', 'sleeping'].includes(view.minecraftStatus ?? '') ? view.minecraftStatus! : 'offline';
  const label = { online: t.statusOnline, starting: t.statusStarting, stopping: t.statusStopping, sleeping: t.statusSleeping, offline: t.statusOffline }[state]!;
  // Todo servidor tem o link de graça: o próprio código em minúsculas (ou o nome escolhido, no Plus).
  const join = t.joinWithSlug(`https://play.cubicase.net/${view.slug ?? shortCode.toLowerCase()}`);
  const fields: Record<string, unknown>[] = [];
  if (state === 'online') fields.push({ name: t.fieldPlayers, value: `${view.currentPlayers}/${view.maxPlayers}`, inline: true });
  fields.push({ name: t.fieldVersion, value: [view.version || '—', view.serverType && view.serverType !== 'vanilla' ? view.serverType : ''].filter(Boolean).join(' · '), inline: true });
  fields.push({ name: t.fieldJoin, value: join, inline: false });
  return { title: view.name.slice(0, 200), description: label, color: STATUS_COLOR[state], fields, footer: { text: t.footer }, timestamp: new Date().toISOString() };
}


const DOWNLOAD_URL = 'https://cubicase.net/download/';
/** Por que o Discord recusou uma publicação, em palavras: só "sem permissão" quando é mesmo isso. */
export function describeSendFailure(lang: Lang, channelId: string, f: { status: number; code?: number; detail?: string }): string {
  const t = TEXTS[lang];
  const pt = lang === 'pt';
  if (f.status === 401) return pt ? 'O Discord recusou o token do bot (erro 401). Confira o segredo DISCORD_BOT_TOKEN no Worker e publique de novo.' : 'Discord rejected the bot token (error 401). Check the DISCORD_BOT_TOKEN secret on the Worker and redeploy.';
  if (f.status === 429) return pt ? 'O Discord pediu para esperar um pouco. Tente de novo em alguns segundos.' : 'Discord asked us to slow down. Try again in a few seconds.';
  if (f.status === 0) return pt ? 'Não consegui falar com o Discord agora. Tente de novo.' : "Couldn't reach Discord right now. Try again.";
  if (f.status === 400) return pt ? `O Discord recusou a mensagem (erro 400${f.code ? `, código ${f.code}` : ''}${f.detail ? `: ${f.detail}` : ''}).` : `Discord rejected the message (error 400${f.code ? `, code ${f.code}` : ''}${f.detail ? `: ${f.detail}` : ''}).`;
  return `${t.channelNoAccess(channelId)} (${f.status}${f.code ? `/${f.code}` : ''})`;
}

/** Tamanho legível (MB/GB) para as mensagens do bot. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export const joinUrl = (shortCode: string, slug?: string | null) => `https://play.cubicase.net/${slug ?? shortCode.toLowerCase()}`;

/** Mensagem fixada com o passo a passo para entrar (e um botão que abre a página do convite). */
export function inviteMessage(lang: Lang, shortCode: string, view: ServerStatusView) {
  const t = TEXTS[lang];
  const url = joinUrl(shortCode, view.slug);
  const kind = view.serverType && view.serverType !== 'vanilla' ? ` · ${view.serverType}` : '';
  return {
    embeds: [{
      title: t.inviteTitle(view.name).slice(0, 256),
      description: t.inviteSteps(url, DOWNLOAD_URL),
      color: 0x6366f1,
      fields: [{ name: t.fieldVersion, value: `${view.version || '—'}${kind}`, inline: true }],
      footer: { text: t.footer },
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: t.inviteButton, url }] }],
    allowed_mentions: { parse: [] },
  };
}

/** Mensagem do status ao vivo: o mesmo cartão do /cubicase status, com o botão de entrar. */
export function liveStatusMessage(lang: Lang, shortCode: string, view: ServerStatusView) {
  return {
    embeds: [statusEmbed(lang, shortCode, view)],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: TEXTS[lang].inviteButton, url: joinUrl(shortCode, view.slug) }] }],
    allowed_mentions: { parse: [] },
  };
}

/** Nomes de jogador entram em negrito: tira o que viraria formatação ou menção. */
export function safeNames(names: string[]): string {
  return names.map((n) => n.replace(/[\\*_~`|>@#:\[\]()]/g, '')).filter(Boolean).slice(0, 10).join(', ') + (names.length > 10 ? ` +${names.length - 10}` : '');
}
