import { describe, expect, it } from "vitest";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx } from "../../../test/setup";
import { OccupancyGridLayer } from "./occupancy-grid-layer";

function makeViewport() {
  const v = new Viewport();
  v.setSize(800, 400, 1);
  v.setBounds({ xMin: -1, xMax: 5, yMin: -1, yMax: 5 });
  return v;
}

/** Build [originX, originY, resolution, cols, rows, ...cells]. */
function grid(
  originX: number,
  originY: number,
  res: number,
  cols: number,
  rows: number,
  cells: number[],
): ArrayBuffer {
  const buf = new Float32Array(5 + cells.length);
  buf[0] = originX;
  buf[1] = originY;
  buf[2] = res;
  buf[3] = cols;
  buf[4] = rows;
  buf.set(cells, 5);
  return buf.buffer as ArrayBuffer;
}

function drawGrid(layer: OccupancyGridLayer, vp: Viewport) {
  const ctx = createFakeCtx();
  layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
  return ctx;
}

describe("OccupancyGridLayer", () => {
  it("constructor assigns id", () => {
    expect(new OccupancyGridLayer("og").id).toBe("og");
  });

  it("draws one fillRect per cell", () => {
    const layer = new OccupancyGridLayer("og");
    const vp = makeViewport();
    // 2×2 grid: free, occupied, unknown, mid
    layer.setData(grid(0, 0, 1, 2, 2, [0, 100, -1, 50]), 9, vp);
    const ctx = drawGrid(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "fillRect").length).toBe(4);
  });

  it("uses unknownColor for negative cells", () => {
    const layer = new OccupancyGridLayer("og");
    layer.setConfig({ unknownColor: "#123456" });
    const vp = makeViewport();
    layer.setData(grid(0, 0, 1, 1, 1, [-1]), 6, vp);
    const ctx = drawGrid(layer, vp);
    // the fill before the rect should be the unknown color
    const fills = ctx.calls.filter((c) => c.name === "fillRect");
    expect(fills.length).toBe(1);
  });

  it("interpolates free→occupied colors for 0..100 cells", () => {
    const layer = new OccupancyGridLayer("og");
    layer.setConfig({ freeColor: "#000000", occupiedColor: "#ffffff" });
    const vp = makeViewport();
    layer.setData(grid(0, 0, 1, 1, 1, [50]), 6, vp);
    expect(() => drawGrid(layer, vp)).not.toThrow();
  });

  it("draws grid lines when showGridLines is on", () => {
    const layer = new OccupancyGridLayer("og");
    layer.setConfig({ showGridLines: true, gridLineColor: "#fff" });
    const vp = makeViewport();
    layer.setData(grid(0, 0, 1, 2, 1, [0, 100]), 7, vp);
    const ctx = drawGrid(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "strokeRect").length).toBe(2);
  });

  it("setData surfaces the world y-extent to the viewport", () => {
    const layer = new OccupancyGridLayer("og");
    const vp = makeViewport();
    vp.beginScan();
    layer.setData(grid(0, -2, 1, 1, 4, [0, 0, 0, 0]), 9, vp); // y spans -2..2
    expect(vp.observedYMin).toBeLessThanOrEqual(-2);
    expect(vp.observedYMax).toBeGreaterThanOrEqual(2);
  });

  it("hidden layer skips draw", () => {
    const layer = new OccupancyGridLayer("og");
    layer.setConfig({ visible: false });
    const vp = makeViewport();
    layer.setData(grid(0, 0, 1, 1, 1, [50]), 6, vp);
    const ctx = drawGrid(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("ignores too-short buffers and zero dimensions", () => {
    const layer = new OccupancyGridLayer("og");
    const vp = makeViewport();
    // header only, no cells (length 5 < 6)
    layer.setData(new Float32Array([0, 0, 1, 0, 0]).buffer, 5, vp);
    let ctx = drawGrid(layer, vp);
    expect(ctx.calls.length).toBe(0);
    // cols/rows zero
    layer.setData(grid(0, 0, 1, 0, 0, [1]), 6, vp);
    ctx = drawGrid(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("stops at the buffer end when cells are truncated", () => {
    const layer = new OccupancyGridLayer("og");
    const vp = makeViewport();
    // claims 2×2 = 4 cells but only 2 provided → draws the available 2
    const buf = new Float32Array([0, 0, 1, 2, 2, 10, 20]);
    layer.setData(buf.buffer as ArrayBuffer, 7, vp);
    const ctx = drawGrid(layer, vp);
    expect(ctx.calls.filter((c) => c.name === "fillRect").length).toBe(2);
  });

  it("clearData and dispose empty the grid", () => {
    const layer = new OccupancyGridLayer("og");
    const vp = makeViewport();
    layer.setData(grid(0, 0, 1, 1, 1, [50]), 6, vp);
    layer.clearData();
    let ctx = drawGrid(layer, vp);
    expect(ctx.calls.length).toBe(0);
    layer.setData(grid(0, 0, 1, 1, 1, [50]), 6, vp);
    layer.dispose();
    ctx = drawGrid(layer, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("resize is a no-op", () => {
    const layer = new OccupancyGridLayer("og");
    expect(() => layer.resize(makeViewport())).not.toThrow();
  });
});

it("accepts an incomplete grid header without publishing an invalid extent", () => {
  const layer = new OccupancyGridLayer("grid"),
    vp = new Viewport();
  layer.setData(new Float32Array([1, 2]).buffer, 2, vp);
  expect(vp.latestT).toBe(0);
  layer.dispose();
});
