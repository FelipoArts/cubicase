"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, RefreshCw, Send, Unlink } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useT } from "@/i18n";
import {
  createDiscordLinkCode, getDiscordInstallUrl, listDiscordChannels, listDiscordLinks, listDiscordRoles, saveDiscordConfig, sendDiscordTest, unlinkDiscord,
  type DiscordChannel, type DiscordRole, type DiscordChannelKind, type DiscordEventKind, type DiscordLink, type DiscordLinkCode,
} from "@/lib/discord";
import { errorMessage } from "@/lib/errorMessage";
import { cn } from "@/lib/utils";
import { Card, Field, inputCls, MiniButton, Notice, ToggleRow } from "@/app/shell/ui";

const KINDS: DiscordChannelKind[] = ["status", "alerts", "invite"];
const EVENTS: DiscordEventKind[] = ["joins", "power", "offline"];

// Liga o servidor a um Discord: adiciona o bot, gera o código de uso único e, para cada Discord ligado, escolhe os
// canais (status ao vivo, avisos, "como entrar"), liga/desliga cada aviso, manda um teste e mostra se algo quebrou.
export function DiscordCard({ shortCode }: { shortCode: string | null }) {
  const { t } = useT();
  const [links, setLinks] = useState<DiscordLink[]>([]);
  const [code, setCode] = useState<DiscordLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((err: unknown) => setError(t("discord.error", { message: errorMessage(err) || String(err) })), [t]);

  const refresh = useCallback(async () => {
    if (!shortCode) return;
    try {
      setLinks(await listDiscordLinks(shortCode));
      setError(null);
    } catch (err) {
      fail(err);
    }
  }, [shortCode, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!shortCode) {
    return <Card title={t("discord.title")} hint={t("discord.hint")}><p className="text-sm text-theme-secondary">{t("discord.noCode")}</p></Card>;
  }

  const generate = async () => {
    setBusy(true);
    try {
      setCode(await createDiscordLinkCode(shortCode));
      setError(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* sem permissão da área de transferência: a pessoa digita o código */ }
  };

  return (
    <Card title={t("discord.title")} hint={t("discord.hint")} action={<MiniButton onClick={refresh} title={t("discord.refresh")}><RefreshCw className="w-3.5 h-3.5" /></MiniButton>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}

        <div>
          <p className="text-xs font-bold text-theme-primary mb-1.5">{t("discord.step1")}</p>
          <MiniButton onClick={async () => {
            try { await open(await getDiscordInstallUrl()); } catch (err) { fail(err); }
          }}><ExternalLink className="w-3.5 h-3.5" />{t("discord.addBot")}</MiniButton>
        </div>

        <div>
          <p className="text-xs font-bold text-theme-primary mb-1.5">{t("discord.step2")}</p>
          <p className="text-xs text-theme-secondary mb-2">{t("discord.step2Hint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <MiniButton tone="primary" onClick={generate} disabled={busy}>{code ? t("discord.regenerate") : t("discord.generate")}</MiniButton>
            {code && (
              <>
                <code className="px-3 py-1.5 rounded-lg bg-theme-muted border border-theme-card text-sm font-mono tracking-widest text-theme-primary select-all">{code.code}</code>
                <MiniButton onClick={copy}>{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? t("discord.copied") : t("discord.copy")}</MiniButton>
              </>
            )}
          </div>
          {code && <p className="text-[11px] text-theme-secondary mt-2">{t("discord.codeExpires", { minutes: Math.round(code.expiresInSeconds / 60) })}</p>}
        </div>

        <div>
          <p className="text-xs font-bold text-theme-primary mb-1.5">{t("discord.linked")}</p>
          {links.length === 0 ? (
            <p className="text-xs text-theme-secondary">{t("discord.linkedEmpty")}</p>
          ) : (
            <ul className="space-y-2">
              {links.map((l) => (
                <LinkRow key={l.guildId} shortCode={shortCode} link={l} onChanged={refresh} onError={fail} />
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-theme-secondary">{t("discord.freeNote")}</p>
      </div>
    </Card>
  );
}

function LinkRow({ shortCode, link, onChanged, onError }: { shortCode: string; link: DiscordLink; onChanged: () => Promise<void>; onError: (err: unknown) => void }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [channels, setChannels] = useState<DiscordChannel[] | null>(null);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  // O que a pessoa acabou de mexer vale até a próxima lista da central chegar (aí `link.config` volta a mandar).
  const [edited, setEdited] = useState<{ base: DiscordLink["config"]; value: DiscordLink["config"] } | null>(null);
  const config = edited && edited.base === link.config ? edited.value : link.config;
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<"idle" | "sending" | "sent">("idle");

  const brokenKinds = KINDS.filter((k) => config.broken[k] && config[k]);
  const health: "removed" | "broken" | "lost" | "ok" =
    !link.botPresent ? "removed" : brokenKinds.length ? "broken" : config.contactLost ? "lost" : "ok";
  const healthLabel = {
    removed: t("discord.health.removed"),
    broken: t("discord.health.broken"),
    lost: t("discord.health.lost"),
    ok: t("discord.health.ok"),
  }[health];

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && link.botPresent && !channels) {
      try {
        setChannels(await listDiscordChannels(shortCode, link.guildId));
        setRoles(await listDiscordRoles(shortCode, link.guildId));
      } catch (err) { onError(err); }
    }
  };

  const change = async (change: Parameters<typeof saveDiscordConfig>[2]) => {
    setSaving(true);
    try {
      const value = await saveDiscordConfig(shortCode, link.guildId, change);
      setEdited({ base: link.config, value });
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTestState("sending");
    try {
      await sendDiscordTest(shortCode, link.guildId);
      setTestState("sent");
      setTimeout(() => setTestState("idle"), 2000);
    } catch (err) {
      setTestState("idle");
      onError(err);
      await onChanged();
    }
  };

  const unlink = async () => {
    if (!window.confirm(t("discord.unlinkConfirm"))) return;
    try {
      await unlinkDiscord(shortCode, link.guildId);
      await onChanged();
    } catch (err) {
      onError(err);
    }
  };

  const name = link.guildName ?? t("discord.linkedItem", { id: link.guildId });
  const addBot = async () => {
    try { await open(await getDiscordInstallUrl()); } catch (err) { onError(err); }
  };

  return (
    <li className="bg-theme-muted border border-theme-card rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={toggle} className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer" aria-expanded={expanded}>
          <ChevronDown className={cn("w-4 h-4 text-theme-secondary shrink-0 transition-transform", !expanded && "-rotate-90")} />
          <div className="min-w-0">
            <p className="text-xs font-bold text-theme-primary truncate">{name}</p>
            <p className="text-[11px] text-theme-secondary">{t("discord.linkedSince", { date: new Date(link.linkedAt).toLocaleDateString() })}</p>
          </div>
        </button>
        <span className={cn(
          "text-[11px] font-bold px-2 py-0.5 rounded-full border shrink-0",
          health === "ok" ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 text-amber-700 dark:text-amber-300",
        )}>{healthLabel}</span>
        <MiniButton tone="danger" onClick={unlink}><Unlink className="w-3.5 h-3.5" />{t("discord.unlink")}</MiniButton>
      </div>

      {health === "removed" && (
        <div className="px-3 pb-3">
          <Notice tone="warning" action={<MiniButton onClick={addBot}><ExternalLink className="w-3.5 h-3.5" />{t("discord.addBot")}</MiniButton>}>
            {t("discord.removedHint")}
          </Notice>
        </div>
      )}
      {health === "broken" && (
        <div className="px-3 pb-3">
          <Notice tone="warning">{t("discord.brokenHint", { what: brokenKinds.map((k) => t(`discord.kind.${k}`)).join(", ") })}</Notice>
        </div>
      )}

      {expanded && link.botPresent && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-theme-card">
          {!channels ? (
            <p className="text-xs text-theme-secondary pt-2">{t("config.loading")}</p>
          ) : (
            <>
              <div className="grid sm:grid-cols-3 gap-3 pt-2">
                {KINDS.map((kind) => (
                  <Field key={kind} label={t(`discord.kind.${kind}`)} hint={t(`discord.kindHint.${kind}`)}>
                    <select
                      className={cn(inputCls, "cursor-pointer")}
                      value={config[kind] ?? ""}
                      disabled={saving}
                      onChange={(e) => void change({ kind, channelId: e.target.value || null })}
                    >
                      <option value="">{t("discord.channel.none")}</option>
                      {config[kind] && !channels.some((c) => c.id === config[kind]) && <option value={config[kind]!}>{t("discord.channel.unknown")}</option>}
                      {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                    </select>
                  </Field>
                ))}
              </div>

              <div className="divide-y divide-theme-card">
                {EVENTS.map((event) => (
                  <ToggleRow
                    key={event}
                    label={t(`discord.event.${event}`)}
                    checked={config.events[event]}
                    disabled={!config.alerts || saving}
                    onChange={(on) => void change({ events: { [event]: on } })}
                  />
                ))}
              </div>
              {!config.alerts && <p className="text-[11px] text-theme-secondary">{t("discord.eventsNeedChannel")}</p>}

              <div className="space-y-2 pt-1">
                <p className="text-xs font-bold text-theme-primary">{t("discord.control.title")}</p>
                <p className="text-[11px] text-theme-secondary">{t("discord.control.hint")}</p>
                <Field label={t("discord.control.role")} hint={t("discord.control.roleHint")}>
                  <select
                    className={cn(inputCls, "cursor-pointer sm:max-w-xs")}
                    value={config.control.operatorRoleId ?? ""}
                    disabled={saving}
                    onChange={(e) => void change({ control: { operatorRoleId: e.target.value || null } })}
                  >
                    <option value="">{t("discord.control.roleNone")}</option>
                    {config.control.operatorRoleId && !roles.some((r) => r.id === config.control.operatorRoleId) && <option value={config.control.operatorRoleId}>{t("discord.control.roleUnknown")}</option>}
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </Field>
                <ToggleRow
                  label={t("discord.control.console")}
                  hint={t("discord.control.consoleHint")}
                  checked={config.control.console}
                  disabled={saving}
                  onChange={(on) => void change({ control: { console: on } })}
                />
              </div>

              <MiniButton onClick={test} disabled={testState === "sending" || (!config.alerts && !config.status)}>
                {testState === "sent" ? <Check className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
                {testState === "sent" ? t("discord.testSent") : t("discord.test")}
              </MiniButton>
            </>
          )}
        </div>
      )}
    </li>
  );
}
