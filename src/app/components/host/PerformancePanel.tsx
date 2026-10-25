"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge, CheckCircle2, AlertTriangle, XOctagon, Loader2, ChevronDown, Settings2, Info } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import type { ServerStatus } from "@/app/store";
import { useT, type TKey } from "@/i18n";
import { usePerfStore, lagWarningsWithin, type PerfPoint } from "@/lib/perfMonitor";
import { analyzePerformance, type Finding } from "@/lib/perfAnalyzer";

// ============================================================
// PerformancePanel
// ============================================================
// TPS, tempo por tick, memória e CPU do servidor em execução, com um gráfico curto (última hora)
// e o diagnóstico "por que está travando?" (regras em src/lib/perfAnalyzer.ts). Os dados vêm do
// histórico em memória de src/lib/perfMonitor.ts, alimentado em page.tsx pelos eventos
// "mc-resource-sample" e "mc-perf".
// ============================================================

type Metric = "tps" | "cpu" | "ram";

interface Props {
  serverDir: string;
  serverStatus: ServerStatus;
  onOpenConfig: () => void;
}

const SAMPLE_SECONDS = 15;

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toString();
const gb = (mb: number) => (mb / 1024).toFixed(1).replace(/\.0$/, "");

function valueOf(p: PerfPoint, m: Metric): number | null {
  if (m === "tps") return p.tps;
  if (m === "cpu") return p.procCpuPct;
  return p.procRamMb;
}

function formatMetric(m: Metric, v: number): string {
  if (m === "tps") return fmt1(v);
  if (m === "cpu") return `${Math.round(v)}%`;
  return `${gb(v)} GB`;
}

function clockLabel(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const VERDICT_STYLE = {
  good: { icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50" },
  warning: { icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50" },
  bad: { icon: XOctagon, cls: "text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800/50" },
  collecting: { icon: Loader2, cls: "text-theme-secondary bg-theme-muted border-theme-card" },
} as const;

function Tile({ label, hint, value, sub }: { label: string; hint: string; value: string; sub?: string }) {
  return (
    <div className="bg-theme-muted border border-theme-card rounded-2xl px-4 py-3" title={hint}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-theme-secondary">{label}</div>
      <div className="text-2xl font-bold text-theme-primary tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-theme-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

const W = 640;
const H = 170;
const PAD = { l: 8, r: 12, t: 12, b: 12 };

function Chart({ points, metric, max, label, ariaLabel }: { points: PerfPoint[]; metric: Metric; max: number; label: string; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const n = points.length;
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - Math.min(Math.max(v / max, 0), 1)) * (H - PAD.t - PAD.b);

  // Linhas quebram onde não há valor (ex.: TPS ainda não medido).
  const segments: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  points.forEach((p, i) => {
    const v = valueOf(p, metric);
    if (v === null) { if (cur.length) segments.push(cur); cur = []; } else cur.push({ i, v });
  });
  if (cur.length) segments.push(cur);

  const lastSeg = segments[segments.length - 1];
  const lastPt = lastSeg?.[lastSeg.length - 1];
  const gridLines = [0, 0.5, 1].map((f) => PAD.t + f * (H - PAD.t - PAD.b));

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const frac = (e.clientX - r.left) / r.width;
    const vx = frac * W;
    const idx = Math.round(((vx - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, idx)));
  }

  const hp = hover !== null ? points[hover] : null;
  const hv = hp ? valueOf(hp, metric) : null;

  return (
    <div
      ref={wrapRef}
      className="relative text-indigo-500 touch-none"
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={ariaLabel}>
        {gridLines.map((gy, i) => (
          <line key={i} x1={PAD.l} x2={W - PAD.r} y1={gy} y2={gy} className="stroke-slate-300/60 dark:stroke-slate-600/50" strokeWidth={1} />
        ))}
        {segments.map((seg, si) => {
          const line = seg.map((s, k) => `${k === 0 ? "M" : "L"}${x(s.i).toFixed(1)} ${y(s.v).toFixed(1)}`).join(" ");
          const area = `${line} L${x(seg[seg.length - 1].i).toFixed(1)} ${H - PAD.b} L${x(seg[0].i).toFixed(1)} ${H - PAD.b} Z`;
          return (
            <g key={si}>
              <path d={area} fill="currentColor" opacity={0.1} />
              <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {lastPt && hover === null && (
          <circle cx={x(lastPt.i)} cy={y(lastPt.v)} r={4.5} fill="currentColor" className="stroke-white dark:stroke-slate-900" strokeWidth={2} />
        )}
        {hp && (
          <>
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={H - PAD.b} className="stroke-slate-400" strokeWidth={1} />
            {hv !== null && <circle cx={x(hover!)} cy={y(hv)} r={4.5} fill="currentColor" className="stroke-white dark:stroke-slate-900" strokeWidth={2} />}
          </>
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-theme-secondary tabular-nums px-1 -mt-1">
        <span>{formatMetric(metric, 0)}</span>
        <span>{formatMetric(metric, max)}</span>
      </div>
      {hp && (
        <div
          className="absolute top-1 pointer-events-none bg-theme-card border border-theme-card shadow-theme-card rounded-xl px-3 py-1.5 text-xs text-theme-primary whitespace-nowrap"
          style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translateX(${(x(hover!) / W) > 0.6 ? "-105%" : "5%"})` }}
        >
          <div className="font-bold tabular-nums">{label}: {hv !== null ? formatMetric(metric, hv) : "—"}</div>
          <div className="text-theme-secondary tabular-nums">{clockLabel(hp.t)}</div>
        </div>
      )}
    </div>
  );
}

function findingParams(f: Finding): Record<string, string | number> {
  return f.params;
}

export function PerformancePanel({ serverDir, serverStatus, onOpenConfig }: Props) {
  const { t } = useT();
  const points = usePerfStore((s) => s.points);
  const perf = usePerfStore((s) => s.perf);
  const sample = usePerfStore((s) => s.sample);
  const lagTimes = usePerfStore((s) => s.lagTimes);
  const [metric, setMetric] = useState<Metric>("tps");
  const [showTable, setShowTable] = useState(false);
  const [settings, setSettings] = useState<{ viewDistance?: number; simulationDistance?: number }>({});

  const running = serverStatus === "online" || serverStatus === "starting";

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    invoke<Record<string, string>>("read_server_properties", { serverDir })
      .then((props) => {
        if (cancelled) return;
        const num = (k: string) => { const v = parseInt(props[k] ?? "", 10); return Number.isFinite(v) ? v : undefined; };
        setSettings({ viewDistance: num("view-distance"), simulationDistance: num("simulation-distance") });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [running, serverDir]);

  const lastT = points.length ? points[points.length - 1].t : 0;
  const analysis = useMemo(
    () => analyzePerformance({
      points,
      perf,
      allocatedRamMb: sample?.allocatedRamMb ?? null,
      totalRamMb: sample?.totalRamMb ?? null,
      cores: sample?.cpuCores ?? null,
      lagWarnings5m: lagWarningsWithin(lagTimes, 5 * 60_000, lastT),
      settings,
    }),
    [points, perf, sample, lagTimes, lastT, settings],
  );

  if (!running) return null;

  const hasTps = points.some((p) => p.tps !== null);
  const activeMetric: Metric = metric === "tps" && !hasTps && perf?.source === "none" ? "cpu" : metric;
  const last = points.length ? points[points.length - 1] : null;
  const allocMb = sample?.allocatedRamMb ?? null;
  const maxFor: Record<Metric, number> = {
    tps: 20,
    cpu: 100,
    ram: Math.max(allocMb ?? 0, ...points.map((p) => p.procRamMb ?? 0), 1024),
  };
  const minutes = Math.max(1, Math.round((points.length * SAMPLE_SECONDS) / 60));
  const verdict = analysis.verdict;
  const VStyle = VERDICT_STYLE[verdict];
  const VIcon = VStyle.icon;
  const metricLabel: Record<Metric, string> = { tps: t("perf.chart.tps"), cpu: t("perf.chart.cpu"), ram: t("perf.chart.ram") };

  const vals = nums(points.map((p) => valueOf(p, activeMetric)));
  const ariaLabel = vals.length
    ? t("perf.chart.aria", {
        metric: metricLabel[activeMetric],
        min: minutes,
        min2: formatMetric(activeMetric, Math.min(...vals)),
        avg: formatMetric(activeMetric, vals.reduce((a, b) => a + b, 0) / vals.length),
        max: formatMetric(activeMetric, Math.max(...vals)),
      })
    : metricLabel[activeMetric];

  const msptVal = last?.mspt ?? perf?.msptAvg ?? null;
  const p99 = last?.p99 ?? perf?.msptP99 ?? null;

  return (
    <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
      <div>
        <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full inline-flex items-center gap-1.5">
          <Gauge className="w-3 h-3" />
          {t("perf.title")}
        </span>
        <h2 className="text-2xl font-bold text-theme-primary mt-2">{t("perf.subtitle")}</h2>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          label={t("perf.tile.tps")}
          hint={t("perf.tile.tpsHint")}
          value={last?.tps != null ? fmt1(last.tps) : "—"}
          sub={last?.tps == null && perf?.source === "none" ? t("perf.tile.tpsNone") : undefined}
        />
        <Tile
          label={t("perf.tile.mspt")}
          hint={t("perf.tile.msptHint")}
          value={msptVal !== null ? `${fmt1(msptVal)} ms` : "—"}
          sub={p99 !== null ? t("perf.tile.msptWorst", { p99: Math.round(p99) }) : undefined}
        />
        <Tile
          label={t("perf.tile.ram")}
          hint={t("perf.tile.ramHint")}
          value={last?.procRamMb != null ? `${gb(last.procRamMb)} GB` : "—"}
          sub={allocMb ? t("perf.tile.ramOf", { max: gb(allocMb) }) : undefined}
        />
        <Tile
          label={t("perf.tile.cpu")}
          hint={t("perf.tile.cpuHint")}
          value={last?.procCpuPct != null ? `${Math.round(last.procCpuPct)}%` : "—"}
          sub={t("perf.tile.cpuOf")}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1 bg-theme-muted p-1 rounded-2xl border border-theme-card">
            {(["tps", "cpu", "ram"] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                className={cn(
                  "px-3 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer",
                  activeMetric === m ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary",
                )}
              >
                {metricLabel[m]}
              </button>
            ))}
          </div>
          <span className="text-xs text-theme-secondary">{t("perf.chart.title", { min: minutes })}</span>
        </div>

        {points.length < 2 ? (
          <div className="text-center py-8 text-theme-secondary text-sm">{t("perf.chart.waiting")}</div>
        ) : (
          <>
            {activeMetric === "tps" && !hasTps && <p className="text-xs text-theme-secondary">{t("perf.chart.noTps")}</p>}
            <Chart points={points} metric={activeMetric} max={maxFor[activeMetric]} label={metricLabel[activeMetric]} ariaLabel={ariaLabel} />
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              className="text-xs font-bold text-theme-secondary hover:text-indigo-600 inline-flex items-center gap-1 cursor-pointer"
              aria-expanded={showTable}
            >
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showTable && "rotate-180")} />
              {t("perf.table.show")}
            </button>
            {showTable && (
              <div className="max-h-48 overflow-auto border border-theme-card rounded-xl">
                <table className="w-full text-xs text-theme-primary tabular-nums">
                  <thead className="bg-theme-muted text-theme-secondary sticky top-0">
                    <tr>
                      <th className="text-left font-bold px-3 py-1.5">{t("perf.table.time")}</th>
                      <th className="text-right font-bold px-3 py-1.5">{metricLabel[activeMetric]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...points].reverse().map((p) => {
                      const v = valueOf(p, activeMetric);
                      return (
                        <tr key={p.t} className="border-t border-theme-card">
                          <td className="px-3 py-1">{clockLabel(p.t)}</td>
                          <td className="px-3 py-1 text-right">{v !== null ? formatMetric(activeMetric, v) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-theme-card pt-5 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-lg font-bold text-theme-primary">{t("perf.diag.title")}</h3>
          <span className="text-xs text-theme-secondary">{t("perf.diag.window")}</span>
        </div>
        <div className={cn("flex items-center gap-2 px-4 py-3 rounded-2xl border text-sm font-bold", VStyle.cls)}>
          <VIcon className={cn("w-4 h-4 shrink-0", verdict === "collecting" && "animate-spin")} />
          {t(`perf.verdict.${verdict}` as TKey)}
        </div>
        {verdict === "collecting" && <p className="text-sm text-theme-secondary">{t("perf.diag.collecting")}</p>}
        {verdict !== "collecting" && analysis.findings.length === 0 && (
          <p className="text-sm text-theme-secondary">{t("perf.diag.nothing")}</p>
        )}
        <ul className="space-y-3">
          {analysis.findings.map((f) => {
            const detailKey = f.id === "heapNearLimit"
              ? (f.params.canRaise ? "perf.finding.heapNearLimit.detailRaise" : "perf.finding.heapNearLimit.detailNoRaise")
              : `perf.finding.${f.id}.detail`;
            const Icon = f.severity === "info" ? Info : f.severity === "serious" ? XOctagon : AlertTriangle;
            return (
              <li key={f.id} className="flex gap-3 bg-theme-muted border border-theme-card rounded-2xl p-4">
                <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", f.severity === "serious" ? "text-rose-500" : f.severity === "warning" ? "text-amber-500" : "text-theme-secondary")} />
                <div className="space-y-1 min-w-0">
                  <div className="text-sm font-bold text-theme-primary">{t(`perf.finding.${f.id}.title` as TKey, findingParams(f))}</div>
                  <p className="text-sm text-theme-secondary">{t(detailKey as TKey, findingParams(f))}</p>
                  {f.action === "openConfig" && (
                    <button
                      type="button"
                      onClick={onOpenConfig}
                      className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:underline cursor-pointer"
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                      {t("perf.action.openConfig")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function nums(v: (number | null)[]): number[] {
  return v.filter((x): x is number => x !== null && Number.isFinite(x));
}
