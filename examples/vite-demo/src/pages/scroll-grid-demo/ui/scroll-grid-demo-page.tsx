import {
  axisGridLayer,
  FluxionCanvas,
  lineLayer,
  useFluxionStream,
  useTimeOrigin,
} from "@heojeongbo/fluxion-render/react";
import { useMemo, useRef, useState } from "react";
import { THEME } from "../../../shared/ui/theme";

const CHART_COUNT = 40;
const TARGET_HZ = 60;
const WINDOW_MS = 5000;
const RETENTION_MS = 12_000; // ring covers well past the window
const COLORS = ["#4fc3f7", "#80ffa0", "#ffb060", "#ff80c0", "#b090ff"];

/**
 * One streaming chart in the scroll grid. Its `useFluxionStream` interval runs
 * on the main thread regardless of scroll position, so the worker's ring keeps
 * filling even while the chart is scrolled out of view. With `pauseWhenOffscreen`
 * the WORKER stops drawing while off-screen — but on scroll-back the full window
 * repaints from the ring, never an empty chart.
 */
function ChartCell({ index, pause }: { index: number; pause: boolean }) {
  const timeOrigin = useTimeOrigin();
  const color = COLORS[index % COLORS.length]!;
  const freq = 0.5 + (index % 7) * 0.25;
  const lastRenderRef = useRef(0);
  const [, force] = useState(0);

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

  const [host, setHost] = useState<Parameters<typeof useFluxionStream>[0]["host"]>(null);
  useFluxionStream({
    host,
    intervalMs: 1000 / TARGET_HZ,
    setup: (h) => h.line("line"),
    tick: (t, line) => {
      const y = Math.sin((t / 1000) * freq * Math.PI * 2) * 0.8;
      line.push({ t, y });
      return 1;
    },
  });

  // Render-activity indicator: RENDER_STATS only arrive while the worker is
  // actually drawing, so a scrolled-off (paused) chart goes stale.
  const live = performance.now() - lastRenderRef.current < 1500;

  return (
    <div style={{ position: "relative", height: 200, borderBottom: "1px solid #2a2f3a" }}>
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
          setHost(h);
          h.onRenderStats(() => {
            lastRenderRef.current = performance.now();
            force((n) => n + 1);
          });
        }}
      />
    </div>
  );
}

export function ScrollGridDemoPage() {
  const [pause, setPause] = useState(true);
  const cells = useMemo(() => Array.from({ length: CHART_COUNT }, (_, i) => i), []);
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
          {CHART_COUNT} charts, each streaming {TARGET_HZ}Hz. Scroll — off-screen charts
          stop drawing (⏸) but keep buffering; scroll back and the full {WINDOW_MS / 1000}
          s window is intact.
        </span>
      </div>
      <div
        data-testid="scroll-container"
        style={{ flex: 1, overflowY: "auto", contain: "strict" }}
      >
        {cells.map((i) => (
          <ChartCell key={i} index={i} pause={pause} />
        ))}
      </div>
    </div>
  );
}
