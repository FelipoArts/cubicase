import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { pushDiagnostic } from "@/app/diagnostics";
import { useAppStore } from "@/app/store";
import { t } from "@/i18n";

// ============================================================
// Permissão de rede do Windows (Firewall) para o cubicase-link
// ============================================================
// O transporte P2P abre portas e, na primeira vez, o Windows pergunta se o programa pode usar a rede. Aqui:
//  - ensureFirewallPrompted: faz essa pergunta aparecer num momento previsível (início do host / da conexão do
//    convidado), com uma explicação antes. Roda uma vez por instalação.
//  - offerFirewallIfBlocked: se a conexão caiu no relay e o Windows tem um BLOQUEIO para o programa (o que
//    acontece ao clicar em Cancelar na pergunta), oferece o botão que desfaz isso. Ver src-tauri/src/firewall.rs.
// ============================================================

/** Faz a pergunta do Windows aparecer agora, com uma explicação antes. Só na primeira vez; nunca lança. */
export async function ensureFirewallPrompted(): Promise<void> {
  const app = useAppStore.getState();
  if (app.firewallPrompted) return;
  app.setFirewallPrompted(true);
  pushDiagnostic({
    level: "info",
    source: t("diag.source.network"),
    title: t("firewall.prewarm.title"),
    message: t("firewall.prewarm.message"),
  });
  try {
    await invoke("prewarm_firewall");
  } catch {
    // sem isso o Windows pergunta na primeira conexão, como antes
  }
}

export type FirewallAllowState = "idle" | "working" | "done" | "cancelled" | "error";

interface FirewallHelpStore {
  open: boolean;
  state: FirewallAllowState;
  /** Já oferecemos nesta sessão (não insistir a cada reconexão). */
  offered: boolean;
  show: () => void;
  close: () => void;
  allow: () => Promise<void>;
}

export const useFirewallHelp = create<FirewallHelpStore>((set, get) => ({
  open: false,
  state: "idle",
  offered: false,
  show: () => set({ open: true, state: "idle", offered: true }),
  close: () => set({ open: false }),
  allow: async () => {
    if (get().state === "working") return;
    set({ state: "working" });
    try {
      await invoke("allow_firewall");
      set({ state: "done" });
    } catch (err) {
      set({ state: String(err).includes("cancelled") ? "cancelled" : "error" });
    }
  },
}));

/**
 * Chamar quando a conexão passou a usar o relay: se o Windows tem um bloqueio para o programa, abre a janela com
 * o botão "Permitir". Leitura sem administrador, no máximo uma vez por sessão; nunca lança.
 */
export async function offerFirewallIfBlocked(): Promise<void> {
  if (useFirewallHelp.getState().offered) return;
  try {
    const status = await invoke<string>("firewall_status");
    if (status === "blocked") useFirewallHelp.getState().show();
  } catch {
    // não deu para ler o Firewall: segue sem a oferta
  }
}
