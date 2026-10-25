// ============================================================
// Histórico de desempenho do servidor em execução
// ============================================================
// Junta o que o backend já emite: amostras de RAM/CPU (evento "mc-resource-sample", a cada ~15 s) e o TPS /
// tempo por tick lido do console (evento "mc-perf", ver src-tauri/src/perf.rs) num histórico curto em memória
// (~1 hora) que alimenta o painel de desempenho e o diagnóstico "por que está travando?".
// Nada é gravado em disco: o histórico é só da sessão atual do servidor.
// ============================================================

import { create } from "zustand";

/** TPS e tempo por tick, como o backend informa. */
export interface PerfState {
  /** Há alguma fonte de TPS para este servidor. */
  supported: boolean;
  /** "paper-tps" | "forge-tps" | "tick-query" | "" (descobrindo) | "none". */
  source: string;
  tps: number | null;
  msptAvg: number | null;
  msptP95: number | null;
  msptP99: number | null;
  updatedAtMs: number | null;
}

/** Amostra de RAM/CPU (evento "mc-resource-sample"). */
export interface ResourceSampleEvent {
  totalRamMb?: number;
  availableRamMb?: number;
  cpuUsagePercent?: number;
  cpuCores?: number;
  allocatedRamMb?: number;
  processRamMb?: number;
  processCpuPercent?: number;
}

export interface PerfPoint {
  t: number;
  tps: number | null;
  mspt: number | null;
  /** Pior tick recente (P99), em ms. */
  p99: number | null;
  /** RAM do processo do servidor (MB). */
  procRamMb: number | null;
  /** CPU do processo em % do computador INTEIRO (o valor cru soma os núcleos: 100% = 1 núcleo). */
  procCpuPct: number | null;
  /** CPU do computador inteiro, em %. */
  sysCpuPct: number | null;
  sysFreeRamMb: number | null;
  players: number;
}

const MAX_POINTS = 240; // 240 amostras × 15 s = 1 hora
const LAG_MEMORY_MS = 15 * 60 * 1000;
const CANT_KEEP_UP = /Can't keep up! Is the server overloaded\?/i;

interface PerfStore {
  points: PerfPoint[];
  perf: PerfState | null;
  /** Última amostra de recursos (para total de RAM, núcleos e RAM alocada). */
  sample: ResourceSampleEvent | null;
  /** Quando o Minecraft acusou "Can't keep up!" (últimos 15 min). */
  lagTimes: number[];
  reset: () => void;
  setPerf: (p: PerfState | null) => void;
  pushSample: (s: ResourceSampleEvent, players: number, now?: number) => void;
  noteLagLine: (line: string, now?: number) => void;
}

/** O processo do servidor em % do computador inteiro (0-100). */
export function processCpuOfMachine(raw: number | undefined, cores: number | undefined): number | null {
  if (raw === undefined || !Number.isFinite(raw)) return null;
  const c = cores && cores > 0 ? cores : 1;
  return Math.min(100, Math.max(0, raw / c));
}

export const usePerfStore = create<PerfStore>((set) => ({
  points: [],
  perf: null,
  sample: null,
  lagTimes: [],
  reset: () => set({ points: [], perf: null, sample: null, lagTimes: [] }),
  setPerf: (p) => set({ perf: p }),
  pushSample: (s, players, now = Date.now()) =>
    set((state) => {
      const perf = state.perf;
      const point: PerfPoint = {
        t: now,
        tps: perf?.tps ?? null,
        mspt: perf?.msptAvg ?? null,
        p99: perf?.msptP99 ?? null,
        procRamMb: s.processRamMb ?? null,
        procCpuPct: processCpuOfMachine(s.processCpuPercent, s.cpuCores),
        sysCpuPct: s.cpuUsagePercent ?? null,
        sysFreeRamMb: s.availableRamMb ?? null,
        players,
      };
      return { sample: s, points: [...state.points, point].slice(-MAX_POINTS) };
    }),
  noteLagLine: (line, now = Date.now()) => {
    if (!CANT_KEEP_UP.test(line)) return;
    set((state) => ({ lagTimes: [...state.lagTimes.filter((t) => now - t <= LAG_MEMORY_MS), now] }));
  },
}));

/** Quantos avisos "Can't keep up!" nos últimos `windowMs`. */
export function lagWarningsWithin(lagTimes: number[], windowMs: number, now = Date.now()): number {
  return lagTimes.filter((t) => now - t <= windowMs).length;
}
