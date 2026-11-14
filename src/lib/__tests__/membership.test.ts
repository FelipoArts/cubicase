import { describe, expect, it } from "vitest";
import { diffServers } from "../membership";

describe("diffServers", () => {
  it("separa o que foi adicionado do que foi removido, sem diferenciar maiúsculas", () => {
    expect(diffServers(["abc123", "DEF456"], ["ABC123", "GHI789"])).toEqual({ added: ["GHI789"], removed: ["DEF456"] });
  });

  it("listas iguais não mudam nada", () => {
    expect(diffServers(["A1", "B2"], ["b2", "a1"])).toEqual({ added: [], removed: [] });
    expect(diffServers([], [])).toEqual({ added: [], removed: [] });
  });

  it("ignora espaços e repetições", () => {
    expect(diffServers([], [" abc ", "ABC", "x1"])).toEqual({ added: ["ABC", "X1"], removed: [] });
  });

  it("o primeiro carregamento da biblioteca vira só adições", () => {
    expect(diffServers([], ["A1", "B2"]).added).toEqual(["A1", "B2"]);
  });
});
