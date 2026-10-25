import { describe, expect, it } from "vitest";
import { analyzePerformance, type AnalysisInput } from "@/lib/perfAnalyzer";
import { lagWarningsWithin, processCpuOfMachine, usePerfStore, type PerfPoint } from "@/lib/perfMonitor";

function point(over: Partial<PerfPoint> = {}): PerfPoint {
  return { t: 0, tps: 20, mspt: 8, p99: 40, procRamMb: 2000, procCpuPct: 5, sysCpuPct: 20, sysFreeRamMb: 8000, players: 2, ...over };
}
const series = (n: number, over: Partial<PerfPoint> = {}) => Array.from({ length: n }, () => point(over));

function input(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return { points: series(8), perf: null, allocatedRamMb: 4096, totalRamMb: 16384, cores: 8, lagWarnings5m: 0, ...over };
}
const ids = (a: ReturnType<typeof analyzePerformance>) => a.findings.map((f) => f.id);

describe("analyzePerformance", () => {
  it("poucos dados: ainda coletando, sem palpite", () => {
    expect(analyzePerformance(input({ points: series(2) })).verdict).toBe("collecting");
    expect(analyzePerformance(input({ points: [] })).findings).toEqual([]);
  });

  it("servidor bem: 'tudo certo' e nenhuma causa inventada", () => {
    const a = analyzePerformance(input());
    expect(a.verdict).toBe("good");
    expect(a.findings).toEqual([]);
    expect(a.avgTps).toBe(20);
  });

  it("TPS baixo com o PC folgado e ~1 núcleo ocupado: gargalo da thread principal", () => {
    const a = analyzePerformance(input({ points: series(8, { tps: 12, procCpuPct: 14.5, sysCpuPct: 25, players: 3 }) }));
    expect(a.verdict).toBe("bad");
    expect(ids(a)).toContain("singleCore");
    expect(ids(a)).not.toContain("otherPrograms");
  });

  it("CPU do PC lotada mas não é do servidor: outro programa", () => {
    const a = analyzePerformance(input({ points: series(8, { tps: 14, procCpuPct: 8, sysCpuPct: 96 }) }));
    expect(ids(a)).toContain("otherPrograms");
    expect(ids(a)).not.toContain("singleCore");
  });

  it("RAM do servidor colada no limite com TPS caindo: sugere aumentar (se o PC tiver folga)", () => {
    const a = analyzePerformance(input({ points: series(8, { tps: 15, procRamMb: 4090 }), allocatedRamMb: 4096, totalRamMb: 16384 }));
    const f = a.findings.find((x) => x.id === "heapNearLimit")!;
    expect(f.params.canRaise).toBe(1);
    // sem folga no PC, não sugere aumentar
    const tight = analyzePerformance(input({ points: series(8, { tps: 15, procRamMb: 6100 }), allocatedRamMb: 6144, totalRamMb: 8192 }));
    expect(tight.findings.find((x) => x.id === "heapNearLimit")!.params.canRaise).toBe(0);
  });

  it("RAM livre do PC quase zerada é apontada mesmo que o TPS esteja bom", () => {
    const a = analyzePerformance(input({ points: series(8, { sysFreeRamMb: 700 }) }));
    expect(a.verdict).toBe("good");
    expect(ids(a)).toContain("sysRamLow");
  });

  it("RAM alocada demais para o PC é avisada (dica), e vira grave se já está travando", () => {
    expect(analyzePerformance(input({ allocatedRamMb: 15000 })).findings[0]).toMatchObject({ id: "ramOversized", severity: "warning" });
    const bad = analyzePerformance(input({ allocatedRamMb: 15000, points: series(8, { tps: 10 }) }));
    expect(bad.findings.find((f) => f.id === "ramOversized")!.severity).toBe("serious");
  });

  it("TPS médio ótimo mas com picos: 'picos', não 'lento'", () => {
    const a = analyzePerformance(input({ points: series(8, { tps: 19.9, p99: 320 }), lagWarnings5m: 1 }));
    expect(a.verdict).toBe("warning");
    expect(ids(a)).toContain("spikes");
  });

  it("muitos jogadores e distância de visão alta aparecem como contribuintes", () => {
    const a = analyzePerformance(input({ points: series(8, { tps: 16, players: 12 }), settings: { viewDistance: 16, simulationDistance: 12 } }));
    expect(ids(a)).toEqual(expect.arrayContaining(["manyPlayers", "viewDistance"]));
    const calm = analyzePerformance(input({ settings: { viewDistance: 16 } }));
    expect(ids(calm)).not.toContain("viewDistance");
  });

  it("travando sem causa identificável: diz isso, em vez de inventar uma", () => {
    const a = analyzePerformance(input({ points: series(8, { tps: 16, procCpuPct: 3, sysCpuPct: 10 }) }));
    expect(a.verdict).toBe("bad");
    expect(ids(a)).toEqual(["unknown"]);
  });

  it("sem fonte de TPS, usa os avisos de lag do Minecraft e avisa que não há TPS", () => {
    const none = { supported: false, source: "none", tps: null, msptAvg: null, msptP95: null, msptP99: null, updatedAtMs: null };
    const calm = analyzePerformance(input({ points: series(8, { tps: null, mspt: null, p99: null }), perf: none }));
    expect(calm.verdict).toBe("good");
    expect(ids(calm)).toEqual(["noSource"]);
    const lagging = analyzePerformance(input({ points: series(8, { tps: null, mspt: null, p99: null }), perf: none, lagWarnings5m: 6 }));
    expect(lagging.verdict).toBe("bad");
  });

  it("os achados vêm do mais grave para o menos grave e no máximo 5", () => {
    const a = analyzePerformance(input({
      points: series(8, { tps: 9, sysFreeRamMb: 500, procRamMb: 4090, procCpuPct: 14, sysCpuPct: 30, players: 20 }),
      settings: { viewDistance: 20 }, allocatedRamMb: 15000, lagWarnings5m: 9,
    }));
    const order = { serious: 0, warning: 1, info: 2 } as const;
    const sev = a.findings.map((f) => order[f.severity]);
    expect(sev).toEqual([...sev].sort((x, y) => x - y));
    expect(a.findings.length).toBeLessThanOrEqual(5);
  });
});

describe("perfMonitor", () => {
  it("CPU do processo é normalizada pelos núcleos (o valor cru soma os núcleos)", () => {
    expect(processCpuOfMachine(100, 8)).toBe(12.5);
    expect(processCpuOfMachine(400, 4)).toBe(100);
    expect(processCpuOfMachine(900, 4)).toBe(100);
    expect(processCpuOfMachine(undefined, 4)).toBeNull();
    expect(processCpuOfMachine(50, undefined)).toBe(50);
  });

  it("guarda no máximo 240 amostras e junta o TPS mais recente a cada uma", () => {
    const s = usePerfStore.getState();
    s.reset();
    s.setPerf({ supported: true, source: "paper-tps", tps: 19.1, msptAvg: 12, msptP95: 20, msptP99: 40, updatedAtMs: 1 });
    for (let i = 0; i < 250; i++) usePerfStore.getState().pushSample({ processRamMb: 1000 + i, processCpuPercent: 100, cpuCores: 4 }, 3, i);
    const st = usePerfStore.getState();
    expect(st.points).toHaveLength(240);
    expect(st.points[239]).toMatchObject({ tps: 19.1, mspt: 12, procRamMb: 1249, procCpuPct: 25, players: 3 });
    s.reset();
    expect(usePerfStore.getState().points).toEqual([]);
  });

  it("conta só os avisos 'Can't keep up!' e esquece os antigos", () => {
    const s = usePerfStore.getState();
    s.reset();
    s.noteLagLine("[10:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2000ms or 40 ticks behind", 1_000);
    s.noteLagLine("[10:00:01] [Server thread/INFO]: Steve joined the game", 2_000);
    s.noteLagLine("[10:20:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 500ms or 10 ticks behind", 20 * 60_000);
    const { lagTimes } = usePerfStore.getState();
    expect(lagTimes).toEqual([20 * 60_000]); // o de 15+ minutos atrás saiu
    expect(lagWarningsWithin([1, 100_000, 290_000], 300_000, 300_000)).toBe(3);
    expect(lagWarningsWithin([1, 100_000, 290_000], 150_000, 300_000)).toBe(1);
    s.reset();
  });
});
