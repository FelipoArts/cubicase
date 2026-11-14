// ============================================================
// Membros do servidor — cliente do Worker (ver api/src/members.ts)
// ============================================================
// "Membro" é uma conta que adicionou o servidor à biblioteca. O app avisa o Worker quando a conta logada adiciona ou
// remove um servidor e, ao entrar na conta, registra de uma vez os que já tinha. Sem conta nada disso acontece e o
// app funciona igual. Falhas de rede são silenciosas: a próxima sincronização corrige.
// ============================================================

import { useEffect, useState } from "react";
import { useAppStore } from "@/app/store";
import { ApiCallError, authedFetch } from "@/lib/authedApi";
import type { PlusTierId, UserProfile } from "@/lib/profileCatalog";

export interface ServerMember {
  /** Id opaco (não é a conta). */
  id: string;
  role: "host" | "member";
  self: boolean;
  /** Conectado ao servidor agora. */
  online: boolean;
  profile: UserProfile | null;
  plus: boolean;
  tier: PlusTierId | null;
}

export interface ServerMembersResult {
  members: ServerMember[];
  total: number;
  /** Membros conectados agora. */
  onlineCount: number;
  /** Quantos estão conectados sem conta (não aparecem na lista, só no número). */
  anonymousOnline: number;
}

/** De quanto em quanto tempo a lista é atualizada enquanto o cartão está à vista. */
export const MEMBERS_POLL_MS = 30_000;
const BULK_MAX = 100;

const norm = (code: string) => code.trim().toUpperCase();

/** O que mudou entre duas listas de códigos de servidor. */
export function diffServers(prev: Iterable<string>, next: Iterable<string>): { added: string[]; removed: string[] } {
  const a = new Set([...prev].map(norm));
  const b = new Set([...next].map(norm));
  return { added: [...b].filter((c) => !a.has(c)), removed: [...a].filter((c) => !b.has(c)) };
}

const quiet = (what: string) => (err: unknown) => console.warn(`[membros] ${what} falhou:`, err instanceof Error ? err.message : err);

export async function joinServer(shortCode: string): Promise<void> {
  await authedFetch("POST", `/api/v1/servers/${encodeURIComponent(norm(shortCode))}/members/me`);
}

export async function leaveServer(shortCode: string): Promise<void> {
  await authedFetch("DELETE", `/api/v1/servers/${encodeURIComponent(norm(shortCode))}/members/me`);
}

/** Registra de uma vez os servidores que a conta já tem na biblioteca (em lotes, se forem muitos). */
export async function syncMemberships(shortCodes: string[]): Promise<void> {
  const codes = [...new Set(shortCodes.map(norm))];
  for (let i = 0; i < codes.length; i += BULK_MAX) {
    await authedFetch("PUT", "/api/v1/memberships", { shortCodes: codes.slice(i, i + BULK_MAX) });
  }
}

export type ReportReason = "image" | "name_or_bio" | "other";

/** Denuncia o perfil de outro membro do servidor (o Worker confere que quem denuncia também é membro). */
export async function reportMember(shortCode: string, memberId: string, reason: ReportReason, note: string): Promise<void> {
  await authedFetch("POST", `/api/v1/servers/${encodeURIComponent(norm(shortCode))}/members/${encodeURIComponent(memberId)}/report`, { reason, note: note.trim() || undefined });
}

/** A lista de membros do servidor. Lança ApiCallError (403) se a conta não é membro dele. */
export function fetchServerMembers(shortCode: string): Promise<ServerMembersResult> {
  return authedFetch<ServerMembersResult>("GET", `/api/v1/servers/${encodeURIComponent(norm(shortCode))}/members`);
}

/**
 * Mantém a participação da conta nos servidores em dia: ao entrar na conta registra todos os servidores da biblioteca,
 * e depois acompanha cada servidor adicionado ou removido. Chamar uma vez ao montar o app; devolve a função de limpeza.
 */
export function startMembershipSync(): () => void {
  let userId: string | null = null;
  let known = new Set<string>();

  const apply = (state: ReturnType<typeof useAppStore.getState>) => {
    const uid = state.user?.id ?? null;
    const codes = state.knownServers.map((s) => norm(s.shortCode));
    if (uid !== userId) {
      userId = uid;
      known = new Set(codes);
      if (uid && codes.length > 0) syncMemberships(codes).catch(quiet("sincronização"));
      return;
    }
    if (!uid) return;
    const { added, removed } = diffServers(known, codes);
    known = new Set(codes);
    for (const c of added) joinServer(c).catch(quiet("entrada"));
    for (const c of removed) leaveServer(c).catch(quiet("saída"));
  };

  apply(useAppStore.getState());
  return useAppStore.subscribe(apply);
}

/**
 * A lista de membros de um servidor, atualizada de tempos em tempos enquanto `active` (e a janela visível). `null`
 * até a primeira resposta, e quando a conta não é membro (ou não está logada): aí não há o que mostrar.
 */
export function useServerMembers(shortCode: string | null, active: boolean): ServerMembersResult | null {
  const [data, setData] = useState<{ code: string; result: ServerMembersResult } | null>(null);

  useEffect(() => {
    if (!active || !shortCode) return;
    let cancelled = false;
    const code = norm(shortCode);

    async function tick() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const result = await fetchServerMembers(code);
        if (!cancelled) setData({ code, result });
      } catch (err) {
        // 403: a conta não é membro deste servidor, então não há lista para ela. Outros erros: fica com o que tinha.
        if (!cancelled && err instanceof ApiCallError && (err.status === 403 || err.status === 401)) setData(null);
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), MEMBERS_POLL_MS);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shortCode, active]);

  // Só vale a lista do servidor que está na tela agora (ao trocar de servidor, a anterior some na hora).
  return active && shortCode && data?.code === norm(shortCode) ? data.result : null;
}
