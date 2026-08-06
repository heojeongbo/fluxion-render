import { afterEach, describe, expect, it } from "vitest";
import { LineChartLayer } from "../../../entities/line-chart-layer";
import {
  createLayer,
  hasLayer,
  registerLayer,
  resetLayerRegistry,
} from "./layer-registry";
import { registerDefaultLayers } from "./register-default-layers";

afterEach(() => {
  resetLayerRegistry();
});

describe("layer registry", () => {
  it("creates a layer from a registered factory", () => {
    registerLayer("line", (id) => new LineChartLayer(id));
    expect(hasLayer("line")).toBe(true);
    const layer = createLayer("s1", "line");
    expect(layer).toBeInstanceOf(LineChartLayer);
    expect(layer.id).toBe("s1");
  });

  it("throws an actionable error for an unregistered kind", () => {
    expect(hasLayer("polar")).toBe(false);
    expect(() => createLayer("p", "polar")).toThrow(
      /no layer factory registered.*"polar"/,
    );
  });

  it("re-registering a kind replaces its factory", () => {
    registerLayer("line", () => new LineChartLayer("first"));
    registerLayer("line", () => new LineChartLayer("second"));
    expect(createLayer("ignored", "line").id).toBe("second");
  });

  it("registerDefaultLayers registers every built-in kind and is idempotent", () => {
    registerDefaultLayers();
    for (const kind of [
      "line",
      "line-static",
      "lidar",
      "axis-grid",
      "scatter",
      "area",
      "step",
      "bar",
      "candlestick",
      "heatmap",
      "event-marker",
      "scatter-colored",
      "heatmap-stream",
      "reference-line",
      "pose-arrow",
      "trajectory",
      "occupancy-grid",
      "histogram",
      "stacked-area",
      "box-plot",
      "polar",
    ] as const) {
      expect(hasLayer(kind)).toBe(true);
      expect(createLayer("x", kind).id).toBe("x");
    }
    // Second call is a no-op (the `done` latch) — still all registered.
    expect(() => registerDefaultLayers()).not.toThrow();
    expect(hasLayer("line")).toBe(true);
  });
});
