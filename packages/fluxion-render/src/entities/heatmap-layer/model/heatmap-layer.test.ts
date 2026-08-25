import { describe, expect, it, vi } from "vitest";
import type { Viewport } from "../../../shared/model/viewport";
import { HeatmapLayer } from "./heatmap-layer";

function makeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    drawImage: vi.fn(),
  } as unknown as OffscreenCanvasRenderingContext2D;
}

function makeViewport(width = 800, height = 400) {
  return {
    bounds: { xMin: 0, xMax: 1000, yMin: 0, yMax: 100 },
    xToPx: vi.fn((x: number) => x * 0.8),
    yToPx: vi.fn((y: number) => height - y * 4),
    width,
    height,
    observedYMin: Number.POSITIVE_INFINITY,
    observedYMax: Number.NEGATIVE_INFINITY,
  } as unknown as Viewport;
}

function makeData(...points: [number, number, number][]): {
  buffer: ArrayBuffer;
  length: number;
} {
  const arr = new Float32Array(points.length * 3);
  points.forEach(([x, y, v], i) => {
    arr[i * 3] = x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = v;
  });
  return { buffer: arr.buffer, length: arr.length };
}

describe("HeatmapLayer", () => {
  it("constructor assigns id", () => {
    const layer = new HeatmapLayer("h1");
    expect(layer.id).toBe("h1");
  });

  it("draw is no-op before setData", () => {
    const layer = new HeatmapLayer("h1");
    const ctx = makeCtx();
    const vp = makeViewport();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("draw is no-op when visible is false", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ visible: false });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 50, 0.5]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("draw is no-op when dataLength < 3", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const arr = new Float32Array([100, 50]);
    layer.setData(arr.buffer, 2, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("draw calls fillRect for each data point", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.5], [200, 40, 0.8], [300, 60, 0.2]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("draw uses auto value range when minValue/maxValue not configured", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.0], [200, 40, 1.0]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("draw auto-fills only maxValue when only minValue is configured", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ minValue: 0 }); // maxValue stays undefined -> auto
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.2], [200, 40, 0.9]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("draw auto-fills only minValue when only maxValue is configured", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ maxValue: 1 }); // minValue stays undefined -> auto
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.2], [200, 40, 0.9]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("draw uses configured minValue and maxValue", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ minValue: 0, maxValue: 10 });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 5]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("draw handles all-equal values (range=0 fallback to 1)", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 5], [200, 40, 5]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("setConfig updates cellWidth and cellHeight clamped to min 1", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ cellWidth: 0, cellHeight: -5 });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.5]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    const calls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [, , w, h] = calls[0] as [number, number, number, number];
    expect(w).toBe(1);
    expect(h).toBe(1);
  });

  it("setConfig switches colormap to plasma", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ colormap: "plasma" });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.5]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("setConfig switches colormap to hot", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ colormap: "hot" });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.5]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("setConfig switches colormap back to viridis", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ colormap: "plasma" });
    layer.setConfig({ colormap: "viridis" });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 1.0]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("scan updates observedYMin and observedYMax", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 10, 0.5], [200, 90, 0.8], [300, 50, 0.3]);
    layer.setData(buffer, length, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBe(10);
    expect(vp.observedYMax).toBe(90);
  });

  it("scan handles a mid-range y that is neither a new min nor a new max", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    // y order 50, 10, 30, 90: 30 is neither < running min nor > running max,
    // exercising the false side of both `y < localMin` and `y > localMax`.
    // An extra trailing point keeps the scanned window inclusive of index 3.
    const { buffer, length } = makeData(
      [100, 50, 0.5],
      [200, 10, 0.5],
      [300, 30, 0.5],
      [400, 90, 0.5],
      [500, 40, 0.5],
    );
    layer.setData(buffer, length, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBe(10);
    expect(vp.observedYMax).toBe(90);
  });

  it("scan is no-op when not visible", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ visible: false });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 50, 0.5]);
    layer.setData(buffer, length, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("scan is no-op when dataLength is 0", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    layer.scan(vp);
    expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("resize does not throw", () => {
    const layer = new HeatmapLayer("h1");
    expect(() => layer.resize(makeViewport())).not.toThrow();
  });

  it("dispose clears data so draw becomes no-op", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, 0.5]);
    layer.setData(buffer, length, vp);
    layer.dispose();
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("draw clamps norm values below 0 and above 1", () => {
    const layer = new HeatmapLayer("h1");
    layer.setConfig({ minValue: 5, maxValue: 10 });
    const vp = makeViewport();
    const { buffer, length } = makeData([100, 20, -100], [200, 40, 9999]);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("setData replaces previous data entirely", () => {
    const layer = new HeatmapLayer("h1");
    const vp = makeViewport();
    const first = makeData([10, 20, 0.1], [20, 30, 0.2], [30, 40, 0.3]);
    layer.setData(first.buffer, first.length, vp);
    const second = makeData([50, 60, 0.9]);
    layer.setData(second.buffer, second.length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
