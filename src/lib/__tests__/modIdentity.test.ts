import { describe, it, expect } from "vitest";
import { classifyIncoming, findDuplicates, countStatuses, type ModIdentity } from "../modIdentity";

const mod = (file_name: string, mod_id: string | null, version: string | null, enabled = true): ModIdentity => ({
  file_name,
  enabled,
  mod_id,
  version,
  loader: "fabric",
});

describe("findDuplicates", () => {
  it("agrupa o mesmo id em arquivos diferentes, mesmo com versões diferentes", () => {
    const d = findDuplicates([mod("sodium-0.5.8.jar", "sodium", "0.5.8"), mod("sodium-0.5.11.jar", "sodium", "0.5.11"), mod("lithium.jar", "lithium", "1")]);
    expect(d).toHaveLength(1);
    expect(d[0].modId).toBe("sodium");
    expect(d[0].files.map((f) => f.file_name)).toEqual(["sodium-0.5.8.jar", "sodium-0.5.11.jar"]);
  });

  it("ignora desabilitados e jars sem id", () => {
    expect(findDuplicates([mod("a.jar", "x", "1"), mod("b.jar.disabled", "x", "2", false)])).toEqual([]);
    expect(findDuplicates([mod("a.jar", null, null), mod("b.jar", null, null)])).toEqual([]);
  });
});

describe("classifyIncoming", () => {
  const existing = [mod("sodium-0.5.8.jar", "sodium", "0.5.8"), mod("old.jar.disabled", "oldmod", "1", false), mod("legacy.jar", null, null)];

  it("mesmo id e versão = idêntico, mesmo com outro nome de arquivo", () => {
    const r = classifyIncoming(existing, { filename: "sodium-fabric-0.5.8.jar", mod_id: "sodium", version: "0.5.8" });
    expect(r.status).toBe("identical");
    expect(r.existing?.file_name).toBe("sodium-0.5.8.jar");
  });

  it("mesmo id e versão diferente = conflito", () => {
    const r = classifyIncoming(existing, { filename: "sodium-0.5.11.jar", mod_id: "sodium", version: "0.5.11" });
    expect(r.status).toBe("conflict");
    expect(r.existing?.version).toBe("0.5.8");
  });

  it("versão desconhecida do mesmo id também é conflito (não dá para garantir que seja igual)", () => {
    expect(classifyIncoming(existing, { filename: "s.jar", mod_id: "sodium", version: null }).status).toBe("conflict");
  });

  it("mod desabilitado pelo host conta como presente", () => {
    expect(classifyIncoming(existing, { filename: "old.jar", mod_id: "oldmod", version: "1" }).status).toBe("identical");
    expect(classifyIncoming(existing, { filename: "old.jar", mod_id: "oldmod", version: "2" }).status).toBe("conflict");
  });

  it("sem id: compara o nome do arquivo", () => {
    expect(classifyIncoming(existing, { filename: "legacy.jar", mod_id: null, version: null }).status).toBe("identical");
    expect(classifyIncoming(existing, { filename: "novo.jar", mod_id: null, version: null }).status).toBe("new");
  });

  it("mesmo nome de arquivo com id diferente não sobrescreve em silêncio", () => {
    expect(classifyIncoming(existing, { filename: "sodium-0.5.8.jar", mod_id: "outra", version: "1" }).status).toBe("conflict");
  });

  it("nada em comum = novo", () => {
    expect(classifyIncoming(existing, { filename: "iris.jar", mod_id: "iris", version: "1" }).status).toBe("new");
  });
});

describe("countStatuses", () => {
  it("conta por status", () => {
    expect(countStatuses([{ status: "new" }, { status: "new" }, { status: "conflict" }, { status: "identical" }])).toEqual({ new: 2, identical: 1, conflict: 1 });
  });
});
