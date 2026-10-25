// ============================================================
// Painel Web Remoto (Cubicase Plus) — pareamento do dispositivo
// ============================================================
// Ver plans/remote-web-panel-plan.md. Gera (uma única vez) um device_token
// no Supabase para esta instalação e persiste localmente em
// panel_device.json — mesmo padrão de arquivo de config local já usado por
// network_session.json (ver CLAUDE.md): o backend Rust (panel_agent.rs) lê
// esse arquivo diretamente do disco para se autenticar no WebSocket do
// Worker, sem precisar falar com o Supabase ele mesmo.
//
// Só roda para quem já está logado E com Cubicase Plus ativo — nunca força
// login (login é opcional no resto do app, ver src/lib/auth.ts) nem cria um
// dispositivo para quem não tem o recurso.
// ============================================================

import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { hostname } from "@tauri-apps/plugin-os";
import { supabase } from "@/lib/supabaseClient";
import { getSubscriptionStatus, isSubscriptionActive } from "@/lib/subscription";

export interface PanelDevice {
  id: string;
  device_token: string;
  device_name: string;
  /** Conta dona do dispositivo (ausente nos arquivos antigos). Sem isso, trocar de conta herdaria o painel da anterior. */
  user_id?: string;
}

async function devicePath(): Promise<string> {
  return await join(await appLocalDataDir(), "panel_device.json");
}

export async function loadLocalPanelDevice(): Promise<PanelDevice | null> {
  const path = await devicePath();
  if (!(await exists(path))) return null;
  try {
    return JSON.parse(await readTextFile(path)) as PanelDevice;
  } catch {
    return null;
  }
}

/** Desfaz o pareamento local (sair da conta ou entrar em outra): o agente do painel para de se conectar. */
export async function clearLocalPanelDevice(): Promise<void> {
  const path = await devicePath();
  if (await exists(path)) await remove(path).catch(() => {});
}

async function saveLocalPanelDevice(device: PanelDevice): Promise<void> {
  await writeTextFile(await devicePath(), JSON.stringify(device, null, 2));
}

/**
 * Garante que esta instalação tem um dispositivo pareado para o painel web
 * remoto, se o usuário logado tiver Cubicase Plus ativo. Idempotente e
 * silenciosa (chamada de forma best-effort ao iniciar o app, ver page.tsx)
 * — não lança para quem não está logado ou não é Plus, só não faz nada.
 */
export async function ensurePanelDeviceIfEligible(): Promise<PanelDevice | null> {
  const existing = await loadLocalPanelDevice();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    // Sem conta logada não há dono para o painel: remove o pareamento que ficou da conta anterior.
    if (existing) await clearLocalPanelDevice();
    return null;
  }
  if (existing) {
    if (existing.user_id === session.user.id) return existing;
    await clearLocalPanelDevice(); // era de outra conta (ou de uma versão antiga, sem dono registrado)
  }

  const status = await getSubscriptionStatus().catch(() => null);
  if (!isSubscriptionActive(status)) return null;

  const deviceName = (await hostname().catch(() => null)) || "Meu computador";

  const { data, error } = await supabase
    .from("panel_devices")
    .insert({ user_id: session.user.id, device_name: deviceName })
    .select("id, device_token, device_name")
    .single();

  if (error || !data) {
    console.error("[panel] Falha ao registrar dispositivo do painel web:", error);
    return null;
  }

  const device: PanelDevice = { id: data.id, device_token: data.device_token, device_name: data.device_name, user_id: session.user.id };
  await saveLocalPanelDevice(device);
  return device;
}
