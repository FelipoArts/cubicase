import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { pushDiagnostic } from "@/app/diagnostics";
import { t } from "@/i18n";

// ============================================================
// Auto-atualização
// ============================================================
// Checagem silenciosa contra o endpoint configurado em tauri.conf.json
// (plugins.updater.endpoints — hoje um latest.json publicado via GitHub
// Releases). Falha na checagem não deve incomodar o usuário (rede
// instável, offline, etc): fica só no histórico de diagnósticos, não
// como toast. Update disponível/erro de instalação já é relevante o
// bastante pra aparecer na UI (ver UpdateBanner).
// ============================================================

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

/** Portão de abertura: o app só mostra a interface depois de checar (e instalar) a atualização — ver StartupUpdateGate. */
export type StartupPhase = "checking" | "updating" | "open";

/** Quanto o app espera pela checagem ao abrir. Passou disso (rede lenta/offline), abre normalmente e tenta de novo depois. */
export const STARTUP_CHECK_TIMEOUT_MS = 4000;

/** Espera mínima depois de uma falha antes de aceitar "tentar de novo" (evita martelar o servidor de updates). */
export const UPDATE_RETRY_COOLDOWN_MS = 5000;

interface UpdaterState {
  phase: UpdaterPhase;
  version: string | null;
  notes: string | null;
  progress: number;
  dismissed: boolean;
  update: Update | null;
  /** Quando a última tentativa falhou (ms desde a época) — base do cooldown do botão. */
  lastFailureAt: number | null;
  /** true durante o cooldown pós-falha — só para a UI (a trava de verdade usa lastFailureAt). */
  cooling: boolean;
  /** Portão de abertura (ver StartupPhase). Começa em "checking" e vira "open" quando o app pode aparecer. */
  startup: StartupPhase;
  /** A checagem da abertura chegou a uma resposta (com ou sem versão nova)? Se não, o app refaz a checagem sozinho logo depois. */
  startupCheckOk: boolean;
  /** Ao abrir: checa a atualização e, havendo, baixa, instala e reinicia ANTES de mostrar o app. Nunca trava: erro/demora abre normalmente. */
  runStartupUpdate: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  /** Refaz a checagem e tenta instalar de novo, sem precisar fechar o app. */
  retryInstall: () => Promise<void>;
  dismiss: () => void;
}

// Trava síncrona: `set({ phase })` do zustand também é síncrono, mas o `await`
// entre a checagem e a instalação abriria uma janela em que dois cliques rápidos
// passariam pelo teste de fase. Este flag fecha essa janela.
let busy = false;
// A abertura roda uma vez só (o React em dev monta os efeitos duas vezes).
let startupRun: Promise<void> | null = null;

/** Só para testes: a abertura é de uma vez só por execução do app. */
export function resetStartupForTests() {
  startupRun = null;
}

/** `check()` com limite de tempo: quem espera não fica preso a uma rede que não responde. */
function checkWithTimeout(ms: number): Promise<Update | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    check().then(
      (u) => { clearTimeout(timer); resolve(u); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export const useUpdaterStore = create<UpdaterState>((set, get) => {
  function fail(e: unknown) {
    set({ phase: "error", lastFailureAt: Date.now(), cooling: true });
    setTimeout(() => set({ cooling: false }), UPDATE_RETRY_COOLDOWN_MS + 50);
    pushDiagnostic({
      level: "warning",
      title: t("update.installFailed.title"),
      message: t("update.installFailed.message"),
      detail: String(e),
      source: t("update.source"),
      kind: "update_failed",
    });
  }

  // Baixa, instala e reinicia. Quem chama já segurou `busy`.
  async function runInstall(update: Update) {
    set({ phase: "downloading", progress: 0, dismissed: false });
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({ progress: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0 });
        } else if (event.event === "Finished") {
          set({ progress: 100 });
        }
      });
      set({ phase: "ready", lastFailureAt: null });
      await relaunch();
    } catch (e) {
      fail(e);
    }
  }

  return {
    phase: "idle",
    version: null,
    notes: null,
    progress: 0,
    dismissed: false,
    update: null,
    lastFailureAt: null,
    cooling: false,
    startup: "checking",
    startupCheckOk: false,

    runStartupUpdate: () => {
      startupRun ??= (async () => {
        let update: Update | null;
        try {
          update = await checkWithTimeout(STARTUP_CHECK_TIMEOUT_MS);
        } catch (e) {
          // Sem internet, rede lenta ou fora do Tauri: abre o app e a checagem normal tenta de novo em seguida.
          set({ startup: "open", startupCheckOk: false });
          pushDiagnostic({ level: "info", title: t("update.checkFailed.title"), message: t("update.checkFailed.message"), detail: String(e), source: t("update.source") });
          return;
        }
        if (!update) {
          set({ startup: "open", startupCheckOk: true });
          return;
        }
        set({ phase: "available", version: update.version, notes: update.body ?? null, update, dismissed: false, startup: "updating", startupCheckOk: true });
        busy = true;
        try {
          await runInstall(update);
        } finally {
          busy = false;
        }
        // Instalou: o app reinicia e a tela de atualização fica até lá. Falhou: abre na versão atual, com o botão de tentar de novo.
        if (get().phase !== "ready") set({ startup: "open" });
      })();
      return startupRun;
    },

    checkForUpdates: async () => {
      if (busy || get().phase === "checking" || get().phase === "downloading" || get().phase === "ready") return;
      set({ phase: "checking" });
      try {
        const update = await check();
        if (update) {
          set({ phase: "available", version: update.version, notes: update.body ?? null, update, dismissed: false });
        } else {
          set({ phase: "idle", update: null, version: null });
        }
      } catch (e) {
        // Se já havia um update conhecido (ex.: falha anterior), mantém o botão visível.
        set({ phase: get().update ? "error" : "idle" });
        pushDiagnostic({
          level: "info",
          title: t("update.checkFailed.title"),
          message: t("update.checkFailed.message"),
          detail: String(e),
          source: t("update.source"),
        });
      }
    },

    installAndRestart: async () => {
      const { update, phase } = get();
      if (!update || busy || phase === "downloading" || phase === "ready" || phase === "checking") return;
      busy = true;
      try {
        await runInstall(update);
      } finally {
        busy = false;
      }
    },

    retryInstall: async () => {
      const { phase, lastFailureAt } = get();
      if (busy || phase === "downloading" || phase === "ready" || phase === "checking") return;
      if (lastFailureAt && Date.now() - lastFailureAt < UPDATE_RETRY_COOLDOWN_MS) return;
      busy = true;
      try {
        // O objeto `Update` de uma tentativa que falhou pode estar em estado
        // inconsistente (download pela metade), então pede um novo ao servidor.
        set({ phase: "checking" });
        let fresh: Update | null;
        try {
          fresh = await check();
        } catch (e) {
          fail(e);
          return;
        }
        if (!fresh) {
          // Já está na última versão (ou a release foi retirada): some o botão.
          set({ phase: "idle", update: null, version: null, notes: null, lastFailureAt: null });
          return;
        }
        set({ version: fresh.version, notes: fresh.body ?? null, update: fresh });
        await runInstall(fresh);
      } finally {
        busy = false;
      }
    },

    dismiss: () => set({ dismissed: true }),
  };
});
