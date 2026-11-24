import { describe, it, expect } from "vitest";
import { isAccessDeniedError } from "../accessDenied";

describe("isAccessDeniedError", () => {
  it("reconhece acesso negado do Windows, do Rust e do Java", () => {
    expect(isAccessDeniedError("Acesso negado. (os error 5)")).toBe(true);
    expect(isAccessDeniedError(new Error("Access is denied. (os error 5)"))).toBe(true);
    expect(isAccessDeniedError("java.nio.file.AccessDeniedException: C:/x/level.dat")).toBe(true);
    expect(isAccessDeniedError("PermissionDenied")).toBe(true);
  });

  it("não confunde com outros erros (disco cheio, escopo do Tauri, arquivo em uso)", () => {
    expect(isAccessDeniedError("Não há espaço suficiente no disco. (os error 112)")).toBe(false);
    expect(isAccessDeniedError("forbidden path: C:/x")).toBe(false);
    expect(isAccessDeniedError("O arquivo está sendo usado por outro processo. (os error 32)")).toBe(false);
    expect(isAccessDeniedError(undefined)).toBe(false);
  });
});
