// ============================================================
// API REST do Discord (envio de mensagens do bot)
// ============================================================
// Pequena camada sobre fetch, para o resto do código não conhecer URLs nem códigos de erro. É uma interface
// (`DiscordApi`) para os testes trocarem o Discord por um falso.
// ============================================================

const BASE = 'https://discord.com/api/v10';

export type ApiFailure = {
  ok: false;
  status: number;
  /** Código de erro do Discord (ex.: 10008 = mensagem não existe, 50001 = sem acesso). */
  code?: number;
  /** O destino sumiu ou o bot perdeu o acesso: não adianta tentar de novo. */
  gone: boolean;
  /** A mensagem em si foi apagada (o canal ainda existe): dá para publicar outra. */
  messageGone: boolean;
  retryAfterMs?: number;
  /** Texto de erro do Discord (para log e diagnóstico). */
  detail?: string;
};
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export interface DiscordApi {
  send(channelId: string, body: unknown): Promise<ApiResult<{ id: string }>>;
  edit(channelId: string, messageId: string, body: unknown): Promise<ApiResult<unknown>>;
  pin(channelId: string, messageId: string): Promise<ApiResult<unknown>>;
  unpin(channelId: string, messageId: string): Promise<ApiResult<unknown>>;
  /** Dados do servidor do Discord (nome). Falha com `gone` quando o bot não está mais lá. */
  guild(guildId: string): Promise<ApiResult<{ id: string; name: string }>>;
  /** Quem é o bot dono do token (para conferir se é o mesmo aplicativo do DISCORD_APP_ID). */
  me(): Promise<ApiResult<{ id: string; username: string }>>;
  /** Um canal (serve para saber se o bot consegue enxergá-lo). */
  channel(channelId: string): Promise<ApiResult<{ id: string; name?: string }>>;
  /** Cargos do servidor do Discord (para escolher o Operador). */
  roles(guildId: string): Promise<ApiResult<{ id: string; name: string; managed?: boolean }[]>>;
  /** Canais do servidor do Discord (o app filtra os de texto). */
  channels(guildId: string): Promise<ApiResult<{ id: string; name: string; type: number }[]>>;
}

// 10003 canal inexistente, 10004 servidor inexistente, 10008 mensagem inexistente, 50001 sem acesso, 50013 sem permissão.
const GONE_CODES = new Set([10003, 10004, 50001, 50013]);

async function failure(res: Response): Promise<ApiFailure> {
  const body = (await res.json().catch(() => null)) as { code?: number; message?: string; retry_after?: number } | null;
  const code = typeof body?.code === 'number' ? body.code : undefined;
  const messageGone = code === 10008;
  return {
    ok: false,
    status: res.status,
    code,
    messageGone,
    gone: !messageGone && ((code !== undefined && GONE_CODES.has(code)) || res.status === 403 || res.status === 404),
    detail: typeof body?.message === 'string' ? body.message.slice(0, 200) : undefined,
    retryAfterMs: res.status === 429 && typeof body?.retry_after === 'number' ? Math.ceil(body.retry_after * 1000) : undefined,
  };
}

export function restApi(token: string): DiscordApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'CubicaseBot (https://cubicase.net, 1)' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const f = await failure(res);
        console.error('[discord] API recusou', method, path.replace(/\d{6,}/g, '#'), f.status, f.code ?? '', f.detail ?? '');
        return f;
      }
      return { ok: true, data: (res.status === 204 ? null : await res.json().catch(() => null)) as T };
    } catch {
      // Rede fora do ar: não é motivo para dar a ligação como perdida.
      return { ok: false, status: 0, gone: false, messageGone: false };
    }
  };
  return {
    send: (channelId, body) => call(`POST`, `/channels/${channelId}/messages`, body),
    edit: (channelId, messageId, body) => call(`PATCH`, `/channels/${channelId}/messages/${messageId}`, body),
    pin: (channelId, messageId) => call(`PUT`, `/channels/${channelId}/pins/${messageId}`),
    unpin: (channelId, messageId) => call(`DELETE`, `/channels/${channelId}/pins/${messageId}`),
    me: () => call(`GET`, `/users/@me`),
    channel: (channelId) => call(`GET`, `/channels/${channelId}`),
    guild: (guildId) => call(`GET`, `/guilds/${guildId}`),
    channels: (guildId) => call(`GET`, `/guilds/${guildId}/channels`),
    roles: (guildId) => call(`GET`, `/guilds/${guildId}/roles`),
  };
}
