import { beforeEach, describe, expect, it, vi } from "vitest";

// Login por deep link: só vale com o `state` que ESTE app gerou (anti login-CSRF).
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ onOpenUrl: vi.fn(), getCurrent: vi.fn() }));
vi.mock("@/lib/supabaseClient", () => ({ supabase: { auth: {} } }));
vi.mock("@/app/store", () => ({ useAppStore: { getState: () => ({ setUser: vi.fn() }) } }));
vi.mock("@/i18n", () => ({ getLocale: () => "pt-BR" }));

const { consumePendingState, parseTokensFromDeepLink } = await import("@/lib/auth");

beforeEach(() => store.clear());

const pending = (state: string, expOffsetMs: number) =>
  store.set("cubicase-auth-pending", JSON.stringify({ state, exp: Date.now() + expOffsetMs }));

describe("consumePendingState", () => {
  it("aceita o state gerado pelo app, uma única vez", () => {
    pending("abc123", 60_000);
    expect(consumePendingState("abc123")).toBe(true);
    expect(consumePendingState("abc123")).toBe(false); // uso único
  });

  it("recusa state ausente, errado, expirado ou sem login pendente", () => {
    expect(consumePendingState("abc123")).toBe(false); // nada pendente (ex.: página de um atacante)
    pending("abc123", 60_000);
    expect(consumePendingState(null)).toBe(false);
    expect(consumePendingState("outro")).toBe(false);
    expect(store.has("cubicase-auth-pending")).toBe(true); // tentativa errada não consome o pendente
    pending("abc123", -1);
    expect(consumePendingState("abc123")).toBe(false);
  });
});

describe("parseTokensFromDeepLink", () => {
  it("lê tokens e state do fragmento", () => {
    const r = parseTokensFromDeepLink("cubicase://auth-callback#access_token=A&refresh_token=B&state=S");
    expect(r).toEqual({ access_token: "A", refresh_token: "B", state: "S" });
  });
  it("sem tokens devolve null; sem state devolve state null", () => {
    expect(parseTokensFromDeepLink("cubicase://auth-callback")).toBeNull();
    expect(parseTokensFromDeepLink("cubicase://auth-callback#access_token=A")).toBeNull();
    expect(parseTokensFromDeepLink("cubicase://auth-callback#access_token=A&refresh_token=B")?.state).toBeNull();
  });
});
