import type { FluxionHost, LineSample } from "@heojeongbo/fluxion-render";
import {
  axisGridLayer,
  FluxionCanvas,
  lineLayer,
  useFluxionStream,
  useTimeOrigin,
} from "@heojeongbo/fluxion-render/react";
import { useMemo, useState } from "react";
import {
  type Float32StampedMessage,
  generateFloat32StampedMessage,
  stampToMs,
} from "../../../shared/lib/test-data";
import { type DemoTheme, THEME, THEME_DARK } from "../../../shared/ui/theme";

const TARGET_HZ = 120;
const WINDOW_MS = 5000;
const Y_PAD_PX = 8;
const Y_AXIS_WIDTH = 60;
const X_AXIS_HEIGHT = 30;

const transform = (msg: Float32StampedMessage): LineSample => ({
  t: stampToMs(msg.header),
  y: msg.data,
});

/**
 * Live light/dark theme switch for a worker-rendered chart.
 *
 * CSS can't reach OffscreenCanvas pixels, so the theme is applied by passing
 * resolved colors into the library. All three color surfaces flip WITHOUT a
 * remount (the host instance is stable — watch: no re-init flash):
 *   • canvas background → `hostOptions.bgColor`   (reconciled to the live host)
 *   • external axis strip → `<FluxionCanvas axisColor>`  (SET_AXIS_STYLE)
 *   • in-canvas grid/axis/labels → `axis-grid` layer config  (configLayer)
 * Series color stays fixed across themes — it's an identity accent.
 */
export function ThemeDemoPage() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  const theme: DemoTheme = mode === "dark" ? THEME_DARK : THEME;
  const timeOrigin = useTimeOrigin();
  const [host, setHost] = useState<FluxionHost | null>(null);

  // Changing the theme changes the memo → the in-canvas grid/axis/label colors
  // reconcile to the live host via configLayer. bgColor + axisColor reconcile
  // through their own paths (below). No `key` remount anywhere.
  const layers = useMemo(
    () => [
      axisGridLayer("axis", {
        xMode: "time",
        timeWindowMs: WINDOW_MS,
        timeOrigin,
        xTickFormat: "HH:mm:ss",
        xTickIntervalMs: 1000,
        yMode: "auto",
        gridColor: theme.chart.gridColor,
        gridDashArray: [3, 3],
        axisColor: theme.chart.axisColor,
        labelColor: theme.chart.labelColor,
        yPadPx: Y_PAD_PX,
      }),
      lineLayer("line", {
        color: "#4fc3f7", // identity accent — same in light & dark
        lineWidth: 1.5,
        retentionMs: 10_000,
        maxHz: TARGET_HZ,
      }),
    ],
    [timeOrigin, theme],
  );

  useFluxionStream({
    host,
    intervalMs: 1000 / TARGET_HZ,
    setup: (h) => h.line("line"),
    tick: (t, line) => {
      line.push(transform(generateFloat32StampedMessage(t)));
      return 1;
    },
  });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        boxSizing: "border-box",
        background: theme.page.background,
        color: theme.page.textPrimary,
        transition: "background 120ms",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            cursor: "pointer",
            background: theme.button.background,
            color: theme.button.text,
            border: `1px solid ${theme.button.border}`,
          }}
        >
          {mode === "dark" ? "☀ Switch to light" : "🌙 Switch to dark"}
        </button>
        <span style={{ fontSize: 12, color: theme.page.textSecondary }}>
          One host, no remount — bg / external axis / grid all re-theme live.
        </span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: `1px solid ${theme.panel.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <FluxionCanvas
          externalAxes
          axisLayerId="axis"
          yAxisWidth={Y_AXIS_WIDTH}
          xAxisHeight={X_AXIS_HEIGHT}
          axisColor={theme.chart.labelColor}
          layers={layers}
          hostOptions={{ bgColor: theme.chart.canvasBg }}
          onReady={setHost}
        />
      </div>
    </div>
  );
}
