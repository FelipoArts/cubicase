// ============================================================
// Troca de código do servidor — leva junto os recursos pagos
// ============================================================
// Quando o app não consegue provar que é dono do código na API Central (ver
// ensure_server_ownership no Rust), ele registra o servidor com um código novo.
// Link de convite e endereço de conexão personalizados (Cubicase Plus) ficam
// presos ao registro ANTIGO — sem este passo, pararem de funcionar do nada.
// O Worker deixa a MESMA conta que criou cada nome movê-lo para o servidor novo.
// ============================================================

import { getServerSlug, setServerSlug } from "@/lib/inviteLink";
import { getServerConnectName, setConnectName } from "@/lib/connectAddress";

export interface CarryOverResult {
  /** Nada personalizado no código antigo: nada a mover. */
  hadCustomNames: boolean;
  moved: boolean;
  /** Havia algo a mover, mas não deu (sem login, sem Plus, sem rede...). */
  failed: boolean;
}

/** Move link de convite e endereço personalizados do código antigo para o novo. Nunca lança. */
export async function carryCustomNamesToNewCode(oldCode: string, newCode: string): Promise<CarryOverResult> {
  const [slug, connectName] = await Promise.all([
    getServerSlug(oldCode).catch(() => null),
    getServerConnectName(oldCode).catch(() => null),
  ]);
  if (!slug && !connectName) return { hadCustomNames: false, moved: false, failed: false };

  let failed = false;
  let moved = false;
  if (slug) {
    try {
      await setServerSlug(newCode, slug);
      moved = true;
    } catch {
      failed = true;
    }
  }
  if (connectName) {
    try {
      await setConnectName(newCode, connectName);
      moved = true;
    } catch {
      failed = true;
    }
  }
  return { hadCustomNames: true, moved, failed };
}
