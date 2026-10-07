// ============================================================
// Login opcional (Supabase)
// ============================================================
// O app funciona 100% sem conta. Login só é disparado quando algo
// realmente precisa dele — um recurso pago, ou o usuário clicando em
// "Entrar" nas configurações (ver AppSettingsPanel.tsx, categoria "conta").
//
// Fluxo (ver docs/entrar/index.html para o outro lado):
//   1. requireAuth() abre https://cubicase.net/entrar/ no navegador do
//      sistema (mesmo padrão de src/lib/subscription.ts).
//   2. O usuário loga por magic link, Google ou Discord nessa página.
//   3. A página redireciona para cubicase://auth-callback#access_token=...
//   4. O SO entrega essa URL de volta pro app — via onOpenUrl (primeira
//      instância/cold start) ou via o evento "deep-link-received" que o
//      Rust emite quando uma segunda instância é disparada pelo clique
//      (ver o closure do single_instance em src-tauri/src/lib.rs).
//   5. setSession() aplica a sessão; supabase-js cuida de persistir e
//      renovar o token sozinho daí em diante.
// ============================================================

import { open } from "@tauri-apps/plugin-shell";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { supabase } from "@/lib/supabaseClient";
import { useAppStore, type AuthUser } from "@/app/store";
import { getLocale } from "@/i18n";

const LOGIN_URL = "https://cubicase.net/entrar/";
const REQUIRE_AUTH_TIMEOUT_MS = 5 * 60_000;

// Proteção contra "login CSRF": qualquer página web consegue abrir
// cubicase://auth-callback#access_token=...; sem isto, o app aplicaria tokens de um
// atacante e a vítima passaria a usar (e pagar/parear dispositivo na) conta dele.
// O login só vale se a URL de volta trouxer o `state` aleatório que ESTE app gerou ao
// abrir o navegador (a página /entrar/ o devolve no deep link). Guardado em
// localStorage com validade, para sobreviver ao app ser aberto pelo próprio deep link.
const PENDING_STATE_KEY = "cubicase-auth-pending";

function newAuthState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function savePendingState(state: string): void {
  try {
    localStorage.setItem(PENDING_STATE_KEY, JSON.stringify({ state, exp: Date.now() + REQUIRE_AUTH_TIMEOUT_MS }));
  } catch { /* storage indisponível: o login falha fechado (sem state válido) */ }
}

/** Consome o state pendente: true só se bater e estiver dentro da validade. Uso único. */
export function consumePendingState(received: string | null): boolean {
  let ok = false;
  try {
    const raw = localStorage.getItem(PENDING_STATE_KEY);
    if (raw && received) {
      const pending = JSON.parse(raw) as { state: string; exp: number };
      ok = pending.state === received && Date.now() < pending.exp;
    }
    if (ok) localStorage.removeItem(PENDING_STATE_KEY);
  } catch { ok = false; }
  return ok;
}

function toAuthUser(user: { id: string; email?: string | null }): AuthUser {
  return { id: user.id, email: user.email ?? "" };
}

export function parseTokensFromDeepLink(url: string): { access_token: string; refresh_token: string; state: string | null } | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;
  return { access_token, refresh_token, state: params.get("state") };
}

async function handleAuthCallbackUrl(url: string): Promise<void> {
  if (!url.startsWith("cubicase://auth-callback")) return;
  const tokens = parseTokensFromDeepLink(url);
  if (!tokens) {
    // Nunca logar a URL: ela carrega tokens de sessão.
    console.error("[auth] Deep link de login sem os tokens esperados.");
    return;
  }
  if (!consumePendingState(tokens.state)) {
    console.warn("[auth] Deep link de login ignorado: não corresponde a um login iniciado por este app.");
    return;
  }
  const { error } = await supabase.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  if (error) console.error("[auth] Falha ao aplicar sessão recebida do deep link:", error);
}

/**
 * Registra os listeners de autenticação (mudança de sessão + deep link de
 * volta do login). Chamar UMA vez ao montar o app (ver page.tsx) — retorna
 * a função de limpeza.
 */
export async function initAuthListener(): Promise<() => void> {
  const setUser = useAppStore.getState().setUser;

  // Sessão que já existia, persistida pelo supabase-js de uma execução anterior.
  const { data: { session } } = await supabase.auth.getSession();
  setUser(session?.user ? toAuthUser(session.user) : null);

  const { data: authSub } = supabase.auth.onAuthStateChange((_event, newSession) => {
    setUser(newSession?.user ? toAuthUser(newSession.user) : null);
  });

  // Cold start: se o app acabou de ser aberto pelo próprio deep link de login
  // (raro pra login — normalmente o app já está aberto quando se clica em
  // "Entrar" — mas o mesmo mecanismo vale), getCurrent() pega a URL dos
  // argumentos de linha de comando do processo. onOpenUrl sozinho só cobre o
  // app já rodando (ver comentário equivalente em src/lib/joinDeepLink.ts).
  try {
    const initialUrls = await getCurrent();
    if (initialUrls) for (const url of initialUrls) void handleAuthCallbackUrl(url);
  } catch (err) {
    console.error("[auth] Falha ao checar getCurrent():", err);
  }

  const unlistenOpenUrl = await onOpenUrl((urls) => {
    for (const url of urls) void handleAuthCallbackUrl(url);
  });

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenForwarded = await listen<string>("deep-link-received", (event) => {
    void handleAuthCallbackUrl(event.payload);
  });

  return () => {
    authSub.subscription.unsubscribe();
    unlistenOpenUrl();
    unlistenForwarded();
  };
}

/**
 * Garante que há um usuário logado, pedindo login se necessário. Se já
 * houver sessão, resolve na hora. Senão, abre o navegador e só resolve
 * quando o deep link de volta confirmar o login (ou rejeita depois de
 * REQUIRE_AUTH_TIMEOUT_MS sem resposta).
 */
export function requireAuth(): Promise<AuthUser> {
  return new Promise((resolve, reject) => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        resolve(toAuthUser(session.user));
        return;
      }

      const timer = setTimeout(() => {
        sub.subscription.unsubscribe();
        reject(new Error("Login cancelado: tempo esgotado."));
      }, REQUIRE_AUTH_TIMEOUT_MS);

      const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
        if (event === "SIGNED_IN" && newSession?.user) {
          clearTimeout(timer);
          sub.subscription.unsubscribe();
          resolve(toAuthUser(newSession.user));
        }
      });

      try {
        // ?lang faz a página de login abrir no idioma escolhido no app (ver docs/assets/i18n.js).
        const state = newAuthState();
        savePendingState(state);
        await open(`${LOGIN_URL}?lang=${getLocale() === "en" ? "en" : "pt"}&state=${state}`);
      } catch (err) {
        clearTimeout(timer);
        sub.subscription.unsubscribe();
        reject(err);
      }
    })();
  });
}

export async function logout(): Promise<void> {
  await supabase.auth.signOut();
}

/** Define (ou troca) a senha da conta já logada — login por senha continua opcional. */
export async function setPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

/** Provedores vinculados à conta logada (ex: ["email", "google"]), para exibir nas configurações. */
export async function getLinkedProviders(): Promise<string[]> {
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error || !data) return [];
  return data.identities.map((identity) => identity.provider);
}
