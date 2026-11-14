import { describe, expect, it } from "vitest";
import { PLUS_TIERS, tierProgress } from "../profileCatalog";

describe("tierProgress", () => {
  it("no primeiro dia está em Madeira e faltam 30 dias para a Pedra", () => {
    const p = tierProgress(0);
    expect(p.current.id).toBe("wood");
    expect(p.next?.id).toBe("stone");
    expect(p.daysToNext).toBe(30);
    expect(p.fraction).toBe(0);
  });

  it("no meio do caminho a barra marca a fração entre os dois níveis", () => {
    const p = tierProgress(60); // Pedra (30) → Ferro (90): 30 de 60 dias
    expect(p.current.id).toBe("stone");
    expect(p.next?.id).toBe("iron");
    expect(p.daysToNext).toBe(30);
    expect(p.fraction).toBeCloseTo(0.5);
  });

  it("no dia exato do limite já está no nível novo", () => {
    expect(tierProgress(90).current.id).toBe("iron");
    expect(tierProgress(89).current.id).toBe("stone");
    expect(tierProgress(89).daysToNext).toBe(1);
  });

  it("no último nível não há próximo e a barra está cheia", () => {
    const p = tierProgress(5000);
    expect(p.current.id).toBe("netherite");
    expect(p.next).toBeNull();
    expect(p.daysToNext).toBe(0);
    expect(p.fraction).toBe(1);
  });

  it("valores inválidos viram zero", () => {
    expect(tierProgress(-5).current.id).toBe("wood");
    expect(tierProgress(Number.NaN).daysToNext).toBe(30);
  });

  it("os limites de exibição batem com os níveis aprovados", () => {
    expect(PLUS_TIERS.map((t) => t.months)).toEqual([0, 1, 3, 6, 12, 18, 24, 36]);
  });
});
