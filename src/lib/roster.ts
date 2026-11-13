// ============================================================
// Lista de membros do servidor (Fase 2 do perfil do jogador)
// ============================================================
// Quem está conectado ao servidor agora, com o perfil público de quem entrou com a conta do Cubicase. Serve ao
// host e ao convidado: o Rust sabe o código do servidor e o token de link da sessão P2P atual (`get_roster_target`)
// e a API confere esse token na própria sala (ver api/src/roster.ts). Sem sessão conectada não há o que consultar.
// ============================================================

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { API_BASE } from "@/lib/apiBase";
import type { UserProfile } from "@/lib/profileCatalog";

export interface RosterMember {
  /** "host" ou o id atribuído pela sala. */
  id: string;
  role: "host" | "guest";
  /** É esta pessoa (mesma sessão que pediu a lista). */
  self: boolean;
  /** null: sem conta ou sem perfil criado. */
  profile: UserProfile | null;
  /** Cubicase Plus ativo. */
  plus: boolean;
}

interface RosterTarget {
  shortCode: string;
  signalToken: string;
}

/** De quanto em quanto tempo a lista é atualizada enquanto a tela está à vista. */
export const ROSTER_POLL_MS = 15_000;

/** Busca a lista agora. `null` quando não há sessão conectada; lança erro se a API ou a rede falharem. */
export async function fetchRoster(): Promise<RosterMember[] | null> {
  const target = await invoke<RosterTarget | null>("get_roster_target");
  if (!target) return null;
  const res = await fetch(`${API_BASE}/api/v1/link/roster/${encodeURIComponent(target.shortCode)}`, {
    headers: { Authorization: `Bearer ${target.signalToken}` },
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: { members?: RosterMember[] } } | null;
  if (!res.ok || !json?.success || !Array.isArray(json.data?.members)) throw new Error(`roster HTTP ${res.status}`);
  return json.data.members;
}

/**
 * Mantém a lista de membros atualizada enquanto `active` for verdadeiro (e a janela estiver visível). Devolve `null`
 * até a primeira resposta e quando não há sessão; numa falha passageira de rede mantém a última lista conhecida.
 */
export function useRoster(active: boolean): RosterMember[] | null {
  const [members, setMembers] = useState<RosterMember[] | null>(null);

  useEffect(() => {
    if (!active) { setMembers(null); return; }
    let cancelled = false;

    async function tick() {
      if (typeof document !== "undefined" && document.hidden) return; // janela em segundo plano: não gasta chamada
      try {
        const next = await fetchRoster();
        if (!cancelled) setMembers(next);
      } catch {
        /* sem rede ou API fora: fica com o que já tinha */
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), ROSTER_POLL_MS);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);

  return members;
}
