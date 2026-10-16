import { describe, expect, it } from "vitest";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx } from "../../../test/setup";
import { StackedAreaLayer } from "./stacked-area-layer";

function makeViewport() {
  const v = new Viewport();
  v.setSize(800, 400, 1);
  v.setBounds({ xMin: 0, xMax: 1000, yMin: 0, yMax: 10 });
  return v;
}

/** Build [t, y0, y1, ...] samples for `seriesCount` series. */
function samples(rows: number[][]): ArrayBuffer {
  const stride = rows[0]!.length;
  const buf = new Float32Array(rows.length * stride);
  rows.forEach((r, i) => buf.set(r, i * stride));
  return buf.buffer as ArrayBuffer;
}

function draw(layer: StackedAreaLayer, vp: Viewport) {
  const ctx = createFakeCtx();
  layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
  return ctx;
}

describe("StackedAreaLayer", () => {
  it("constructor assigns id", () => {
    expect(new StackedAreaLayer("sa").id).toBe("sa");
  });

  it("fills one band per series", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 3 });
    const vp = makeViewport();
    // [t, y0, y1, y2] × 2 samples
    layer.setData(
      samples([
        [100, 1, 2, 3],
        [200, 2, 1, 1],
      ]),
      8,
      vp,
    );
    const ctx = draw(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "fill").length).toBe(3);
  });

  it("scan stacks values to the running total for the y extent", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2 });
    const vp = makeViewport();
    vp.beginScan();
    layer.setData(samples([[100, 3, 4]]), 3, vp); // total 7
    layer.scan(vp);
    expect(vp.observedYMax).toBeGreaterThanOrEqual(7);
    expect(vp.observedYMin).toBeLessThanOrEqual(0);
  });

  it("normalize scales each stack to 1", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2, normalize: true });
    const vp = makeViewport();
    vp.beginScan();
    layer.setData(samples([[100, 3, 1]]), 3, vp); // total 4 → top 1
    layer.scan(vp);
    expect(vp.observedYMax).toBeCloseTo(1);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("normalize handles an all-zero sample without dividing by zero", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2, normalize: true });
    const vp = makeViewport();
    layer.setData(samples([[100, 0, 0]]), 3, vp);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("draws outlines when lineWidth > 0", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2, lineWidth: 2 });
    const vp = makeViewport();
    layer.setData(
      samples([
        [100, 1, 1],
        [200, 2, 2],
      ]),
      6,
      vp,
    );
    const ctx = draw(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "stroke").length).toBe(2);
  });

  it("cycles colors and respects fillOpacity", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 3, colors: ["#111111"], fillOpacity: 0.5 });
    const vp = makeViewport();
    layer.setData(samples([[100, 1, 1, 1]]), 4, vp);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("filters samples before the visible window in scan and draw", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 1 });
    const vp = makeViewport();
    vp.setBounds({ xMin: 500, xMax: 1000, yMin: 0, yMax: 10 });
    vp.beginScan();
    layer.setData(
      samples([
        [100, 3],
        [200, 4],
      ]),
      4,
      vp,
    ); // both before xMin=500
    layer.scan(vp);
    const ctx = draw(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "fill").length).toBe(0);
  });

  it("resizes the ring when seriesCount changes", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2 });
    const vp = makeViewport();
    layer.setData(samples([[100, 1, 2]]), 3, vp);
    // change series count → ring resized, old data gone
    layer.setConfig({ seriesCount: 3 });
    const ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("auto-sizes capacity from retentionMs + maxHz", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2, retentionMs: 1000, maxHz: 50 });
    const vp = makeViewport();
    layer.setData(samples([[100, 1, 1]]), 3, vp);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("hidden layer skips scan and draw", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2, visible: false });
    const vp = makeViewport();
    vp.beginScan();
    const before = vp.observedYMax;
    layer.setData(samples([[100, 3, 4]]), 3, vp);
    layer.scan(vp);
    expect(vp.observedYMax).toBe(before);
    const ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("ignores sub-stride buffers and empty rings", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 3 });
    const vp = makeViewport();
    layer.setData(new Float32Array([100, 1]).buffer, 2, vp); // < stride 4
    vp.beginScan();
    layer.scan(vp);
    const ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("clearData and dispose empty the ring", () => {
    const layer = new StackedAreaLayer("sa");
    layer.setConfig({ seriesCount: 2 });
    const vp = makeViewport();
    layer.setData(samples([[100, 1, 1]]), 3, vp);
    layer.clearData();
    let ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
    layer.setData(samples([[100, 1, 1]]), 3, vp);
    layer.dispose();
    ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("resize is a no-op", () => {
    expect(() => new StackedAreaLayer("sa").resize(makeViewport())).not.toThrow();
  });
});

it("reuses drawing scratch and preserves a wider observed range after repeated configuration", () => {
  const layer = new StackedAreaLayer("stack"),
    vp = makeViewport();
  layer.setConfig({ seriesCount: 2, capacity: 8 });
  layer.setConfig({ capacity: 8 });
  layer.setData(
    samples([
      [0, 1, 2],
      [1, 2, 3],
    ]),
    6,
    vp,
  );
  vp.observedYMin = -10;
  vp.observedYMax = 10;
  layer.scan(vp);
  expect(vp.observedYMin).toBe(-10);
  expect(draw(layer, vp).calls.length).toBeGreaterThan(0);
  expect(draw(layer, vp).calls.length).toBeGreaterThan(0);
  layer.dispose();
});
