// ============================================================
// Painel web remoto — permissões de acesso compartilhado
// ============================================================
// Lógica pura (sem I/O) do modelo de permissões de quem NÃO é o dono do
// dispositivo. Usada tanto pelos endpoints de convite/membros (index.ts,
// panel-members.ts) quanto pelo Durable Object (host-channel.ts), que é
// quem de fato aplica a checagem a CADA mensagem vinda do painel — o painel
// (JavaScript no navegador) nunca é a fonte da verdade sobre o que alguém
// pode fazer: esconder um botão lá é só cosmético.
// ============================================================

export interface CommandPolicy {
  mode: 'none' | 'allowlist' | 'all';
  /** Cada entrada casa por prefixo, palavra por palavra: "time set" libera "time set day" mas não "time add 5". */
  allowlist: string[];
}

export interface PanelPermissions {
  viewConsole: boolean;
  start: boolean;
  stop: boolean;
  restart: boolean;
  commands: CommandPolicy;
}

export const OWNER_PERMISSIONS: PanelPermissions = {
  viewConsole: true,
  start: true,
  stop: true,
  restart: true,
  commands: { mode: 'all', allowlist: [] },
};

/** Só preenchem os campos de PanelPermissions — não existe "preset" como conceito guardado no banco. */
export const PERMISSION_PRESETS: Record<'viewer' | 'operator' | 'moderator' | 'admin', PanelPermissions> = {
  viewer: { viewConsole: true, start: false, stop: false, restart: false, commands: { mode: 'none', allowlist: [] } },
  operator: { viewConsole: true, start: true, stop: true, restart: true, commands: { mode: 'none', allowlist: [] } },
  moderator: { viewConsole: true, start: false, stop: false, restart: false, commands: { mode: 'allowlist', allowlist: ['say', 'kick', 'whitelist'] } },
  admin: OWNER_PERMISSIONS,
};

export const MAX_ALLOWLIST_ENTRIES = 40;
export const MAX_ALLOWLIST_ENTRY_LENGTH = 60;
export const MAX_COMMAND_LENGTH = 500;
export const MAX_SERVER_ID_LENGTH = 200;

// Caracteres de controle (inclui \n e \r, que num stdin de console
// significariam "vários comandos numa mensagem só", furando a whitelist).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Normaliza uma entrada de whitelist: sem "/" inicial, minúscula, espaços colapsados. null se inválida. */
export function normalizeAllowlistEntry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (CONTROL_CHARS.test(raw)) return null;
  const cleaned = raw.trim().replace(/^\/+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > MAX_ALLOWLIST_ENTRY_LENGTH) return null;
  return cleaned;
}

/** Valida/limpa um objeto de permissões vindo de fora (JSON do cliente ou do banco). null se o formato for inválido. */
export function normalizePermissions(input: unknown): PanelPermissions | null {
  if (!input || typeof input !== 'object') return null;
  const p = input as Record<string, any>;
  const commands = p.commands;
  if (!commands || typeof commands !== 'object') return null;
  const mode = commands.mode;
  if (mode !== 'none' && mode !== 'allowlist' && mode !== 'all') return null;

  let allowlist: string[] = [];
  if (mode === 'allowlist') {
    if (!Array.isArray(commands.allowlist)) return null;
    const seen = new Set<string>();
    for (const entry of commands.allowlist) {
      const normalized = normalizeAllowlistEntry(entry);
      if (normalized === null) return null;
      seen.add(normalized);
    }
    allowlist = [...seen];
    if (allowlist.length === 0 || allowlist.length > MAX_ALLOWLIST_ENTRIES) return null;
  }

  return {
    viewConsole: p.viewConsole === true,
    start: p.start === true,
    stop: p.stop === true,
    restart: p.restart === true,
    commands: { mode, allowlist },
  };
}

function commandTokens(command: string): string[] {
  return command.trim().replace(/^\/+/, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function allowlistMatches(allowlist: string[], tokens: string[]): boolean {
  return allowlist.some((entry) => {
    const entryTokens = entry.split(' ');
    if (entryTokens.length > tokens.length) return false;
    return entryTokens.every((t, i) => tokens[i] === t);
  });
}

/** Ações de moderação por jogador (Modo Espectador Web). Cada uma vira um comando de console equivalente. */
export const PLAYER_ACTIONS = ['kick', 'ban', 'pardon'] as const;
export type PlayerAction = (typeof PLAYER_ACTIONS)[number];
export const MAX_REASON_LENGTH = 100;

// Mesmo critério do agent (src-tauri/src/players.rs): 1–16 de [A-Za-z0-9_], "." inicial opcional (Bedrock/Floodgate).
// É também o que impede injeção de comando por nome ("@a", "x stop", quebra de linha).
const PLAYER_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;
// Sem "." de propósito: o DO usa "." pra compor `userId.requestId` (ver host-channel.ts).
const REQUEST_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type PanelMessageDecision =
  | {
      ok: true;
      forward:
        | { type: 'command'; command: string }
        | { type: 'stop_server' }
        | { type: 'start_server'; serverId: string }
        | { type: 'restart_server'; serverId: string }
        | { type: 'player_action'; action: PlayerAction; player: string; reason?: string; requestId: string }
        | { type: 'players_refresh' };
    }
  | { ok: false; reason: string };

/** Motivo da negação pela política de comandos, ou null se liberado. Compartilhado por "command" e "player_action". */
function commandPolicyDenial(perms: PanelPermissions, tokens: string[]): string | null {
  if (perms.commands.mode === 'none') return 'Você não tem permissão para rodar comandos.';
  if (perms.commands.mode === 'allowlist' && !allowlistMatches(perms.commands.allowlist, tokens)) {
    return `O comando "${tokens[0]}" não está na sua lista de comandos permitidos.`;
  }
  return null;
}

/**
 * Decide se uma mensagem do painel pode seguir para o agent, e devolve uma
 * versão RECONSTRUÍDA dela (só os campos conhecidos — nada que o cliente
 * tenha mandado a mais chega ao agent). Tipos desconhecidos são negados por
 * padrão: antes desta camada existir, o relay repassava qualquer coisa.
 */
export function authorizePanelMessage(perms: PanelPermissions, msg: unknown): PanelMessageDecision {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'Mensagem inválida.' };
  const m = msg as Record<string, any>;

  switch (m.type) {
    case 'command': {
      if (typeof m.command !== 'string') return { ok: false, reason: 'Comando inválido.' };
      const command = m.command.trim();
      if (!command || command.length > MAX_COMMAND_LENGTH || CONTROL_CHARS.test(command)) {
        return { ok: false, reason: 'Comando inválido.' };
      }
      const tokens = commandTokens(command);
      if (tokens.length === 0) return { ok: false, reason: 'Comando inválido.' };
      // "stop" digitado no console é o mesmo que o botão de desligar — sem
      // esta regra, quem pode rodar comandos mas não desligar desligaria
      // do mesmo jeito.
      if (tokens[0] === 'stop' && !perms.stop) {
        return { ok: false, reason: 'Você não tem permissão para desligar o servidor.' };
      }
      const denial = commandPolicyDenial(perms, tokens);
      if (denial) return { ok: false, reason: denial };
      return { ok: true, forward: { type: 'command', command } };
    }
    case 'player_action': {
      // Reaproveita a política de comandos: "kick Steve" só passa se o membro
      // poderia digitar esse comando no console. Assim o botão do painel nunca
      // dá mais poder que o console — e não há permissão nova pra migrar no banco.
      const action = PLAYER_ACTIONS.find((a) => a === m.action);
      if (!action) return { ok: false, reason: 'Ação não suportada.' };
      if (typeof m.player !== 'string' || !PLAYER_NAME.test(m.player)) {
        return { ok: false, reason: 'Nome de jogador inválido.' };
      }
      if (typeof m.requestId !== 'string' || !REQUEST_ID.test(m.requestId)) {
        return { ok: false, reason: 'Mensagem inválida.' };
      }
      let reason: string | undefined;
      if (action !== 'pardon' && m.reason !== undefined && m.reason !== null) {
        if (typeof m.reason !== 'string' || CONTROL_CHARS.test(m.reason)) return { ok: false, reason: 'Motivo inválido.' };
        const collapsed = m.reason.trim().replace(/\s+/g, ' ');
        if (collapsed.length > MAX_REASON_LENGTH) return { ok: false, reason: 'Motivo muito longo (máximo 100 caracteres).' };
        if (collapsed) reason = collapsed;
      }
      const denial = commandPolicyDenial(perms, [action, m.player.toLowerCase()]);
      if (denial) return { ok: false, reason: denial };
      return { ok: true, forward: { type: 'player_action', action, player: m.player, ...(reason ? { reason } : {}), requestId: m.requestId } };
    }
    case 'players_refresh':
      // Mostra quem está online — mesmo critério de quem vê o console (a lista
      // de nomes só é entregue a quem pode ver o console; ver host-channel.ts).
      if (!perms.viewConsole) return { ok: false, reason: 'Você não tem permissão para ver os jogadores.' };
      return { ok: true, forward: { type: 'players_refresh' } };
    case 'stop_server':
      if (!perms.stop) return { ok: false, reason: 'Você não tem permissão para desligar o servidor.' };
      return { ok: true, forward: { type: 'stop_server' } };
    case 'start_server': {
      if (!perms.start) return { ok: false, reason: 'Você não tem permissão para ligar o servidor.' };
      const serverId = validServerId(m.serverId);
      if (!serverId) return { ok: false, reason: 'Servidor inválido.' };
      return { ok: true, forward: { type: 'start_server', serverId } };
    }
    case 'restart_server': {
      if (!perms.restart) return { ok: false, reason: 'Você não tem permissão para reiniciar o servidor.' };
      const serverId = validServerId(m.serverId);
      if (!serverId) return { ok: false, reason: 'Servidor inválido.' };
      return { ok: true, forward: { type: 'restart_server', serverId } };
    }
    default:
      return { ok: false, reason: 'Ação não suportada.' };
  }
}

function validServerId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_SERVER_ID_LENGTH || CONTROL_CHARS.test(raw)) return null;
  return raw;
}

/** Token de convite por link: 24 bytes aleatórios em base64url (192 bits, inadivinhável). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface InviteState {
  single_use: boolean;
  uses: number;
  expires_at: string;
}

export function inviteUsable(invite: InviteState, nowMs: number): boolean {
  if (nowMs >= new Date(invite.expires_at).getTime()) return false;
  if (invite.single_use && invite.uses >= 1) return false;
  return true;
}
