// ============================================================
// Discord: mensagens automáticas (status ao vivo, "como entrar" e avisos)
// ============================================================
// Cada ligação (servidor x Discord) tem uma configuração em `dcfg:<sc>:<guildId>` no KV. Ela só é gravada quando alguém
// configura (ou quando uma mensagem é recriada / uma ligação quebra): atualizar o status NÃO grava nada, só edita a
// mensagem no Discord.
//
// Quem chama: o heartbeat do host (a cada mudança de estado ou de jogadores, já espaçado pelo app em ~15 s, o que
// também agrupa as entradas e saídas no mesmo aviso) e uma rotina agendada que percebe o host que sumiu sem avisar.
// ============================================================

import type { DiscordApi, ApiFailure } from './discord-api';
import {
  TEXTS, inviteMessage, liveStatusMessage, safeNames, type Lang, type ServerStatusView,
} from './discord-text';

export interface SyncEnv { CUBEFORGE_REGISTRY: KVNamespace }

export type EventKind = 'joins' | 'power' | 'offline';
export const EVENT_KINDS: EventKind[] = ['joins', 'power', 'offline'];
export type ChannelKind = 'status' | 'alerts' | 'invite';

export interface GuildConfig {
  lang: Lang;
  status?: { channelId: string; messageId: string };
  alerts?: { channelId: string };
  invite?: { channelId: string; messageId: string };
  events: Record<EventKind, boolean>;
  /** O Discord recusou (canal apagado, permissão retirada...): para de tentar até a pessoa configurar de novo. */
  broken?: Partial<Record<ChannelKind, boolean>>;
  /** Já avisamos que o host parou de responder (limpa quando ele volta). */
  contactLost?: boolean;
  /** Quem pode controlar o servidor pelo Discord além de quem gerencia o Discord (Cubicase Plus). */
  control?: { operatorRoleId?: string; console?: boolean };
}

/** Retrato do Minecraft como o heartbeat o relata. `names` só existe quando o servidor está ligado a um Discord. */
export interface McSnapshot {
  status: string;
  players: number;
  maxPlayers: number;
  names: string[] | null;
}

const cfgKey = (sc: string, guildId: string) => `dcfg:${sc}:${guildId}`;

export async function getConfig(env: SyncEnv, sc: string, guildId: string): Promise<GuildConfig | null> {
  const raw = await env.CUBEFORGE_REGISTRY.get(cfgKey(sc, guildId));
  if (!raw) return null;
  try { return JSON.parse(raw) as GuildConfig; } catch { return null; }
}

export const saveConfig = (env: SyncEnv, sc: string, guildId: string, cfg: GuildConfig) =>
  env.CUBEFORGE_REGISTRY.put(cfgKey(sc, guildId), JSON.stringify(cfg));

export const deleteConfig = (env: SyncEnv, sc: string, guildId: string) =>
  env.CUBEFORGE_REGISTRY.delete(cfgKey(sc, guildId));

export const newConfig = (lang: Lang): GuildConfig => ({ lang, events: { joins: true, power: true, offline: true } });

// ---------------- o que avisar ----------------

/** Frases a publicar quando o retrato mudou de `prev` para `next` (função pura: é o que os testes cobrem). */
export function deriveNotices(prev: McSnapshot | null, next: McSnapshot, events: Record<EventKind, boolean>, lang: Lang, name: string): string[] {
  const t = TEXTS[lang];
  const out: string[] = [];
  const was = prev?.status ?? null;
  if (events.power) {
    if (next.status === 'online' && was !== 'online') out.push(t.noticeStarted(name));
    else if (next.status === 'offline' && was && ['online', 'stopping', 'starting'].includes(was)) out.push(t.noticeStopped(name));
  }
  if (events.offline && next.status === 'crashed' && was !== 'crashed') out.push(t.noticeCrashed(name));
  // Entrou/saiu só conta com o servidor já ligado dos dois lados: ao ligar ou desligar, a lista inteira muda de uma vez.
  if (events.joins && next.status === 'online' && was === 'online' && prev?.names && next.names) {
    const before = new Set(prev.names), after = new Set(next.names);
    const joined = next.names.filter((n) => !before.has(n));
    const left = prev.names.filter((n) => !after.has(n));
    if (joined.length) out.push(t.noticeJoined(safeNames(joined), joined.length, next.players, next.maxPlayers));
    if (left.length) out.push(t.noticeLeft(safeNames(left), left.length, next.players, next.maxPlayers));
  }
  return out;
}

// ---------------- publicar ----------------

const markBroken = async (env: SyncEnv, sc: string, guildId: string, cfg: GuildConfig, kind: ChannelKind) => {
  await saveConfig(env, sc, guildId, { ...cfg, broken: { ...cfg.broken, [kind]: true } });
};

/** Atualiza a mensagem do status ao vivo (recria se alguém apagou; marca como quebrada se o canal sumiu). */
export async function refreshStatus(env: SyncEnv, api: DiscordApi, sc: string, guildId: string, cfg: GuildConfig, view: ServerStatusView): Promise<void> {
  const target = cfg.status;
  if (!target || cfg.broken?.status) return;
  const body = liveStatusMessage(cfg.lang, sc, view);
  const edited = await api.edit(target.channelId, target.messageId, body);
  if (edited.ok) return;
  if (edited.messageGone) {
    const sent = await api.send(target.channelId, body);
    if (sent.ok) await saveConfig(env, sc, guildId, { ...cfg, status: { channelId: target.channelId, messageId: sent.data.id } });
    else if (sent.gone) await markBroken(env, sc, guildId, cfg, 'status');
    return;
  }
  if (edited.gone) await markBroken(env, sc, guildId, cfg, 'status');
  // 429 ou rede: a próxima mudança atualiza de novo.
}

async function sendAlert(env: SyncEnv, api: DiscordApi, sc: string, guildId: string, cfg: GuildConfig, content: string): Promise<void> {
  const target = cfg.alerts;
  if (!target || cfg.broken?.alerts) return;
  const sent = await api.send(target.channelId, { content, allowed_mentions: { parse: [] } });
  if (!sent.ok && sent.gone) await markBroken(env, sc, guildId, cfg, 'alerts');
}

/** O retrato do Minecraft mudou: atualiza o status ao vivo e publica os avisos de cada Discord ligado. */
export async function notifyChange(
  env: SyncEnv, api: DiscordApi, sc: string, guildIds: string[],
  prev: McSnapshot | null, next: McSnapshot, view: ServerStatusView,
): Promise<void> {
  for (const guildId of guildIds) {
    let cfg = await getConfig(env, sc, guildId);
    if (!cfg) continue;
    if (cfg.contactLost) {
      cfg = { ...cfg, contactLost: false };
      await saveConfig(env, sc, guildId, cfg);
    }
    await refreshStatus(env, api, sc, guildId, cfg, view);
    const notices = deriveNotices(prev, next, cfg.events, cfg.lang, view.name);
    if (notices.length) await sendAlert(env, api, sc, guildId, cfg, notices.join('\n'));
  }
}

/** O host parou de dar sinal (computador desligado, sem internet): mostra o servidor como desligado e avisa uma vez. */
export async function notifyContactLost(env: SyncEnv, api: DiscordApi, sc: string, guildIds: string[], view: ServerStatusView): Promise<void> {
  for (const guildId of guildIds) {
    const cfg = await getConfig(env, sc, guildId);
    if (!cfg || cfg.contactLost) continue;
    const next = { ...cfg, contactLost: true };
    await saveConfig(env, sc, guildId, next);
    await refreshStatus(env, api, sc, guildId, next, { ...view, minecraftStatus: null, currentPlayers: 0 });
    if (cfg.events.offline) await sendAlert(env, api, sc, guildId, next, TEXTS[cfg.lang].noticeLost(view.name));
  }
}

/** Mensagem avulsa (fim do Plus, volta do Plus...) em cada Discord que tem canal de avisos. */
export async function announce(env: SyncEnv, api: DiscordApi, sc: string, guildIds: string[], text: (lang: Lang) => string): Promise<void> {
  for (const guildId of guildIds) {
    const cfg = await getConfig(env, sc, guildId);
    if (cfg) await sendAlert(env, api, sc, guildId, cfg, text(cfg.lang));
  }
}

// ---------------- configuração pelos comandos ----------------

export type SetupResult = { ok: true } | { ok: false; failure: ApiFailure };

/** Publica (ou republica) o status ao vivo no canal escolhido e passa a atualizá-lo. */
export async function setStatusChannel(env: SyncEnv, api: DiscordApi, sc: string, guildId: string, channelId: string, lang: Lang, view: ServerStatusView): Promise<SetupResult> {
  const sent = await api.send(channelId, liveStatusMessage(lang, sc, view));
  if (!sent.ok) return { ok: false, failure: sent };
  const cfg = (await getConfig(env, sc, guildId)) ?? newConfig(lang);
  await saveConfig(env, sc, guildId, { ...cfg, lang, status: { channelId, messageId: sent.data.id }, broken: { ...cfg.broken, status: false } });
  return { ok: true };
}

/** Escolhe o canal dos avisos (testa antes, para não guardar um canal onde o bot não consegue escrever). */
export async function setAlertsChannel(env: SyncEnv, api: DiscordApi, sc: string, guildId: string, channelId: string, lang: Lang, view: ServerStatusView): Promise<SetupResult> {
  const sent = await api.send(channelId, { content: TEXTS[lang].channelAlertsDone(channelId) + ` (${view.name})`, allowed_mentions: { parse: [] } });
  if (!sent.ok) return { ok: false, failure: sent };
  const cfg = (await getConfig(env, sc, guildId)) ?? newConfig(lang);
  await saveConfig(env, sc, guildId, { ...cfg, lang, alerts: { channelId }, broken: { ...cfg.broken, alerts: false } });
  return { ok: true };
}

/** Publica a mensagem de "como entrar" e a fixa (se faltar permissão para fixar, ela só fica sem fixar). */
export async function postInvite(env: SyncEnv, api: DiscordApi, sc: string, guildId: string, channelId: string, lang: Lang, view: ServerStatusView): Promise<SetupResult> {
  const body = inviteMessage(lang, sc, view);
  const cfg = (await getConfig(env, sc, guildId)) ?? newConfig(lang);
  // Mesma mensagem, mesmo canal: edita em vez de empilhar cópias.
  if (cfg.invite && cfg.invite.channelId === channelId && !cfg.broken?.invite) {
    const edited = await api.edit(channelId, cfg.invite.messageId, body);
    if (edited.ok) { await saveConfig(env, sc, guildId, { ...cfg, lang }); return { ok: true }; }
    if (!edited.messageGone) return { ok: false, failure: edited };
  }
  const sent = await api.send(channelId, body);
  if (!sent.ok) return { ok: false, failure: sent };
  await api.pin(channelId, sent.data.id);
  if (cfg.invite && cfg.invite.channelId === channelId) await api.unpin(channelId, cfg.invite.messageId);
  await saveConfig(env, sc, guildId, { ...cfg, lang, invite: { channelId, messageId: sent.data.id }, broken: { ...cfg.broken, invite: false } });
  return { ok: true };
}

export type TestResult = { kind: 'alert' | 'status' } | { kind: 'nothing' } | { kind: 'failed'; failure: ApiFailure };

/** Botão "enviar teste" do app: manda uma mensagem de teste aos avisos (ou reatualiza o status, se só ele existir). */
export async function sendTest(env: SyncEnv, api: DiscordApi, sc: string, guildId: string, view: ServerStatusView): Promise<TestResult> {
  const cfg = await getConfig(env, sc, guildId);
  if (cfg?.alerts) {
    const sent = await api.send(cfg.alerts.channelId, { content: TEXTS[cfg.lang].testMessage(view.name), allowed_mentions: { parse: [] } });
    if (sent.ok) return { kind: 'alert' };
    if (sent.gone) await markBroken(env, sc, guildId, cfg, 'alerts');
    return { kind: 'failed', failure: sent };
  }
  if (cfg?.status) {
    const edited = await api.edit(cfg.status.channelId, cfg.status.messageId, liveStatusMessage(cfg.lang, sc, view));
    if (edited.ok) return { kind: 'status' };
    if (edited.messageGone) {
      const sent = await api.send(cfg.status.channelId, liveStatusMessage(cfg.lang, sc, view));
      if (sent.ok) { await saveConfig(env, sc, guildId, { ...cfg, status: { channelId: cfg.status.channelId, messageId: sent.data.id } }); return { kind: 'status' }; }
      if (sent.gone) await markBroken(env, sc, guildId, cfg, 'status');
      return { kind: 'failed', failure: sent };
    }
    if (edited.gone) await markBroken(env, sc, guildId, cfg, 'status');
    return { kind: 'failed', failure: edited };
  }
  return { kind: 'nothing' };
}

/** Cargo "Operador" e liberação do console. Cria a configuração se ainda não existir. */
export async function setControl(env: SyncEnv, sc: string, guildId: string, lang: Lang, change: { operatorRoleId?: string | null; console?: boolean }): Promise<GuildConfig> {
  const cfg = (await getConfig(env, sc, guildId)) ?? newConfig(lang);
  const control = { ...cfg.control };
  if (change.operatorRoleId === null) delete control.operatorRoleId;
  else if (change.operatorRoleId !== undefined) control.operatorRoleId = change.operatorRoleId;
  if (change.console !== undefined) control.console = change.console;
  const next = { ...cfg, control };
  await saveConfig(env, sc, guildId, next);
  return next;
}

/** Desliga um dos três recursos. false se ele não estava configurado. */
export async function disableChannel(env: SyncEnv, sc: string, guildId: string, kind: ChannelKind): Promise<boolean> {
  const cfg = await getConfig(env, sc, guildId);
  if (!cfg || !cfg[kind]) return false;
  const { [kind]: _removed, ...rest } = cfg;
  await saveConfig(env, sc, guildId, rest as GuildConfig);
  return true;
}

export async function setEvent(env: SyncEnv, sc: string, guildId: string, event: EventKind, on: boolean): Promise<void> {
  const cfg = await getConfig(env, sc, guildId);
  if (!cfg) return;
  await saveConfig(env, sc, guildId, { ...cfg, events: { ...cfg.events, [event]: on } });
}
