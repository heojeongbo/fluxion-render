/**
 * Automated many-chart benchmark. Renders N follow-clock streaming charts with
 * REALISTIC defaults (external axes on, bounds/ticks emission on, uncapped
 * render fps — i.e. what a dashboard gets without tuning) and measures:
 *
 *   - main thread: rAF inter-frame intervals over a sampling window
 *     (mean fps, p50/p95/p99, jank ratio = share of intervals > 33.4 ms)
 *   - workers: aggregated RENDER_STATS (renders/s, busy ms/s across all hosts)
 *
 * Runs automatically on load: `warmup` ms of ignored spin-up, then `duration`
 * ms of sampling, then writes the result JSON to `window.__benchResult` (for a
 * Playwright runner — see `scripts/bench.mjs`) and renders it on the page.
 *
 * Query params: `?charts=60&rate=25&duration=15000&warmup=5000`
 */
import type { FluxionHost } from "@heojeongbo/fluxion-render";
import {
  axisGridLayer,
  FluxionCanvas,
  lineLayer,
  type RenderStats,
  useFluxionStream,
  useTimeOrigin,
} from "@heojeongbo/fluxion-render/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { THEME } from "../../../shared/ui/theme";

const JANK_THRESHOLD_MS = 33.4; // two missed 60 Hz frames

function numParam(name: string, fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read once per page load — each bench run is a fresh navigation.
const PARAMS = {
  charts: numParam("charts", 60),
  rate: numParam("rate", 25), // samples/sec per chart
  duration: numParam("duration", 15_000),
  warmup: numParam("warmup", 5_000),
  // A/B levers: `maxFps=20` caps the worker render rate; `emitBounds=0`
  // silences the per-frame worker→main BOUNDS_UPDATE traffic. Both default to
  // the library defaults (uncapped / on) so the base bench stays "untuned".
  maxFps: numParam("maxFps", 0) || undefined,
  emitBounds: new URLSearchParams(window.location.search).get("emitBounds") !== "0",
  // Cost-attribution levers (default on = the untuned worst case):
  // `axes=0` drops the external axis canvases, `axes=inline` draws axes into
  // the main-canvas margins (single surface), `labels=0` turns off in-plot
  // tick labels, `grid=0` turns off grid lines.
  axes: new URLSearchParams(window.location.search).get("axes") !== "0",
  inlineAxes: new URLSearchParams(window.location.search).get("axes") === "inline",
  labels: new URLSearchParams(window.location.search).get("labels") !== "0",
  grid: new URLSearchParams(window.location.search).get("grid") !== "0",
  // `renderer=webgl` opts charts into the WebGL backend.
  renderer:
    new URLSearchParams(window.location.search).get("renderer") === "webgl"
      ? ("webgl" as const)
      : ("2d" as const),
};

const COLORS = ["#4fc3f7", "#80ffa0", "#ffb060", "#f48fb1", "#ce93d8", "#80cbc4"];

interface BenchResult {
  params: typeof PARAMS;
  userAgent: string;
  dpr: number;
  main: {
    frames: number;
    meanFps: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    jankRatio: number;
  };
  worker: {
    statsReports: number;
    rendersPerSec: number;
    busyMsPerSec: number;
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
  return sorted[idx]!;
}

const BenchChart = memo(function BenchChart({
  index,
  onReady,
}: {
  index: number;
  onReady: (index: number, host: FluxionHost) => void;
}) {
  const color = COLORS[index % COLORS.length]!;
  const freqHz = 0.3 + (index % 13) * 0.2;
  const phase = (index % 19) * 0.33;
  const timeOrigin = useTimeOrigin();
  const [host, setHost] = useState<FluxionHost | null>(null);

  const layers = useMemo(
    () => [
      axisGridLayer("axis", {
        xMode: "time",
        timeWindowMs: 5000,
        timeOrigin,
        yMode: "auto",
        gridColor: THEME.chart.gridColor,
        axisColor: THEME.chart.axisColor,
        labelColor: THEME.chart.labelColor,
        showXLabels: PARAMS.labels,
        showYLabels: PARAMS.labels,
        showXGrid: PARAMS.grid,
        showYGrid: PARAMS.grid,
      }),
      lineLayer("line", { color, lineWidth: 1, capacity: 1024 }),
    ],
    [timeOrigin, color],
  );

  useFluxionStream({
    host,
    intervalMs: 1000 / PARAMS.rate,
    // One process-wide timer fans out to every chart.
    shared: true,
    trackRate: false,
    setup: (h) => h.line("line"),
    tick: (t, line) => {
      line.push({
        t,
        y:
          Math.sin((t / 1000) * freqHz * Math.PI * 2 + phase) * 0.8 +
          Math.sin(t * 0.011 + index) * 0.05,
      });
      return 1;
    },
  });

  return (
    <div
      style={{
        position: "relative",
        minWidth: 0,
        minHeight: 0,
        background: THEME.panel.background,
        border: `1px solid ${THEME.page.border}`,
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <FluxionCanvas
        externalAxes={PARAMS.axes}
        inlineAxes={PARAMS.inlineAxes}
        layers={layers}
        hostOptions={{
          bgColor: THEME.chart.canvasBg,
          // Worker render-load reporting for the bench (off by default in prod).
          emitRenderStats: true,
          maxFps: PARAMS.maxFps,
          emitBounds: PARAMS.emitBounds,
          renderer: PARAMS.renderer,
        }}
        onReady={(h) => {
          setHost(h);
          onReady(index, h);
        }}
      />
    </div>
  );
});

type Phase = "warmup" | "sampling" | "done";

export function BenchDemoPage() {
  const [phase, setPhase] = useState<Phase>("warmup");
  const [result, setResult] = useState<BenchResult | null>(null);

  const statsUnsubsRef = useRef(new Map<number, () => void>());
  const samplingRef = useRef(false);
  const workerAccRef = useRef({ renders: 0, busyMs: 0, reports: 0 });

  // Hosts come online staggered; subscribe each as it becomes ready. The
  // sampling gate (samplingRef) makes late subscriptions harmless.
  const onChartReady = (index: number, host: FluxionHost) => {
    statsUnsubsRef.current.get(index)?.();
    statsUnsubsRef.current.set(
      index,
      host.onRenderStats((s: RenderStats) => {
        if (!samplingRef.current) return;
        const acc = workerAccRef.current;
        acc.renders += s.renders;
        acc.busyMs += s.busyMs;
        acc.reports += 1;
      }),
    );
  };

  useEffect(() => {
    const frameTimes: number[] = [];
    let raf = 0;
    const loop = (ts: number) => {
      if (samplingRef.current) frameTimes.push(ts);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    let samplingStart = 0;
    const warmupTimer = setTimeout(() => {
      samplingStart = performance.now();
      samplingRef.current = true;
      setPhase("sampling");
    }, PARAMS.warmup);

    const doneTimer = setTimeout(() => {
      samplingRef.current = false;
      const samplingSec = (performance.now() - samplingStart) / 1000;
      cancelAnimationFrame(raf);

      const intervals: number[] = [];
      for (let i = 1; i < frameTimes.length; i++) {
        intervals.push(frameTimes[i]! - frameTimes[i - 1]!);
      }
      intervals.sort((a, b) => a - b);
      const meanMs =
        intervals.reduce((sum, v) => sum + v, 0) / Math.max(1, intervals.length);
      const acc = workerAccRef.current;

      const res: BenchResult = {
        params: PARAMS,
        userAgent: navigator.userAgent,
        dpr: window.devicePixelRatio,
        main: {
          frames: frameTimes.length,
          meanFps: 1000 / meanMs,
          p50Ms: percentile(intervals, 50),
          p95Ms: percentile(intervals, 95),
          p99Ms: percentile(intervals, 99),
          maxMs: intervals.length ? intervals[intervals.length - 1]! : Number.NaN,
          jankRatio:
            intervals.filter((v) => v > JANK_THRESHOLD_MS).length /
            Math.max(1, intervals.length),
        },
        worker: {
          statsReports: acc.reports,
          rendersPerSec: acc.renders / samplingSec,
          busyMsPerSec: acc.busyMs / samplingSec,
        },
      };
      setResult(res);
      setPhase("done");
      (window as Window & { __benchResult?: BenchResult }).__benchResult = res;
    }, PARAMS.warmup + PARAMS.duration);

    const unsubs = statsUnsubsRef.current;
    return () => {
      clearTimeout(warmupTimer);
      clearTimeout(doneTimer);
      cancelAnimationFrame(raf);
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
    };
  }, []);

  const cols = Math.max(1, Math.round(Math.sqrt((PARAMS.charts * 4) / 3)));

  return (
    <div
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "8px 16px",
          borderBottom: `1px solid ${THEME.page.border}`,
          background: THEME.panel.background,
          fontSize: 12,
          color: THEME.page.textSecondary,
          flexShrink: 0,
        }}
      >
        <strong style={{ color: THEME.page.textPrimary }}>
          Bench: {PARAMS.charts} charts × {PARAMS.rate} Hz
        </strong>
        <span>
          phase: <strong style={{ color: THEME.page.textPrimary }}>{phase}</strong>
        </span>
        {result && (
          <span data-bench-done="true">
            {result.main.meanFps.toFixed(1)} fps · p95 {result.main.p95Ms.toFixed(1)} ms ·
            jank {(result.main.jankRatio * 100).toFixed(1)}% · worker{" "}
            {result.worker.rendersPerSec.toFixed(0)} renders/s /{" "}
            {result.worker.busyMsPerSec.toFixed(0)} busy ms/s
          </span>
        )}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: 6,
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridAutoRows: "1fr",
          gap: 3,
          background: THEME.page.background,
        }}
      >
        {Array.from({ length: PARAMS.charts }, (_, i) => (
          <BenchChart key={i} index={i} onReady={onChartReady} />
        ))}
      </div>
    </div>
  );
}
