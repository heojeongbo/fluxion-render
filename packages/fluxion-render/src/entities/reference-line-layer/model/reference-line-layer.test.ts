import { describe, expect, it } from "vitest";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx, labelDraws } from "../../../test/setup";
import { ReferenceLineLayer } from "./reference-line-layer";

function makeViewport() {
  const v = new Viewport();
  v.setSize(800, 200, 1);
  v.setBounds({ xMin: 0, xMax: 5000, yMin: 0, yMax: 100 });
  return v;
}

describe("ReferenceLineLayer", () => {
  it("draws a horizontal line at the configured y value", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    const moveTos = ctx.calls.filter((c) => c.name === "moveTo");
    const lineTos = ctx.calls.filter((c) => c.name === "lineTo");
    expect(moveTos.length).toBe(1);
    expect(lineTos.length).toBe(1);
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
  });

  it("uses configured color", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, color: "#ff0000" });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.strokeStyle).toBe("#ff0000");
  });

  it("draws band rect when bandMin and bandMax are set", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, bandMin: 40, bandMax: 60 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(true);
  });

  it("does not draw band when only bandMin is set (no bandMax)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, bandMin: 40 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(false);
  });

  it("draws label text when label is configured", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, label: "setpoint" });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    const labels = labelDraws(ctx);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]!.text).toBe("setpoint");
  });

  it("visible: false skips all drawing", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, visible: false });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.length).toBe(0);
  });

  it("setData is a no-op (config-only layer)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50 });
    const vp = makeViewport();
    // setData should not throw and should not affect draw behavior
    layer.setData(new Float32Array([1, 2, 3]).buffer, 3, vp);
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
  });

  it("scan is a no-op (does not modify observed y extents)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 999 });
    const vp = makeViewport();
    vp.beginScan();
    layer.scan(vp);
    expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("y position maps correctly: y=100 should be at canvas top (py near 0)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 100 });
    const vp = makeViewport();
    // vp: yMin=0, yMax=100, height=200px → y=100 maps to py≈0
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    const moveTo = ctx.calls.find((c) => c.name === "moveTo");
    expect(moveTo).toBeDefined();
    expect(moveTo!.args[1]).toBeCloseTo(0, 1);
  });

  it("y position maps correctly: y=0 should be at canvas bottom (py≈height)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 0 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    const moveTo = ctx.calls.find((c) => c.name === "moveTo");
    expect(moveTo).toBeDefined();
    expect(moveTo!.args[1]).toBeCloseTo(200, 1);
  });

  it("uses setLineDash for dashed line style", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.some((c) => c.name === "setLineDash")).toBe(true);
  });

  it("applies lineWidth config (clamped to a 0.5 minimum)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, lineWidth: 0.1 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.lineWidth).toBe(0.5);
  });

  it("applies bandOpacity config (clamped to 0..1)", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50, bandMin: 40, bandMax: 60, bandOpacity: 5 });
    const vp = makeViewport();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    // Clamped to 1 — band is drawn at full opacity.
    expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(true);
  });

  it("dispose is a no-op and does not throw", () => {
    const layer = new ReferenceLineLayer("ref");
    layer.setConfig({ y: 50 });
    expect(() => layer.dispose()).not.toThrow();
  });
});
