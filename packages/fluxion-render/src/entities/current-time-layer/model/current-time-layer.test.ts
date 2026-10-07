import { describe, expect, it, vi } from "vitest";
import type { GlRenderer } from "../../../shared/gl/gl-renderer";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx } from "../../../test/setup";
import { CurrentTimeLayer } from "./current-time-layer";

function setup(config = {}) {
  const layer = new CurrentTimeLayer("now");
  layer.setConfig(config);
  const viewport = new Viewport();
  viewport.setSize(800, 200, 2);
  viewport.setBounds({ xMin: 0, xMax: 10000, yMin: -1, yMax: 1 });
  const ctx = createFakeCtx();
  const draw = () =>
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, viewport);
  return { layer, viewport, ctx, draw };
}

describe("CurrentTimeLayer", () => {
  it("positions replay time in the plot and keeps axis strips clear", () => {
    const { layer, viewport, ctx, draw } = setup({
      currentTime: 5000,
      color: "#123456",
      lineWidth: 4,
    });
    viewport.insetLeft = 32;
    viewport.insetBottom = 14;
    draw();
    expect(ctx.calls.find((c) => c.name === "moveTo")?.args).toEqual([
      expect.closeTo(416),
      0,
    ]);
    expect(ctx.calls.find((c) => c.name === "lineTo")?.args).toEqual([
      expect.closeTo(416),
      186,
    ]);
    expect(ctx.strokeStyle).toBe("#123456");
    expect(ctx.lineWidth).toBe(4);
    expect(layer.needsContinuousRender()).toBe(false);
    layer.setData(new ArrayBuffer(0), 0, viewport);
    layer.resize(viewport);
    layer.dispose();
    expect(viewport.latestT).toBe(0);
  });

  it("advances without data, switches to replay and resumes live with null", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000500);
    const { layer, ctx, draw } = setup({ timeOrigin: 1000000 });
    expect(layer.needsContinuousRender()).toBe(true);
    draw();
    now.mockReturnValue(1001000);
    draw();
    expect(ctx.calls.filter((c) => c.name === "moveTo").map((c) => c.args[0])).toEqual([
      40, 80,
    ]);
    layer.setConfig({ currentTime: 2500 });
    expect(layer.needsContinuousRender()).toBe(false);
    layer.setConfig({ currentTime: null });
    expect(layer.needsContinuousRender()).toBe(true);
    now.mockRestore();
  });

  it("uses the follow-clock axis epoch, including the fully visible right edge", () => {
    const { viewport, ctx, draw } = setup({ timeOrigin: 1000000 });
    viewport.clockTime = 1010000;
    draw();
    expect(ctx.calls.find((c) => c.name === "moveTo")?.args).toEqual([799, 0]);
  });

  it("keeps the left edge visible and handles bars wider than the plot", () => {
    const { layer, viewport, ctx, draw } = setup({ currentTime: 0, lineWidth: -2 });
    draw();
    expect(ctx.lineWidth).toBe(0.5);
    expect(ctx.calls.find((c) => c.name === "moveTo")?.args[0]).toBe(0.25);
    layer.setConfig({ lineWidth: Number.NaN });
    draw();
    expect(ctx.lineWidth).toBe(0.5);
    layer.setConfig({ lineWidth: 1000 });
    viewport.insetLeft = 798;
    draw();
    expect(ctx.lineWidth).toBe(2);
  });

  it.each([
    {},
    { currentTime: -1 },
    { currentTime: 10001 },
    { currentTime: Number.NaN },
    { timeOrigin: Number.POSITIVE_INFINITY },
    { currentTime: 100, visible: false },
  ])("does not draw invalid, unconfigured, out-of-window or hidden bars: %j", (config) => {
    const { layer, ctx, draw, viewport } = setup(config);
    draw();
    const glr = { drawTriangles: vi.fn() } as unknown as GlRenderer;
    layer.drawGl(glr, viewport);
    expect(ctx.calls).toHaveLength(0);
    expect(glr.drawTriangles).not.toHaveBeenCalled();
    expect(layer.needsContinuousRender()).toBe(false);
  });

  it("does not draw degenerate bounds or empty plot areas", () => {
    const { viewport, ctx, draw } = setup({ currentTime: 0 });
    for (const bounds of [
      { xMin: 0, xMax: 0 },
      { xMin: Number.NaN, xMax: 10 },
      { xMin: 0, xMax: Number.POSITIVE_INFINITY },
    ]) {
      viewport.setBounds({ ...bounds, yMin: 0, yMax: 1 });
      draw();
    }
    viewport.setBounds({ xMin: 0, xMax: 10000, yMin: 0, yMax: 1 });
    viewport.insetBottom = 200;
    draw();
    viewport.insetBottom = 0;
    viewport.insetLeft = 800;
    draw();
    expect(ctx.calls).toHaveLength(0);
  });

  it("renders matching WebGL geometry, reusing buffers across updates", () => {
    const { layer, viewport } = setup({ currentTime: 5000 });
    viewport.insetLeft = 32;
    viewport.insetBottom = 14;
    const color = [1, 0, 0, 1];
    const glr = { drawTriangles: vi.fn(), resolveColor: vi.fn(() => color) };
    layer.drawGl(glr as unknown as GlRenderer, viewport);
    const args = glr.drawTriangles.mock.calls[0]!;
    expect(Array.from(args[0])).toEqual([
      415, 0, 417, 0, 415, 186, 415, 186, 417, 0, 417, 186,
    ]);
    expect(args.slice(3)).toEqual([color]);
    layer.setConfig({ currentTime: 7500 });
    layer.drawGl(glr as unknown as GlRenderer, viewport);
    expect(glr.drawTriangles.mock.calls[1]![0]).toBe(args[0]);
  });
});
