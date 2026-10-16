import { describe, expect, it, vi } from "vitest";
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
