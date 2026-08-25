import { describe, expect, it, vi } from "vitest";
import type { Viewport } from "../../../shared/model/viewport";
import { HeatmapStreamLayer } from "./heatmap-stream-layer";

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
    heightPx: height,
    observedYMin: Number.POSITIVE_INFINITY,
    observedYMax: Number.NEGATIVE_INFINITY,
    latestT: 0,
  } as unknown as Viewport;
}

function makeColumn(
  t: number,
  ...values: number[]
): { buffer: ArrayBuffer; length: number } {
  const arr = new Float32Array([t, ...values]);
  return { buffer: arr.buffer, length: arr.length };
}

describe("HeatmapStreamLayer", () => {
  it("constructor assigns id", () => {
    const layer = new HeatmapStreamLayer("hs1");
    expect(layer.id).toBe("hs1");
  });

  it("draw is no-op before any setData", () => {
    const layer = new HeatmapStreamLayer("hs1");
    const ctx = makeCtx();
    layer.draw(ctx, makeViewport());
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("draw is no-op when visible is false", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, visible: false });
    const vp = makeViewport();
    const { buffer, length } = makeColumn(100, 0.5, 0.8);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("setData ignores buffers with length < 2", () => {
    const layer = new HeatmapStreamLayer("hs1");
    const vp = makeViewport();
    const arr = new Float32Array([100]);
    layer.setData(arr.buffer, 1, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("draw calls fillRect for each bin per visible column", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 4 });
    const vp = makeViewport();
    const { buffer, length } = makeColumn(100, 0.1, 0.3, 0.6, 0.9);
    layer.setData(buffer, length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("draw skips columns outside viewport bounds", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2 });
    const vp = makeViewport();
    const col1 = makeColumn(50, 0.1, 0.2);
    layer.setData(col1.buffer, col1.length, vp);
    const col2 = makeColumn(2000, 0.5, 0.8);
    layer.setData(col2.buffer, col2.length, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("setData updates viewport.latestT", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2 });
    const vp = makeViewport();
    const { buffer, length } = makeColumn(500, 0.1, 0.2);
    layer.setData(buffer, length, vp);
    expect(vp.latestT).toBe(500);
  });

  it("setData does not roll back latestT", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2 });
    const vp = makeViewport();
    layer.setData(makeColumn(800, 0.5, 0.6).buffer, 3, vp);
    layer.setData(makeColumn(200, 0.1, 0.2).buffer, 3, vp);
    expect(vp.latestT).toBe(800);
  });

  it("setConfig triggers realloc when yBins changes", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 4 });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2, 0.3, 0.4).buffer, 5, vp);
    layer.setConfig({ yBins: 2 });
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("setConfig triggers realloc when maxCols changes", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, maxCols: 8 });
    const vp = makeViewport();
    for (let i = 0; i < 5; i++) {
      layer.setData(makeColumn(i * 10, 0.1, 0.2).buffer, 3, vp);
    }
    layer.setConfig({ maxCols: 4 });
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("setConfig updates yRange", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, yRange: [10, 50] });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("setConfig uses plasma colormap", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, colormap: "plasma" });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.5, 0.8).buffer, 3, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("setConfig uses hot colormap", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, colormap: "hot" });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.5, 0.8).buffer, 3, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("setConfig with no yBins/maxCols change does not realloc (preserves columns)", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2 });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    // Re-apply identical yBins/maxCols plus a non-structural change -> no realloc,
    // so the previously pushed column survives and still draws.
    layer.setConfig({ yBins: 2, maxCols: 256, colormap: "plasma" });
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("setConfig switches colormap back to viridis", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, colormap: "hot" });
    layer.setConfig({ colormap: "viridis" });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.5, 0.8).buffer, 3, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("draw auto-fills only one end when a single value bound is configured", () => {
    const onlyMin = new HeatmapStreamLayer("hs1");
    onlyMin.setConfig({ yBins: 2, minValue: 0 }); // maxValue auto
    const vp = makeViewport();
    onlyMin.setData(makeColumn(100, 0.25, 0.75).buffer, 3, vp);
    const ctxA = makeCtx();
    expect(() => onlyMin.draw(ctxA, vp)).not.toThrow();
    expect((ctxA.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    const onlyMax = new HeatmapStreamLayer("hs2");
    onlyMax.setConfig({ yBins: 2, maxValue: 1 }); // minValue auto
    onlyMax.setData(makeColumn(100, 0.25, 0.75).buffer, 3, vp);
    const ctxB = makeCtx();
    expect(() => onlyMax.draw(ctxB, vp)).not.toThrow();
    expect((ctxB.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("draw uses auto value range when minValue/maxValue not set", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 3 });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.0, 0.5, 1.0).buffer, 4, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("draw uses configured minValue and maxValue", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, minValue: 0, maxValue: 1 });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.25, 0.75).buffer, 3, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("ring buffer wraps and overwrites oldest columns when full", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, maxCols: 4 });
    const vp = makeViewport();
    for (let i = 0; i < 6; i++) {
      layer.setData(makeColumn(i * 10, 0.1, 0.2).buffer, 3, vp);
    }
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      0,
    );
  });

  it("draw computes cellW from adjacent column spacing", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2 });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    layer.setData(makeColumn(200, 0.3, 0.4).buffer, 3, vp);
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("scan updates observedYMin/YMax from yRange", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, yRange: [5, 95] });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBe(5);
    expect(vp.observedYMax).toBe(95);
  });

  it("scan leaves wider observed bounds untouched", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, yRange: [10, 90] });
    const vp = makeViewport();
    // Pre-seed bounds already wider than the layer's yRange -> neither the
    // `observedYMin > yMin` nor `observedYMax < yMax` guard should fire.
    vp.observedYMin = -100;
    vp.observedYMax = 200;
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBe(-100);
    expect(vp.observedYMax).toBe(200);
  });

  it("scan is no-op when not visible", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, visible: false });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("scan is no-op when count is 0", () => {
    const layer = new HeatmapStreamLayer("hs1");
    const vp = makeViewport();
    layer.scan(vp);
    expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("resize does not throw", () => {
    const layer = new HeatmapStreamLayer("hs1");
    expect(() => layer.resize(makeViewport())).not.toThrow();
  });

  it("dispose clears data so draw becomes no-op", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2 });
    const vp = makeViewport();
    layer.setData(makeColumn(100, 0.1, 0.2).buffer, 3, vp);
    layer.dispose();
    const ctx = makeCtx();
    layer.draw(ctx, vp);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("setConfig clamps maxCols to minimum 4", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 2, maxCols: 1 });
    const vp = makeViewport();
    for (let i = 0; i < 6; i++) {
      layer.setData(makeColumn(i * 10, 0.1, 0.2).buffer, 3, vp);
    }
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });

  it("setConfig clamps yBins to minimum 1", () => {
    const layer = new HeatmapStreamLayer("hs1");
    layer.setConfig({ yBins: 0 });
    const vp = makeViewport();
    const arr = new Float32Array([100, 0.5]);
    layer.setData(arr.buffer, 2, vp);
    const ctx = makeCtx();
    expect(() => layer.draw(ctx, vp)).not.toThrow();
  });
});
