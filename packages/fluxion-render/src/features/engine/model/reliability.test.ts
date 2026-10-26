import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AreaChartLayer } from "../../../entities/area-chart-layer/model/area-chart-layer";
import { AxisGridLayer } from "../../../entities/axis-grid-layer/model/axis-grid-layer";
import { LayerStack } from "../../../entities/layer-stack/model/layer-stack";
import { LineChartLayer } from "../../../entities/line-chart-layer/model/line-chart-layer";
import { ScatterChartLayer } from "../../../entities/scatter-chart-layer/model/scatter-chart-layer";
import { StepChartLayer } from "../../../entities/step-chart-layer/model/step-chart-layer";
import { GlRenderer } from "../../../shared/gl/gl-renderer";
import { Viewport } from "../../../shared/model/viewport";
import { type LayerKind, Op } from "../../../shared/protocol";
import { createFakeCtx } from "../../../test/setup";
import { Engine } from "./engine";
import { createLayer, registerLayer } from "./layer-registry";
import { registerDefaultLayers } from "./register-default-layers";

describe("renderer compatibility boundaries", () => {
  it("accepts an empty config for every built-in layer without changing defaults", () => {
    registerDefaultLayers();
    const kinds: LayerKind[] = [
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
      "current-time",
      "pose-arrow",
      "trajectory",
      "occupancy-grid",
      "histogram",
      "stacked-area",
      "box-plot",
      "polar",
    ];
    for (const kind of kinds) {
      const layer = createLayer(kind, kind);
      expect(() => {
        layer.setConfig({});
        layer.setConfig({ visible: false });
        layer.dispose();
      }).not.toThrow();
    }
  });
  it("prepares axes before observing data regardless of layer insertion order", () => {
    const stack = new LayerStack(),
      viewport = new Viewport();
    const line = new LineChartLayer("line"),
      axis = new AxisGridLayer("axis");
    axis.setConfig({ xMode: "fixed", xRange: [0, 10], yMode: "auto", yAutoPadding: 0 });
    const data = new Float32Array([0, 0, 10, 1, 20, 999]);
    line.setData(data.buffer, data.length, viewport);
    stack.add(line);
    stack.add(axis);
    viewport.beginScan();
    stack.scanAll(viewport);
    expect(viewport.bounds.yMax).toBe(1);
    expect(viewport.bounds.xMax).toBe(10);
    stack.disposeAll();
  });
  it("shares bounded extents across streaming layers, with empty windows and wider existing bounds", () => {
    for (const Layer of [
      LineChartLayer,
      AreaChartLayer,
      StepChartLayer,
      ScatterChartLayer,
    ]) {
      const layer = new Layer("data"),
        viewport = new Viewport();
      viewport.setSize(100, 100, 1);
      viewport.setBounds({ xMin: 0, xMax: 10, yMin: -1, yMax: 1 });
      const data = new Float32Array([0, 0, 10, 1, 20, 999]);
      layer.setData(data.buffer, data.length, viewport);
      viewport.beginScan();
      layer.scan(viewport);
      expect(viewport.observedYMax).toBe(1);
      viewport.observedYMin = -10;
      viewport.observedYMax = 10;
      layer.scan(viewport);
      expect(viewport.observedYMin).toBe(-10);
      expect(viewport.observedYMax).toBe(10);
      viewport.setBounds({ xMin: 30, xMax: 40, yMin: -1, yMax: 1 });
      viewport.beginScan();
      layer.scan(viewport);
      expect(viewport.observedYMin).toBe(Infinity);
      expect(viewport.observedYMax).toBe(-Infinity);
      layer.dispose();
    }
  });
  it("renders independent grid directions and hidden tick marks in both backends", () => {
    const canvas = new OffscreenCanvas(200, 100);
    const gl = GlRenderer.tryCreate(canvas, { alpha: false }, () => {})!;
    const viewport = new Viewport();
    viewport.setSize(200, 100, 1);
    viewport.insetLeft = 30;
    viewport.insetBottom = 20;
    const axis = new AxisGridLayer("axis");
    const ctx = createFakeCtx();
    for (const showXGrid of [false, true]) {
      axis.setConfig({
        showXGrid,
        showYGrid: !showXGrid,
        showAxes: false,
        applyToViewport: false,
        yMode: "auto",
      });
      viewport.beginScan();
      axis.scan(viewport);
      axis.finalizeBounds(viewport);
      axis.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, viewport);
      axis.drawGl(gl, viewport);
      axis.drawInlineAxesGl(gl, viewport, { tickSize: 0 });
    }
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    gl.dispose();
  });
  it("pushRaw preserves subarray and SharedArrayBuffer view offsets", () => {
    let received: number[] = [];
    registerLayer("line", (id) => ({
      id,
      setConfig() {},
      resize() {},
      draw() {},
      dispose() {},
      setData(buffer, length) {
        received = [...new Float32Array(buffer, 0, length)];
      },
    }));
    const engine = new Engine();
    engine.dispatch({ op: Op.ADD_LAYER, id: "line", kind: "line" });
    engine.pushRaw("line", new Float32Array([99, 88, 1, 2]).subarray(2));
    expect(received).toEqual([1, 2]);
    const shared = new Float32Array(new SharedArrayBuffer(8));
    shared.set([3, 4]);
    engine.pushRaw("line", shared);
    expect(received).toEqual([3, 4]);
    engine.dispatch({ op: Op.DISPOSE });
  });
});

type StreamingLayer = LineChartLayer | AreaChartLayer | StepChartLayer;
const STREAMING_LAYERS: Array<[string, new (id: string) => StreamingLayer]> = [
  ["line", LineChartLayer],
  ["area", AreaChartLayer],
  ["step", StepChartLayer],
];

function pathPoints(layer: StreamingLayer, vp: Viewport): Array<[number, number]> {
  const ctx = createFakeCtx();
  layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
  return ctx.calls
    .filter((c) => c.name === "moveTo" || c.name === "lineTo")
    .map((c) => [c.args[0] as number, c.args[1] as number]);
}

describe("timestamp glitches keep 1.7.0 draw coverage", () => {
  // A backward t makes WindowExtent warn once; keep output clean.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decimated 2d paths still reach the right edge while a backward step is retained", () => {
    for (const [, Layer] of STREAMING_LAYERS) {
      const vp = new Viewport();
      vp.setSize(100, 100, 1);
      vp.setBounds({ xMin: 0, xMax: 1000, yMin: 0, yMax: 1 });
      const layer = new Layer("glitch");
      layer.setConfig({ decimate: true, capacity: 4096 });
      const pts = [-5, 0, -6, 0]; // one backward step, long before the window
      for (let i = 0; i < 300; i++) pts.push(i, 0.5);
      for (let t = 350; t <= 1150; t += 100) pts.push(t, 0.5);
      const data = new Float32Array(pts);
      layer.setData(data.buffer, data.length, vp);
      vp.beginScan();
      layer.scan(vp);
      // Unordered there is no index bound, so — like 1.7.0 and the GL path —
      // every sample not left of xMin is walked: the last column is t=1150
      // (x=115), past the plot edge, instead of stopping short at t=950.
      expect(Math.max(...pathPoints(layer, vp).map(([x]) => x))).toBe(115);
    }
  });
});
