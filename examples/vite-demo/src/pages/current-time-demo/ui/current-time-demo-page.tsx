import {
  axisGridLayer,
  currentTimeLayer,
  FluxionCanvas,
  type FluxionHost,
  lineLayer,
} from "@heojeongbo/fluxion-render/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

/** Replay controls also serve as the real-worker browser test fixture. */
export function CurrentTimeDemoPage() {
  const [currentTime, setCurrentTime] = useState(2500);
  const playbackTime = useRef(2500);
  const [playing, setPlaying] = useState(false);
  const [live, setLive] = useState(false);
  const [visible, setVisible] = useState(true);
  const [timeOrigin, setTimeOrigin] = useState(() => Date.now() - 2500);
  const [ready, setReady] = useState(false);
  const query = new URLSearchParams(window.location.search);
  const renderer = query.get("renderer") === "webgl" ? "webgl" : "2d";
  const axes = query.get("axes") ?? "inline";
  useLayoutEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = now - previous;
      previous = now;
      playbackTime.current = Math.min(10000, playbackTime.current + dt);
      setCurrentTime(playbackTime.current);
    }, 1000 / 30);
    return () => clearInterval(timer);
  }, [playing]);
  const layers = useMemo(
    () => [
      axisGridLayer("axis", {
        // Leave a useful live viewing window even when browser readback is slow.
        xRange: [0, live ? 60000 : 10000],
        yRange: [-1.2, 1.2],
        showXLabels: false,
        showYLabels: false,
      }),
      lineLayer("signal", { color: "#4fc3f7" }),
      currentTimeLayer("playhead", {
        currentTime: live ? null : currentTime,
        timeOrigin,
        visible,
      }),
    ],
    [currentTime, live, timeOrigin, visible],
  );
  const seed = (host: FluxionHost) => {
    host.pushData(
      "signal",
      Float32Array.from({ length: 402 }, (_, i) =>
        i % 2 === 0 ? (i / 2) * 50 : Math.sin((i - 1) / 30),
      ),
    );
    setReady(true);
  };
  return (
    <div
      style={{
        padding: 24,
        color: "#e7e9ef",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <h2>Current time / Replay playhead</h2>
      <p>A vertical bar follows playback or the live clock, inside the plot.</p>
      <div style={{ display: "flex", gap: 12 }}>
        <button
          type="button"
          onClick={() => {
            setLive(false);
            // Commit the last tick with the pause. A previously queued timer
            // update must not move the controlled slider after pause commits.
            setCurrentTime(playbackTime.current);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          aria-pressed={live}
          onClick={() => {
            setPlaying(false);
            setLive(true);
            setTimeOrigin(Date.now() - 15000);
          }}
        >
          Live clock
        </button>
        <label>
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => setVisible(e.target.checked)}
          />
          Show current time
        </label>
      </div>
      <input
        aria-label="Playback time"
        type="range"
        min={0}
        max={10000}
        value={currentTime}
        onChange={(e) => {
          setPlaying(false);
          setLive(false);
          playbackTime.current = Number(e.target.value);
          setCurrentTime(playbackTime.current);
        }}
      />
      <output data-testid="ready">{ready ? "ready" : "loading"}</output>
      <div data-testid="current-time-chart" style={{ width: "100%", height: 300 }}>
        <FluxionCanvas
          layers={layers}
          inlineAxes={axes === "inline"}
          externalAxes={axes === "external"}
          yAxisWidth={40}
          xAxisHeight={24}
          onReady={seed}
          hostOptions={{ renderer, maxFps: 60 }}
        />
      </div>
    </div>
  );
}
