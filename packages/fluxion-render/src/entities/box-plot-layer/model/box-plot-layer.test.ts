import { describe, expect, it } from "vitest";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx } from "../../../test/setup";
import { BoxPlotLayer } from "./box-plot-layer";

function makeViewport() {
  const v = new Viewport();
  v.setSize(800, 400, 1);
  v.setBounds({ xMin: 0, xMax: 5, yMin: 0, yMax: 100 });
  return v;
}

/** [x, min, q1, median, q3, max] tuples → flat buffer. */
function boxes(...rows: number[][]): ArrayBuffer {
  const buf = new Float32Array(rows.length * 6);
  rows.forEach((r, i) => {
    buf.set(r, i * 6);
  });
  return buf.buffer as ArrayBuffer;
}

function draw(layer: BoxPlotLayer, vp: Viewport) {
  const ctx = createFakeCtx();
  layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
  return ctx;
}

describe("BoxPlotLayer", () => {
  it("constructor assigns id", () => {
    expect(new BoxPlotLayer("bp").id).toBe("bp");
  });

  it("draws a box, median, and whiskers per entry", () => {
    const layer = new BoxPlotLayer("bp");
    const vp = makeViewport();
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    const ctx = draw(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "fillRect").length).toBe(1);
    expect(ctx.calls.filter((c) => c.name === "strokeRect").length).toBe(1);
    // median line + whiskers = at least 2 stroke calls
    expect(ctx.calls.filter((c) => c.name === "stroke").length).toBeGreaterThanOrEqual(2);
  });

  it("draws multiple boxes", () => {
    const layer = new BoxPlotLayer("bp");
    const vp = makeViewport();
    layer.setData(boxes([1, 10, 20, 30, 40, 50], [2, 5, 15, 25, 35, 45]), 12, vp);
    const ctx = draw(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "fillRect").length).toBe(2);
  });

  it("scan reports the min/max extent across boxes", () => {
    const layer = new BoxPlotLayer("bp");
    const vp = makeViewport();
    vp.beginScan();
    layer.setData(boxes([1, 12, 30, 50, 70, 88]), 6, vp);
    layer.scan(vp);
    expect(vp.observedYMin).toBeLessThanOrEqual(12);
    expect(vp.observedYMax).toBeGreaterThanOrEqual(88);
  });

  it("honours color, lineColor, opacity, boxWidth, capRatio, lineWidth", () => {
    const layer = new BoxPlotLayer("bp");
    layer.setConfig({
      color: "#abcdef",
      lineColor: "#123456",
      fillOpacity: 0.5,
      boxWidth: 40,
      capRatio: 0.8,
      lineWidth: 3,
    });
    const vp = makeViewport();
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("clamps boxWidth, lineWidth, and capRatio", () => {
    const layer = new BoxPlotLayer("bp");
    layer.setConfig({ boxWidth: 0, lineWidth: 0, capRatio: 5 });
    const vp = makeViewport();
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("clamps a negative capRatio to 0", () => {
    const layer = new BoxPlotLayer("bp");
    layer.setConfig({ capRatio: -1 });
    const vp = makeViewport();
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    expect(() => draw(layer, vp)).not.toThrow();
  });

  it("hidden layer skips scan and draw", () => {
    const layer = new BoxPlotLayer("bp");
    layer.setConfig({ visible: false });
    const vp = makeViewport();
    vp.beginScan();
    const before = vp.observedYMax;
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    layer.scan(vp);
    expect(vp.observedYMax).toBe(before);
    const ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("ignores sub-stride buffers", () => {
    const layer = new BoxPlotLayer("bp");
    const vp = makeViewport();
    layer.setData(new Float32Array([1, 2, 3]).buffer, 3, vp); // < 6
    vp.beginScan();
    layer.scan(vp);
    const ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("clearData and dispose empty the dataset", () => {
    const layer = new BoxPlotLayer("bp");
    const vp = makeViewport();
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    layer.clearData();
    let ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
    layer.setData(boxes([1, 10, 30, 50, 70, 90]), 6, vp);
    layer.dispose();
    ctx = draw(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("resize is a no-op", () => {
    expect(() => new BoxPlotLayer("bp").resize(makeViewport())).not.toThrow();
  });
});
