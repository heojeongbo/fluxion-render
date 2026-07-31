import type { FluxionHost, LineSample } from "@heojeongbo/fluxion-render";
import {
  axisGridLayer,
  FluxionCanvas,
  lineLayer,
  useTimeOrigin,
} from "@heojeongbo/fluxion-render/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { THEME } from "../../../shared/ui/theme";

const qs = new URLSearchParams(window.location.search);
const CHART_COUNT = Number(qs.get("charts")) || 40;
const INITIAL_PAUSE = qs.get("pause") !== "0"; // default on; ?pause=0 to compare
const TARGET_HZ = 60;
const WINDOW_MS = 5000;
const RETENTION_MS = 12_000; // ring covers well past the window
const CELL_H = 200;
const COLORS = ["#4fc3f7", "#80ffa0", "#ffb060", "#ff80c0", "#b090ff"];

type LineHandle = ReturnType<FluxionHost["line"]>;
interface Feed {
  index: number;
  freq: number;
  line: LineHandle;
}

// Bench aggregator (read by scripts/scroll-bench.mjs). Worker render duty summed
// across every host's onRenderStats since the last reset — a paused (off-screen)
// engine stops firing stats, so it naturally drops out of the total.
const agg = { busyMs: 0, renders: 0 };

/**
 * One streaming chart in the scroll grid. It registers its line handle with the
 * page's SHARED broadcast feed (one interval for the whole grid, not one per
 * chart) so the worker's ring keeps filling even while scrolled off-screen. With
 * `pauseWhenOffscreen` the worker stops DRAWING off-screen — but on scroll-back
 * the full window repaints from the ring, never an empty chart.
 */
function ChartCell({
  index,
  pause,
  register,
}: {
  index: number;
  pause: boolean;
  register: (feed: Feed) => () => void;
}) {
  const timeOrigin = useTimeOrigin();
  const color = COLORS[index % COLORS.length]!;
  const lastRenderRef = useRef(0);
  const [, force] = useState(0);

  // Re-render periodically so the badge flips to ⏸ when RENDER_STATS stop
  // arriving (a paused off-screen chart otherwise never re-renders to notice).
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 400);
    return () => window.clearInterval(id);
  }, []);

  const layers = useMemo(
    () => [
      axisGridLayer("axis", {
        xMode: "time",
        timeWindowMs: WINDOW_MS,
        timeOrigin,
        followClock: true,
        xTickFormat: "HH:mm:ss",
        yMode: "auto",
        gridColor: THEME.chart.gridColor,
        axisColor: THEME.chart.axisColor,
      }),
      lineLayer("line", {
        color,
        lineWidth: 1.5,
        retentionMs: RETENTION_MS,
        maxHz: TARGET_HZ,
      }),
    ],
    [timeOrigin, color],
  );

  // Render-activity indicator: RENDER_STATS only arrive while the worker is
  // actually drawing, so a scrolled-off (paused) chart goes stale.
  const live = performance.now() - lastRenderRef.current < 1500;

  return (
    <div
      style={{ position: "relative", height: CELL_H, borderBottom: "1px solid #2a2f3a" }}
    >
      <span
        data-testid={`badge-${index}`}
        style={{
          position: "absolute",
          zIndex: 1,
          top: 6,
          left: 8,
          fontSize: 12,
          fontFamily: "monospace",
          color: live ? "#80ffa0" : "#ff6060",
        }}
      >
        #{index} {live ? "▶ drawing" : "⏸ paused"}
      </span>
      <FluxionCanvas
        inlineAxes
        pauseWhenOffscreen={pause}
        yAxisWidth={52}
        xAxisHeight={24}
        layers={layers}
        hostOptions={{
          bgColor: THEME.chart.canvasBg,
          maxFps: 30,
          emitRenderStats: true,
        }}
        onReady={(h) => {
          const freq = 0.5 + (index % 7) * 0.25;
          register({ index, freq, line: h.line("line") });
          h.onRenderStats((s) => {
            agg.busyMs += s.busyMs;
            agg.renders += s.renders;
            lastRenderRef.current = performance.now();
            force((n) => n + 1);
          });
        }}
      />
    </div>
  );
}

export function ScrollGridDemoPage() {
  const [pause, setPause] = useState(INITIAL_PAUSE);
  const timeOrigin = useTimeOrigin();
  const cells = useMemo(() => Array.from({ length: CHART_COUNT }, (_, i) => i), []);
  const feedsRef = useRef<Set<Feed>>(new Set());

  const register = useMemo(
    () => (feed: Feed) => {
      feedsRef.current.add(feed);
      return () => feedsRef.current.delete(feed);
    },
    [],
  );

  // ── Shared broadcast feed: one interval pushes a sample to every chart. ──
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now() - timeOrigin;
      const sample: LineSample = { t, y: 0 };
      for (const f of feedsRef.current) {
        sample.y = Math.sin((t / 1000) * f.freq * Math.PI * 2) * 0.8;
        f.line.push(sample);
      }
    }, 1000 / TARGET_HZ);
    return () => window.clearInterval(id);
  }, [timeOrigin]);

  // ── Bench instrumentation: window.__scrollBench() + reset. ──
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let start = performance.now();
    const frameMs: number[] = [];
    const loop = () => {
      const now = performance.now();
      frameMs.push(now - last);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const w = window as unknown as {
      __scrollBench?: () => unknown;
      __scrollBenchReset?: () => void;
    };
    w.__scrollBenchReset = () => {
      agg.busyMs = 0;
      agg.renders = 0;
      frameMs.length = 0;
      start = performance.now();
    };
    w.__scrollBench = () => {
      const secs = Math.max((performance.now() - start) / 1000, 1e-3);
      const jank = frameMs.filter((m) => m > 1000 / 55).length / (frameMs.length || 1);
      return {
        total: CHART_COUNT,
        busyMsPerSec: agg.busyMs / secs,
        rendersPerSec: agg.renders / secs,
        mainFps: frameMs.length / secs,
        jankPct: jank * 100,
      };
    };
    return () => {
      cancelAnimationFrame(raf);
      w.__scrollBench = undefined;
      w.__scrollBenchReset = undefined;
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 8, display: "flex", gap: 12, alignItems: "center" }}>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={pause}
            onChange={(e) => setPause(e.target.checked)}
            data-testid="pause-toggle"
          />
          pauseWhenOffscreen
        </label>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {CHART_COUNT} charts on one shared {TARGET_HZ}Hz feed. Scroll — off-screen
          charts stop drawing (⏸) but keep buffering; scroll back and the full{" "}
          {WINDOW_MS / 1000}s window is intact.
        </span>
      </div>
      <div
        data-testid="scroll-container"
        style={{ flex: 1, overflowY: "auto", contain: "strict" }}
      >
        {cells.map((i) => (
          <ChartCell key={i} index={i} pause={pause} register={register} />
        ))}
      </div>
    </div>
  );
}
