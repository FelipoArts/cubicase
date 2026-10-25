import { describe, expect, it } from "vitest";
import { isInsideOneDrive } from "@/lib/backupsFolder";

describe("isInsideOneDrive", () => {
  it("reconhece pastas dentro do OneDrive (pessoal ou da empresa), em qualquer caixa", () => {
    expect(isInsideOneDrive("C:\\Users\\lipow\\OneDrive\\Documentos\\CubicaseBackups")).toBe(true);
    expect(isInsideOneDrive("C:\\Users\\a\\OneDrive - Empresa\\Backups")).toBe(true);
    expect(isInsideOneDrive("c:\\users\\a\\onedrive\\x")).toBe(true);
    expect(isInsideOneDrive("C:\\Users\\a\\OneDrive")).toBe(true);
  });

  it("não confunde outras pastas", () => {
    expect(isInsideOneDrive("D:\\Backups\\Cubicase")).toBe(false);
    expect(isInsideOneDrive("C:\\Users\\a\\Documents\\CubicaseBackups")).toBe(false);
    expect(isInsideOneDrive("C:\\MeuOneDriveFalso\\x")).toBe(false);
  });
});
