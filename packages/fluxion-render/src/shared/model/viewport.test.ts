import { describe, expect, it } from "vitest";
import { Viewport } from "./viewport";

describe("Viewport", () => {
  it("initializes with unit bounds and zero size", () => {
    const v = new Viewport();
    expect(v.widthPx).toBe(0);
    expect(v.heightPx).toBe(0);
    expect(v.dpr).toBe(1);
    expect(v.bounds).toEqual({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
    expect(v.latestT).toBe(0);
  });

  it("latestT is a mutable monotonic field", () => {
    const v = new Viewport();
    v.latestT = 1000;
    expect(v.latestT).toBe(1000);
    v.latestT = 2500;
    expect(v.latestT).toBe(2500);
  });

  it("observedYMin/Max initialized to +/- Infinity", () => {
    const v = new Viewport();
    expect(v.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(v.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("beginScan resets observed y extents", () => {
    const v = new Viewport();
    v.observedYMin = -5;
    v.observedYMax = 10;
    v.beginScan();
    expect(v.observedYMin).toBe(Number.POSITIVE_INFINITY);
    expect(v.observedYMax).toBe(Number.NEGATIVE_INFINITY);
  });

  it("setSize updates dimensions and dpr", () => {
    const v = new Viewport();
    v.setSize(800, 600, 2);
    expect(v.widthPx).toBe(800);
    expect(v.heightPx).toBe(600);
    expect(v.dpr).toBe(2);
  });

  it("xToPx maps world x linearly", () => {
    const v = new Viewport();
    v.setSize(100, 100, 1);
    v.setBounds({ xMin: 0, xMax: 10, yMin: 0, yMax: 10 });
    expect(v.xToPx(0)).toBeCloseTo(0);
    expect(v.xToPx(10)).toBeCloseTo(100);
    expect(v.xToPx(5)).toBeCloseTo(50);
  });

  it("yToPx flips Y axis (world up -> screen down)", () => {
    const v = new Viewport();
    v.setSize(100, 100, 1);
    v.setBounds({ xMin: 0, xMax: 10, yMin: 0, yMax: 10 });
    expect(v.yToPx(0)).toBeCloseTo(100);
    expect(v.yToPx(10)).toBeCloseTo(0);
    expect(v.yToPx(5)).toBeCloseTo(50);
  });

  it("handles negative world bounds", () => {
    const v = new Viewport();
    v.setSize(200, 200, 1);
    v.setBounds({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 });
    expect(v.xToPx(-10)).toBeCloseTo(0);
    expect(v.xToPx(10)).toBeCloseTo(200);
    expect(v.xToPx(0)).toBeCloseTo(100);
    expect(v.yToPx(0)).toBeCloseTo(100);
  });

  it("degenerate bounds (xMin===xMax / yMin===yMax) yield finite pixels, not NaN", () => {
    const v = new Viewport();
    v.setSize(100, 100, 1);
    // Zero-span bounds would divide by zero; the `|| 1` guard keeps it finite.
    v.setBounds({ xMin: 5, xMax: 5, yMin: 5, yMax: 5 });
    expect(Number.isFinite(v.xToPx(5))).toBe(true);
    expect(Number.isFinite(v.yToPx(5))).toBe(true);
    expect(v.xToPx(5)).toBe(0); // (5-5)/1 * 100 = 0
  });

  describe("inline-axes plot insets", () => {
    it("defaults keep the plot rect equal to the full canvas", () => {
      const v = new Viewport();
      v.setSize(200, 100, 1);
      expect(v.plotLeft).toBe(0);
      expect(v.plotBottom).toBe(100);
      expect(v.plotWidth).toBe(200);
      expect(v.plotHeight).toBe(100);
    });

    it("xToPx maps into [insetLeft, widthPx]", () => {
      const v = new Viewport();
      v.setSize(200, 100, 1);
      v.insetLeft = 60;
      v.setBounds({ xMin: 0, xMax: 10, yMin: 0, yMax: 10 });
      expect(v.xToPx(0)).toBe(60);
      expect(v.xToPx(10)).toBe(200);
      expect(v.xToPx(5)).toBe(130);
      expect(v.plotLeft).toBe(60);
      expect(v.plotWidth).toBe(140);
    });

    it("yToPx maps into [0, heightPx - insetBottom], with yPadPx nested inside", () => {
      const v = new Viewport();
      v.setSize(200, 130, 1);
      v.insetBottom = 30;
      v.setBounds({ xMin: 0, xMax: 10, yMin: 0, yMax: 10 });
      expect(v.yToPx(0)).toBe(100); // plot bottom
      expect(v.yToPx(10)).toBe(0); // plot top
      expect(v.plotBottom).toBe(100);
      expect(v.plotHeight).toBe(100);

      v.yPadPx = 10; // breathing room INSIDE the plot rect
      expect(v.yToPx(0)).toBe(90);
      expect(v.yToPx(10)).toBe(10);
    });
  });
});
