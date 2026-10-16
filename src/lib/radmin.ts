import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch } from "@tauri-apps/plugin-http";

// ============================================================
// Plano B: Radmin VPN
// ============================================================
// Quando a conexão direta não funciona, o Cubicase guia o uso do Radmin VPN. O Radmin não tem API nem linha de
// comando para criar/entrar numa rede (e o contrato dele proíbe engenharia reversa), então o app faz só o que o
// Windows permite verificar: o programa está instalado? conectado a uma rede? o host responde? E ajuda onde pode:
// instalar pelo winget, liberar o firewall, entregar o endereço pronto. O nome e a senha da rede NUNCA são
// guardados: o app não tem como saber se ainda valem. A verdade é sempre o teste de alcance ao host.
// ============================================================

/** Página oficial de download do Radmin VPN. */
export const RADMIN_DOWNLOAD_URL = "https://www.radmin-vpn.com/";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

export interface RadminStatus {
  installed: boolean;
  running: boolean;
  ip: string | null;
}

export const NO_RADMIN: RadminStatus = { installed: false, running: false, ip: null };

/** Endereço que o amigo digita no Minecraft pelo Radmin: IP do host + porta (omitida se for 25565). */
export function radminAddress(ip: string, port: number): string {
  return port === 25565 ? ip : `${ip}:${port}`;
}

// ---------------- fases (puras, testadas) ----------------

export type HostPhase = "install" | "network" | "firewall" | "ready";

/** Em que passo está quem hospeda. `firewallOk === null` = ainda verificando. */
export function hostPhase(status: RadminStatus, firewallOk: boolean | null): HostPhase {
  if (!status.installed) return "install";
  if (!status.ip) return "network";
  if (firewallOk === false) return "firewall";
  return "ready";
}

export type GuestPhase = "install" | "network" | "host-missing" | "checking" | "unreachable" | "ready";

/**
 * Em que passo está quem vai entrar. `hostIp` = IP do host no Radmin (publicado por ele), `reachable` = resultado
 * do último teste de conexão (null = ainda não testou).
 */
export function guestPhase(status: RadminStatus, hostIp: string | null, reachable: boolean | null): GuestPhase {
  if (!status.installed) return "install";
  if (!status.ip) return "network";
  if (!hostIp) return "host-missing";
  if (reachable === null) return "checking";
  return reachable ? "ready" : "unreachable";
}

// ---------------- sugestão de nome e senha (nunca guardada) ----------------

// Sem caracteres ambíguos (0/O, 1/l/I): a senha vai ser digitada à mão por quem não copiou.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function secureRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Senha aleatória para a rede do Radmin. `random` é injetável só para testes. */
export function generateNetworkPassword(length = 12, random: (n: number) => Uint8Array = secureRandomBytes): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length); // descarta bytes que enviesariam o resultado
  let out = "";
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte < limit) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

const NAME_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * Nome sugerido para a rede. O nome de uma rede do Radmin precisa ser único no mundo todo: com o código do
 * servidor (único por servidor) fica "cubicase-<código>"; sem ele, usa um sufixo aleatório. Chame UMA vez por
 * tela (o sufixo muda a cada chamada). `random` é injetável só para testes.
 */
export function suggestedNetworkName(shortCode?: string | null, random: (n: number) => Uint8Array = secureRandomBytes): string {
  const base = (shortCode ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (base) return `cubicase-${base}`;
  const limit = 256 - (256 % NAME_ALPHABET.length);
  let suffix = "";
  while (suffix.length < 6) {
    for (const byte of random(12)) {
      if (byte < limit) suffix += NAME_ALPHABET[byte % NAME_ALPHABET.length];
      if (suffix.length === 6) break;
    }
  }
  return `cubicase-${suffix}`;
}

// ---------------- chamadas ao app ----------------

export const getRadminStatus = () => invoke<RadminStatus>("get_radmin_status");
export const wingetAvailable = () => invoke<boolean>("radmin_winget_available").catch(() => false);
export const installRadmin = () => invoke<void>("install_radmin");
export const radminProbe = (host: string, port: number) => invoke<boolean>("radmin_probe", { host, port }).catch(() => false);
export const radminFirewallOk = () => invoke<boolean>("radmin_firewall_ok").catch(() => false);
export const allowRadminFirewall = () => invoke<void>("allow_radmin_firewall");

/** IP do host no Radmin e a porta do Minecraft, como a API Central tem agora (null se ele não está na rede do Radmin). */
export async function fetchHostRadmin(shortCode: string): Promise<{ ip: string | null; port: number | null } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/servers/${encodeURIComponent(shortCode)}`);
    if (!res.ok) return null;
    const session = (await res.json())?.data?.session ?? {};
    const ip = typeof session.radminIp === "string" ? session.radminIp : null;
    const port = typeof session.minecraftPort === "number" ? session.minecraftPort : null;
    return { ip, port };
  } catch {
    return null;
  }
}

// ---------------- hooks ----------------

/** Estado do Radmin neste computador, atualizado enquanto `active`. null = ainda lendo. */
export function useRadminStatus(active: boolean): { status: RadminStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<RadminStatus | null>(null);
  const refresh = useCallback(() => {
    getRadminStatus().then(setStatus).catch(() => setStatus(NO_RADMIN));
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, 3000);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<RadminStatus>("radmin-status", (e) => setStatus(e.payload)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      unlisten?.();
    };
  }, [active, refresh]);

  return { status, refresh };
}

/** O firewall já libera o Minecraft para a rede do Radmin? null = verificando. */
export function useFirewallOk(active: boolean): { ok: boolean | null; refresh: () => void } {
  const [ok, setOk] = useState<boolean | null>(null);
  const refresh = useCallback(() => {
    radminFirewallOk().then(setOk);
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  return { ok, refresh };
}

/** IP/porta do host no Radmin, relidos da API Central enquanto `active` (o host pode entrar na rede depois). */
export function useHostRadmin(shortCode: string | null, active: boolean): { ip: string | null; port: number | null } {
  const [info, setInfo] = useState<{ ip: string | null; port: number | null }>({ ip: null, port: null });
  useEffect(() => {
    if (!active || !shortCode) return;
    let cancelled = false;
    const load = () =>
      fetchHostRadmin(shortCode).then((r) => {
        if (!cancelled && r) setInfo(r);
      });
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [shortCode, active]);
  return info;
}

/** O host responde pelo Radmin? Testa a cada poucos segundos enquanto `active`. null = ainda não testou este endereço. */
export function useReachable(hostIp: string | null, port: number, active: boolean): boolean | null {
  // O resultado guarda de QUAL endereço é: trocar de host/porta volta a "ainda não testou" sem estado a resetar.
  const [result, setResult] = useState<{ key: string; ok: boolean } | null>(null);
  const key = hostIp ? `${hostIp}:${port}` : "";
  useEffect(() => {
    if (!active || !hostIp) return;
    let cancelled = false;
    const test = () =>
      radminProbe(hostIp, port).then((ok) => {
        if (!cancelled) setResult({ key: `${hostIp}:${port}`, ok });
      });
    test();
    const id = setInterval(test, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hostIp, port, active]);
  return key && result?.key === key ? result.ok : null;
}
