// ============================================================
// "Por que está travando?" — diagnóstico por regras sobre o histórico de desempenho
// ============================================================
// Sem IA e sem adivinhação: cada achado vem de uma regra com limiares conhecidos e só aparece quando os
// números sustentam. Quando o servidor está bem, o veredito é "tudo certo" e nenhuma causa é inventada.
// Entrada: o histórico de src/lib/perfMonitor.ts + dados fixos do servidor (RAM alocada, distância de visão...).
// ============================================================

import type { PerfPoint, PerfState } from "@/lib/perfMonitor";

export type Verdict = "collecting" | "good" | "warning" | "bad";

export type FindingId =
  | "sysRamLow"
  | "ramOversized"
  | "heapNearLimit"
  | "otherPrograms"
  | "singleCore"
  | "manyPlayers"
  | "viewDistance"
  | "spikes"
  | "unknown"
  | "noSource";

export interface Finding {
  id: FindingId;
  severity: "serious" | "warning" | "info";
  /** Números que a mensagem cita (já arredondados). */
  params: Record<string, string | number>;
  /** Botão que a interface pode oferecer junto do achado. */
  action?: "openConfig" | "openMods";
}

export interface AnalysisInput {
  points: PerfPoint[];
  perf: PerfState | null;
  /** RAM máxima dada ao servidor (MB) e RAM total do computador (MB). */
  allocatedRamMb: number | null;
  totalRamMb: number | null;
  cores: number | null;
  /** Quantos "Can't keep up!" nos últimos 5 minutos. */
  lagWarnings5m: number;
  settings?: { viewDistance?: number; simulationDistance?: number };
  modCount?: number;
}

export interface Analysis {
  verdict: Verdict;
  findings: Finding[];
  avgTps: number | null;
  minTps: number | null;
  avgMspt: number | null;
  p99: number | null;
}

/** Quantas amostras recentes entram na análise (8 × 15 s = 2 minutos). */
export const WINDOW = 8;

const OS_RESERVED_RAM_MB = 2048;
const HIGH_PLAYERS = 8;

const nums = (v: (number | null)[]): number[] => v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
const avg = (v: number[]): number | null => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const gb = (mb: number) => (mb / 1024).toFixed(1).replace(/\.0$/, "");
const SEVERITY_ORDER: Record<Finding["severity"], number> = { serious: 0, warning: 1, info: 2 };

export function analyzePerformance(input: AnalysisInput): Analysis {
  const win = input.points.slice(-WINDOW);
  const empty: Analysis = { verdict: "collecting", findings: [], avgTps: null, minTps: null, avgMspt: null, p99: null };
  if (win.length < 3) return empty;

  const tpsList = nums(win.map((p) => p.tps));
  const avgTps = avg(tpsList);
  const minTps = tpsList.length ? Math.min(...tpsList) : null;
  const avgMspt = avg(nums(win.map((p) => p.mspt)));
  const p99List = nums(win.map((p) => p.p99));
  const p99 = p99List.length ? Math.max(...p99List) : null;
  const tpsKnown = avgTps !== null;
  const lag = input.lagWarnings5m;

  let verdict: Verdict;
  if (tpsKnown) {
    if (avgTps! < 17 || (minTps! < 12 && avgTps! < 19)) verdict = "bad";
    else if (avgTps! < 19.5 || lag >= 2 || (p99 !== null && p99 >= 150)) verdict = "warning";
    else verdict = "good";
  } else {
    verdict = lag >= 5 ? "bad" : lag >= 1 ? "warning" : "good";
  }
  const struggling = verdict !== "good";

  const findings: Finding[] = [];
  const last = win[win.length - 1];
  const total = input.totalRamMb ?? null;
  const allocated = input.allocatedRamMb ?? null;

  // --- memória do computador / RAM dada ao servidor (valem mesmo com o servidor aparentemente bem) ---
  if (total && last.sysFreeRamMb !== null && last.sysFreeRamMb / total < 0.08) {
    findings.push({ id: "sysRamLow", severity: "serious", params: { free: gb(last.sysFreeRamMb), total: gb(total) } });
  }
  if (total && allocated && allocated > total - OS_RESERVED_RAM_MB) {
    findings.push({ id: "ramOversized", severity: struggling ? "serious" : "warning", params: { allocated: gb(allocated), total: gb(total) }, action: "openConfig" });
  }
  if (struggling && allocated) {
    const nearLimit = win.filter((p) => p.procRamMb !== null && p.procRamMb >= allocated * 0.97).length;
    if (nearLimit >= 4) {
      const headroom = total ? total - OS_RESERVED_RAM_MB - allocated : 0;
      findings.push({
        id: "heapNearLimit",
        severity: "serious",
        params: { allocated: gb(allocated), canRaise: headroom >= 1024 ? 1 : 0, max: total ? gb(total - OS_RESERVED_RAM_MB) : "?" },
        action: "openConfig",
      });
    }
  }

  // --- CPU ---
  const sysCpu = avg(nums(win.map((p) => p.sysCpuPct)));
  const procCpu = avg(nums(win.map((p) => p.procCpuPct)));
  if (struggling) {
    if (sysCpu !== null && sysCpu >= 85 && procCpu !== null && procCpu <= sysCpu * 0.5) {
      findings.push({ id: "otherPrograms", severity: "serious", params: { sys: Math.round(sysCpu), server: Math.round(procCpu) } });
    } else if (procCpu !== null && input.cores && sysCpu !== null && sysCpu < 70 && (procCpu * input.cores) >= 70 && (tpsKnown ? avgTps! < 19.5 : true)) {
      // O Minecraft roda o jogo numa thread só: ~1 núcleo ocupado com o PC folgado = gargalo da thread principal.
      findings.push({ id: "singleCore", severity: "serious", params: { cores: input.cores }, action: "openMods" });
    }
    const players = last.players;
    if (players >= HIGH_PLAYERS) findings.push({ id: "manyPlayers", severity: "warning", params: { players } });
    const vd = input.settings?.viewDistance;
    const sd = input.settings?.simulationDistance;
    if ((vd !== undefined && vd >= 12) || (sd !== undefined && sd >= 10)) {
      findings.push({ id: "viewDistance", severity: "warning", params: { view: vd ?? 0, simulation: sd ?? 0 }, action: "openConfig" });
    }
    if (tpsKnown && avgTps! >= 19 && (lag >= 1 || (p99 !== null && p99 >= 150))) {
      findings.push({ id: "spikes", severity: "warning", params: { p99: p99 !== null ? Math.round(p99) : 0, count: lag } });
    }
    if (!findings.some((f) => f.severity !== "info")) findings.push({ id: "unknown", severity: "info", params: {}, action: "openMods" });
  }

  if (!tpsKnown) findings.push({ id: "noSource", severity: "info", params: { lag } });

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { verdict, findings: findings.slice(0, 5), avgTps, minTps, avgMspt, p99 };
}
