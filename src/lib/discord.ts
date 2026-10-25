// ============================================================
// Bot do Discord — lado do app
// ============================================================
// O dono do servidor gera aqui um código de uso único e o admin do Discord o usa em `/cubicase vincular`. Tudo passa
// pela API Central (api/src/discord.ts): gerar o código exige o segredo do servidor E a conta; listar e desvincular só
// o segredo (ver slug em inviteLink.ts para o mesmo padrão).
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { supabase } from "@/lib/supabaseClient";
import { requireAuth } from "@/lib/auth";
import { getLocale, t } from "@/i18n";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

/** Link para adicionar o bot a um Discord (público, não precisa de login). */
export async function getDiscordInstallUrl(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/discord/install-url`, { headers: { "Accept-Language": getLocale() } });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<{ url: string }> | null;
  if (!res.ok || !json?.success || !json.data?.url) throw new Error(json?.message || t("err.operationFailed", { status: res.status }));
  return json.data.url;
}

export type DiscordChannelKind = "status" | "alerts" | "invite";
export type DiscordEventKind = "joins" | "power" | "offline";

/** Configuração de uma ligação: id do canal de cada recurso (null = desligado), avisos e o que quebrou. */
export interface DiscordConfig {
  status: string | null;
  alerts: string | null;
  invite: string | null;
  events: Record<DiscordEventKind, boolean>;
  broken: Record<DiscordChannelKind, boolean>;
  contactLost: boolean;
  control: { operatorRoleId: string | null; console: boolean };
}

export interface DiscordLink {
  guildId: string;
  linkedAt: string;
  /** Nome do Discord (null se a central não conseguiu consultar agora). */
  guildName: string | null;
  /** false = o bot foi removido desse Discord. */
  botPresent: boolean;
  config: DiscordConfig;
}

export interface DiscordChannel { id: string; name: string }
export interface DiscordRole { id: string; name: string }
export interface DiscordLinkCode { code: string; expiresInSeconds: number; installUrl: string | null }

interface ApiEnvelope<T> { success: boolean; message?: string; data?: T }

async function discordFetch<T>(shortCode: string, path: string, method: "GET" | "POST" | "PUT" | "DELETE", withAccount: boolean, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // shortCode é público: as rotas de dono exigem o segredo do servidor (guardado pelo Rust).
    "X-Owner-Secret": await invoke<string>("get_owner_secret", { shortCode }),
    "Accept-Language": getLocale(),
  };
  if (withAccount) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error(t("err.notAuthenticated"));
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}/discord${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !json?.success) throw new Error(json?.message || t("err.operationFailed", { status: res.status }));
  return json.data as T;
}

/** Gera o código de vinculação (pede login). O anterior deixa de valer. */
export async function createDiscordLinkCode(shortCode: string): Promise<DiscordLinkCode> {
  await requireAuth();
  return discordFetch<DiscordLinkCode>(shortCode, "/link-code", "POST", true);
}

export async function listDiscordLinks(shortCode: string): Promise<DiscordLink[]> {
  return (await discordFetch<{ guilds: DiscordLink[] }>(shortCode, "", "GET", false)).guilds;
}

export async function listDiscordChannels(shortCode: string, guildId: string): Promise<DiscordChannel[]> {
  return (await discordFetch<{ channels: DiscordChannel[] }>(shortCode, `/${guildId}/channels`, "GET", false)).channels;
}

export async function listDiscordRoles(shortCode: string, guildId: string): Promise<DiscordRole[]> {
  return (await discordFetch<{ roles: DiscordRole[] }>(shortCode, `/${guildId}/roles`, "GET", false)).roles;
}

/** Escolhe (ou, com null, remove) o canal de um recurso e/ou liga/desliga avisos. Devolve a configuração nova. */
export async function saveDiscordConfig(
  shortCode: string,
  guildId: string,
  change: {
    kind?: DiscordChannelKind;
    channelId?: string | null;
    events?: Partial<Record<DiscordEventKind, boolean>>;
    control?: { operatorRoleId?: string | null; console?: boolean };
  },
): Promise<DiscordConfig> {
  return (await discordFetch<{ config: DiscordConfig }>(shortCode, `/${guildId}/config`, "PUT", false, change)).config;
}

export async function sendDiscordTest(shortCode: string, guildId: string): Promise<void> {
  await discordFetch<unknown>(shortCode, `/${guildId}/test`, "POST", false);
}

export async function unlinkDiscord(shortCode: string, guildId: string): Promise<void> {
  await discordFetch<unknown>(shortCode, `/${guildId}`, "DELETE", false);
}
