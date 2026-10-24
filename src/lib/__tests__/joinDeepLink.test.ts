import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-deep-link", () => ({ onOpenUrl: vi.fn(), getCurrent: vi.fn() }));
vi.mock("@/app/store", () => ({ useAppStore: { getState: () => ({ setMode: vi.fn(), setPendingJoinShortCode: vi.fn() }) } }));
vi.mock("@/app/diagnostics", () => ({ pushDiagnostic: vi.fn() }));

import { extractShortCode } from "../joinDeepLink";

describe("extractShortCode (cubicase://join/<código>)", () => {
  it("aceita código válido, ignora caminho/consulta e normaliza para maiúsculas", () => {
    expect(extractShortCode("cubicase://join/ABC234")).toBe("ABC234");
    expect(extractShortCode("cubicase://join/abc234?x=1#y")).toBe("ABC234");
    expect(extractShortCode("cubicase://join/ABC234/")).toBe("ABC234");
    expect(extractShortCode("CUBICASE://join/ABC234")).toBe("ABC234");
  });

  it("recusa o que não é um código do Worker (tamanho, símbolos, vazio) e outros esquemas", () => {
    for (const bad of [
      "cubicase://join/",
      "cubicase://join/AB",
      "cubicase://join/" + "A".repeat(13),
      "cubicase://join/AB C234",
      "cubicase://join/AB-C234",
      "cubicase://join/..%2F..",
      "cubicase://auth-callback#access_token=x",
      "https://evil.example/join/ABC234",
    ]) {
      expect(extractShortCode(bad), bad).toBeNull();
    }
  });
});
