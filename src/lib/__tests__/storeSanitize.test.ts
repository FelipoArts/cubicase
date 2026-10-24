import { describe, it, expect } from "vitest";
import { sanitizePersisted } from "@/app/store";

describe("sanitizePersisted (localStorage corrompido ou de versão antiga)", () => {
  it("mantém o que está certo", () => {
    const ok = { importedServerPaths: ["C:\a"], minecraftPort: 25565, logs: ["x"], mcLogsByServer: { s: ["linha"] }, mode: "host" };
    expect(sanitizePersisted(ok)).toEqual(ok);
  });

  it("descarta campos com tipo errado em vez de derrubar o app depois", () => {
    const bad = {
      importedServerPaths: "C:\a", // string no lugar de lista: .includes/.map quebrariam
      logs: [1, 2],
      knownServers: {},
      minecraftPort: "25565",
      backupRetentionCount: NaN,
      mcLogsByServer: { bom: ["a"], ruim: "x", pior: [1] },
    };
    expect(sanitizePersisted(bad)).toEqual({ mcLogsByServer: { bom: ["a"] } });
  });

  it("entrada que nem é objeto vira vazia", () => {
    for (const v of [null, undefined, "x", 3, [], true]) expect(sanitizePersisted(v)).toEqual({});
  });
});
