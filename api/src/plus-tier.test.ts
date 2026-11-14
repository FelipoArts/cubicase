// ============================================================
// Testes do badge de tempo de assinatura: níveis, regra dos 7 dias e leitura
// ============================================================

import { describe, expect, it } from "vitest";
import {
  GRACE_MS, TIER_IDS, applyActive, applyEnded, continuousMs, tierForDuration, viewOf, type StreakState,
} from "./plus-tier";

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 0, 1);

describe("tierForDuration", () => {
  it("segue os limites aprovados (0, 1, 3, 6, 12, 18, 24, 36 meses de 30 dias)", () => {
    expect(tierForDuration(0)).toBe("wood");
    expect(tierForDuration(29 * DAY)).toBe("wood");
    expect(tierForDuration(30 * DAY)).toBe("stone");
    expect(tierForDuration(89 * DAY)).toBe("stone");
    expect(tierForDuration(90 * DAY)).toBe("iron");
    expect(tierForDuration(180 * DAY)).toBe("gold");
    expect(tierForDuration(360 * DAY)).toBe("redstone");
    expect(tierForDuration(540 * DAY)).toBe("diamond");
    expect(tierForDuration(720 * DAY)).toBe("emerald");
    expect(tierForDuration(1080 * DAY)).toBe("netherite");
    expect(tierForDuration(5000 * DAY)).toBe("netherite");
  });

  it("os 8 níveis existem na ordem certa", () => {
    expect([...TIER_IDS]).toEqual(["wood", "stone", "iron", "gold", "redstone", "diamond", "emerald", "netherite"]);
  });

  it("quem assina o plano anual já está em Redstone depois de um ano", () => {
    expect(tierForDuration(365 * DAY)).toBe("redstone");
  });
});

describe("applyActive", () => {
  it("primeira assinatura abre a sequência", () => {
    const s = applyActive(null, T0, T0 + 30 * DAY)!;
    expect(s).toEqual({ streakStartedMs: T0, countedMs: 0, segmentStartMs: T0, lastActiveEndMs: T0 + 30 * DAY });
  });

  it("renovar a tempo só estende o pagamento e o trecho continua", () => {
    const first = applyActive(null, T0, T0 + 30 * DAY)!;
    const renewed = applyActive(first, T0 + 30 * DAY - 1000, T0 + 60 * DAY)!;
    expect(renewed.segmentStartMs).toBe(T0);
    expect(renewed.lastActiveEndMs).toBe(T0 + 60 * DAY);
    expect(renewed.streakStartedMs).toBe(T0);
  });

  it("voltar dentro de 7 dias preserva o progresso e o tempo parado não conta", () => {
    const first = applyActive(null, T0, T0 + 30 * DAY)!; // paga os primeiros 30 dias
    const back = applyActive(first, T0 + 30 * DAY + 5 * DAY, T0 + 65 * DAY)!; // volta 5 dias depois do fim
    expect(back.streakStartedMs).toBe(T0);
    expect(back.countedMs).toBe(30 * DAY);
    expect(back.segmentStartMs).toBe(T0 + 35 * DAY);
    // 30 dias antes + 30 dias do novo período = 60 dias contínuos, sem os 5 dias do buraco
    expect(continuousMs(back, T0 + 65 * DAY)).toBe(60 * DAY);
  });

  it("voltar exatamente no limite de 7 dias ainda preserva", () => {
    const first = applyActive(null, T0, T0 + 30 * DAY)!;
    const back = applyActive(first, T0 + 30 * DAY + GRACE_MS, T0 + 70 * DAY)!;
    expect(back.countedMs).toBe(30 * DAY);
  });

  it("voltar depois de 7 dias zera tudo", () => {
    const first = applyActive(null, T0, T0 + 30 * DAY)!;
    const later = T0 + 30 * DAY + GRACE_MS + 1000;
    const back = applyActive(first, later, later + 30 * DAY)!;
    expect(back).toEqual({ streakStartedMs: later, countedMs: 0, segmentStartMs: later, lastActiveEndMs: later + 30 * DAY });
  });

  it("evento sem período futuro (reenvio antigo) não muda nada", () => {
    const first = applyActive(null, T0, T0 + 30 * DAY)!;
    expect(applyActive(first, T0 + 40 * DAY, T0 + 30 * DAY)).toBe(first); // fim no passado
    expect(applyActive(null, T0, T0)).toBeNull();
    expect(applyActive(first, T0, Number.NaN)).toBe(first);
  });
});

describe("applyEnded", () => {
  it("cancelamento imediato encurta o período pago", () => {
    const s = applyActive(null, T0, T0 + 30 * DAY)!;
    const ended = applyEnded(s, T0 + 10 * DAY)!;
    expect(ended.lastActiveEndMs).toBe(T0 + 10 * DAY);
    expect(continuousMs(ended, T0 + 50 * DAY)).toBe(10 * DAY);
  });

  it("cancelar no fim do período não muda nada (já venceria sozinho)", () => {
    const s = applyActive(null, T0, T0 + 30 * DAY)!;
    expect(applyEnded(s, T0 + 31 * DAY)).toEqual(s);
  });

  it("sem estado, continua sem estado", () => {
    expect(applyEnded(null, T0)).toBeNull();
  });
});

describe("viewOf", () => {
  const sub = (days: number): StreakState => applyActive(null, T0, T0 + days * DAY)!;

  it("sem estado não há badge", () => {
    expect(viewOf(null, T0)).toEqual({ phase: "none", tier: null, days: 0, graceEndsAt: null });
  });

  it("ativo: mostra o nível do tempo contínuo até agora", () => {
    const s = sub(365); // anual
    expect(viewOf(s, T0 + 1 * DAY)).toMatchObject({ phase: "active", tier: "wood", days: 1 });
    expect(viewOf(s, T0 + 100 * DAY)).toMatchObject({ phase: "active", tier: "iron" });
    expect(viewOf(s, T0 + 364 * DAY)).toMatchObject({ phase: "active", tier: "redstone" });
  });

  it("depois do fim do pagamento: janela de 7 dias, sem badge mas com o nível guardado e o prazo", () => {
    const s = sub(200); // ~6,6 meses → Ouro
    const v = viewOf(s, T0 + 200 * DAY + 2 * DAY);
    expect(v.phase).toBe("grace");
    expect(v.tier).toBe("gold");
    expect(v.graceEndsAt).toBe(new Date(T0 + 207 * DAY).toISOString());
  });

  it("passou dos 7 dias: perdeu o progresso", () => {
    const s = sub(200);
    expect(viewOf(s, T0 + 200 * DAY + 7 * DAY + 1000)).toEqual({ phase: "none", tier: null, days: 0, graceEndsAt: null });
  });

  it("o tempo parado não faz o nível subir", () => {
    const s = sub(60); // 60 dias pagos → Pedra
    const grace = viewOf(s, T0 + 60 * DAY + 5 * DAY);
    expect(grace.tier).toBe("stone");
    expect(grace.days).toBe(60);
  });

  it("história completa: assina, deixa vencer, volta em 5 dias e passa para o nível seguinte", () => {
    let s = applyActive(null, T0, T0 + 60 * DAY)!; // 60 dias → Pedra
    s = applyActive(s, T0 + 65 * DAY, T0 + 65 * DAY + 60 * DAY)!; // volta no 5º dia da janela
    const v = viewOf(s, T0 + 65 * DAY + 40 * DAY); // 60 + 40 = 100 dias contínuos
    expect(v).toMatchObject({ phase: "active", tier: "iron", days: 100 });
  });
});
