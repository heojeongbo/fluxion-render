import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  axisGridLayer,
  lineLayer,
} from "../../../widgets/fluxion-canvas/lib/layer-specs";
import type { FluxionLayerSpec } from "../../../widgets/fluxion-canvas/lib/use-fluxion-canvas";
import type { HoverDataCache } from "./hover-data-cache";

// Capture the options the wrapper forwards to the underlying hook.
const received: { opts?: unknown } = {};
vi.mock("./use-fluxion-crosshair", () => ({
  useFluxionCrosshair: (opts: unknown) => {
    received.opts = opts;
    return { chartRef: { current: null }, state: { position: null, points: [] } };
  },
}));

// Imported AFTER the mock so it picks up the mocked dependency.
const { useFluxionCrosshairFromLayers } = await import(
  "./use-fluxion-crosshair-from-layers"
);

const cache = {} as HoverDataCache;
const host = { hostId: "h" } as never;

describe("useFluxionCrosshairFromLayers", () => {
  it("derives xMode/timeWindowMs/timeOrigin from the matching axis-grid spec", () => {
    const layers: FluxionLayerSpec[] = [
      axisGridLayer("axis", {
        xMode: "time",
        timeWindowMs: 4000,
        timeOrigin: 1_000_000,
        yPadPx: 8,
      }),
      lineLayer("s", { color: "#abc" }),
    ];
    renderHook(() => useFluxionCrosshairFromLayers({ host, cache, layers }));
    expect(received.opts).toMatchObject({
      xMode: "time",
      timeWindowMs: 4000,
      timeOrigin: 1_000_000,
    });
  });

  it("falls back to fixed defaults when no axis-grid spec matches", () => {
    const layers: FluxionLayerSpec[] = [lineLayer("s", { color: "#abc" })];
    renderHook(() =>
      useFluxionCrosshairFromLayers({ host, cache, layers, axisLayerId: "missing" }),
    );
    expect(received.opts).toMatchObject({ xMode: "fixed" });
    expect((received.opts as { timeWindowMs?: number }).timeWindowMs).toBeUndefined();
  });

  it("does not forward the deprecated yPadPx — it has no effect downstream", () => {
    const layers: FluxionLayerSpec[] = [
      axisGridLayer("axis", { xMode: "time", yPadPx: 8 }),
    ];
    // `useFluxionCrosshair` never inverts pointer Y into a data value (the
    // reported `y` comes from the nearest cached sample), so there is no
    // y-padding to compensate for. The option stays accepted for source
    // compatibility but is deliberately not plumbed through.
    renderHook(() => useFluxionCrosshairFromLayers({ host, cache, layers, yPadPx: 2 }));
    expect((received.opts as { yPadPx?: number }).yPadPx).toBeUndefined();
  });

  it("forwards the explicit cache when provided", () => {
    const layers: FluxionLayerSpec[] = [lineLayer("s", { color: "#abc" })];
    renderHook(() => useFluxionCrosshairFromLayers({ host, cache, layers }));
    expect((received.opts as { cache?: unknown }).cache).toBe(cache);
  });

  it("creates and exposes an internal cache when none is provided", () => {
    const layers: FluxionLayerSpec[] = [
      axisGridLayer("axis", { xMode: "time" }),
      lineLayer("s", { color: "#abc" }),
    ];
    const { result } = renderHook(() => useFluxionCrosshairFromLayers({ host, layers }));
    // The hook owns a real cache and forwards it to the underlying hook.
    expect(result.current.cache).toBeDefined();
    expect((received.opts as { cache?: unknown }).cache).toBe(result.current.cache);
    expect(typeof result.current.push).toBe("function");
    expect(typeof result.current.pushBatch).toBe("function");
  });

  it("push/pushBatch write into the active cache", () => {
    const layers: FluxionLayerSpec[] = [lineLayer("s", { color: "#abc" })];
    const { result } = renderHook(() => useFluxionCrosshairFromLayers({ host, layers }));
    // The internal cache auto-registers layer "s", so a push is retained and
    // readable back via getPoints.
    result.current.push("s", 10, 42);
    result.current.pushBatch("s", new Float32Array([20, 7]));
    expect(result.current.cache.getPoints("s")).toEqual([
      { t: 10, y: 42 },
      { t: 20, y: 7 },
    ]);
  });

  it("forwards per-id overrides (e.g. capacity) to the auto-created cache", () => {
    const layers: FluxionLayerSpec[] = [lineLayer("s", { color: "#abc" })];
    const { result } = renderHook(() =>
      useFluxionCrosshairFromLayers({ host, layers, overrides: { s: { capacity: 2 } } }),
    );
    // capacity:2 → the third push evicts the oldest sample.
    result.current.push("s", 1, 10);
    result.current.push("s", 2, 20);
    result.current.push("s", 3, 30);
    expect(result.current.cache.getPoints("s")).toEqual([
      { t: 2, y: 20 },
      { t: 3, y: 30 },
    ]);
  });
});
