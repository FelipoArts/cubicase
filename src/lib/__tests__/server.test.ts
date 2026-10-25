import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks mínimos: só o que renameServer/getBackupsDir de fato tocam
// (@tauri-apps/api/path e @tauri-apps/plugin-fs). O resto de server.ts (Mojang,
// Forge/Fabric/Paper, JRE) não é exercitado por estes testes, então não
// precisa de mock — só não pode ser CHAMADO sem um Tauri de verdade.
const documentDirMock = vi.fn(() => Promise.resolve("/fake/docs"));
vi.mock("@tauri-apps/api/path", () => ({
  documentDir: () => documentDirMock(),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

const existsMock = vi.fn();
const renameMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (...args: unknown[]) => existsMock(...args),
  rename: (...args: unknown[]) => renameMock(...args),
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  size: vi.fn(),
}));

// A pasta de backups (padrão ou escolhida pela pessoa) é decidida pelo Rust: aqui só interessa que renameServer
// peça para mover a subpasta e trate a falha sem desfazer o rename do servidor.
const renameServerBackupsMock = vi.fn();
vi.mock("@/lib/backupsFolder", () => ({
  backupsDirFor: (name: string) => Promise.resolve(`/fake/backups/${name}`),
  renameServerBackups: (...args: unknown[]) => renameServerBackupsMock(...args),
}));

const { renameServer } = await import("@/lib/server");

beforeEach(() => {
  documentDirMock.mockClear();
  existsMock.mockReset();
  renameMock.mockReset();
  renameServerBackupsMock.mockReset();
  renameServerBackupsMock.mockResolvedValue(false);
});

describe("renameServer", () => {
  it("mesmo nome (só espaços a mais) não faz nada — nem chama rename", async () => {
    const result = await renameServer("MeuServidor", "  MeuServidor  ");
    expect(result).toEqual({ name: "MeuServidor", path: "/fake/docs/CubicaseServers/MeuServidor", backupsMigrationFailed: false });
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("nome vazio é rejeitado antes de tocar no sistema de arquivos", async () => {
    await expect(renameServer("Foo", "   ")).rejects.toThrow();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("rejeita caracteres proibidos do Windows", async () => {
    await expect(renameServer("Foo", "Bar/Baz")).rejects.toThrow();
    await expect(renameServer("Foo", 'Bar"Baz')).rejects.toThrow();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("rejeita ponto no final do nome", async () => {
    // Espaço no final não chega a ser testável aqui: `renameServer` já dá
    // `.trim()` no valor ANTES de validar (silenciosamente apara espaço a
    // mais no começo/fim, o que é o comportamento correto pra um campo de
    // texto) — só um ponto sobrevive ao trim pra esta checagem pegar.
    await expect(renameServer("Foo", "Bar.")).rejects.toThrow();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("rejeita nomes reservados do Windows (com ou sem extensão)", async () => {
    await expect(renameServer("Foo", "CON")).rejects.toThrow();
    await expect(renameServer("Foo", "com1")).rejects.toThrow();
    await expect(renameServer("Foo", "NUL.txt")).rejects.toThrow();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("não rejeita nomes que só COMEÇAM parecido com um reservado", async () => {
    // "Console" não é "CON" — o regex não pode dar falso positivo por prefixo.
    renameMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue(false);
    await expect(renameServer("Foo", "Console")).resolves.toMatchObject({ name: "Console" });
  });

  it("rejeita colisão com o nome de outro servidor já conhecido (case-insensitive), incluindo importados", async () => {
    // "OutroServidor" pode ser um servidor IMPORTADO (fora de CubicaseServers) —
    // o sistema de arquivos sozinho não bloquearia essa colisão, por isso a
    // checagem explícita contra `existingNames` é necessária.
    await expect(renameServer("Foo", "outroservidor", ["OutroServidor"])).rejects.toThrow();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("não confunde o PRÓPRIO nome atual com uma colisão (self-rename não deveria estar em existingNames, mas ainda assim não trava igual)", async () => {
    renameMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue(false);
    // "Foo" (nome atual) não está na lista de outros nomes — simula o chamador
    // corretamente excluindo o próprio servidor de existingNames.
    await expect(renameServer("Foo", "Bar", ["Baz", "Qux"])).resolves.toMatchObject({ name: "Bar" });
  });

  it("renomeia com sucesso quando não há pasta de backups pra migrar", async () => {
    renameMock.mockResolvedValue(undefined);
    renameServerBackupsMock.mockResolvedValue(false); // nenhuma subpasta de backups do nome antigo

    const result = await renameServer("Foo", "Bar", []);

    expect(result).toEqual({ name: "Bar", path: "/fake/docs/CubicaseServers/Bar", backupsMigrationFailed: false });
    // Só o rename da pasta do servidor.
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith("/fake/docs/CubicaseServers/Foo", "/fake/docs/CubicaseServers/Bar");
  });

  it("migra a pasta de backups junto (pelo Rust, que sabe onde ela está)", async () => {
    renameMock.mockResolvedValue(undefined);
    renameServerBackupsMock.mockResolvedValue(true);

    const result = await renameServer("Foo", "Bar", []);

    expect(result.backupsMigrationFailed).toBe(false);
    expect(renameMock).toHaveBeenCalledTimes(1); // o rename dos backups não passa mais pelo plugin de arquivos
    expect(renameServerBackupsMock).toHaveBeenCalledWith("Foo", "Bar");
  });

  it("reporta backupsMigrationFailed=true sem desfazer o rename do servidor, se só a migração dos backups falhar", async () => {
    renameMock.mockResolvedValue(undefined);
    renameServerBackupsMock.mockRejectedValue(new Error("arquivo travado"));

    const result = await renameServer("Foo", "Bar", []);

    expect(result).toMatchObject({ name: "Bar", backupsMigrationFailed: true });
  });

  it("propaga um erro claro se o rename da pasta do servidor falhar (ex: nome já em uso por outro servidor PADRÃO)", async () => {
    renameMock.mockRejectedValue(new Error("Access is denied"));
    await expect(renameServer("Foo", "Bar", [])).rejects.toThrow();
    // Não deveria nem tentar migrar backups se o rename principal falhou.
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});
