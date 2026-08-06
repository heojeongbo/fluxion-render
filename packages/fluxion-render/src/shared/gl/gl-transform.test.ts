import { describe, expect, it } from "vitest";
import { Viewport } from "../model/viewport";
import { type ClipTransform, dataToClip, laneToClip, pxToClip } from "./gl-transform";

/** Apply the shader affine on the CPU: clip = (v - o) * s + t. */
function apply(t: ClipTransform, x: number, y: number): [number, number] {
  return [(x - t[0]!) * t[2]! + t[4]!, (y - t[1]!) * t[3]! + t[5]!];
}

/**
 * Data-space vertices carry an xMin-relative delta (buildLineVertices), so the
 * shader receives `x - xMin`, not raw `x`. This mirrors what the GPU sees.
 */
function applyData(
  t: ClipTransform,
  v: Viewport,
  x: number,
  y: number,
): [number, number] {
  return apply(t, x - v.bounds.xMin, y);
}

/** The clip-space point the 2d path's pixel coordinates land on. */
function pxToClipSpace(v: Viewport, px: number, py: number): [number, number] {
  return [(2 * px) / v.widthPx - 1, 1 - (2 * py) / v.heightPx];
}

/**
 * Float64 out-buffer: verifies the FORMULA mirrors Viewport exactly (1e-9),
 * isolated from Float32Array coefficient quantization (checked separately).
 */
function f64(): ClipTransform {
  return new Float64Array(6) as unknown as ClipTransform;
}

describe("gl-transform", () => {
  it("dataToClip mirrors Viewport.xToPx/yToPx exactly (plain viewport)", () => {
    const v = new Viewport();
    v.setSize(800, 400, 2);
    v.setBounds({ xMin: 1000, xMax: 6000, yMin: -2, yMax: 3 });
    const t = f64();
    dataToClip(v, 0, t);
    for (const [x, y] of [
      [1000, -2],
      [6000, 3],
      [3500, 0.5],
      [1234.5, -1.25],
    ] as const) {
      const [cx, cy] = applyData(t, v, x, y);
      const [ex, ey] = pxToClipSpace(v, v.xToPx(x), v.yToPx(y));
      expect(Math.abs(cx - ex)).toBeLessThan(1e-9);
      expect(Math.abs(cy - ey)).toBeLessThan(1e-9);
    }
  });

  it("dataToClip honors inline insets, yPadPx, and yOffset", () => {
    const v = new Viewport();
    v.setSize(300, 200, 1);
    v.insetLeft = 44;
    v.insetBottom = 26;
    v.yPadPx = 8;
    v.setBounds({ xMin: 0, xMax: 5000, yMin: 0, yMax: 10 });
    const yOffset = 2.5;
    const t = f64();
    dataToClip(v, yOffset, t);
    for (const [x, y] of [
      [0, 0],
      [5000, 10],
      [2000, 4],
    ] as const) {
      // The 2d path draws yToPx(y + yOffset) — the transform must match that.
      const [cx, cy] = applyData(t, v, x, y);
      const [ex, ey] = pxToClipSpace(v, v.xToPx(x), v.yToPx(y + yOffset));
      expect(Math.abs(cx - ex)).toBeLessThan(1e-9);
      expect(Math.abs(cy - ey)).toBeLessThan(1e-9);
    }
  });

  it("dataToClip guards degenerate spans like Viewport (`|| 1`)", () => {
    const v = new Viewport();
    v.setSize(100, 100, 1);
    v.setBounds({ xMin: 5, xMax: 5, yMin: 1, yMax: 1 });
    const t = f64();
    dataToClip(v, 0, t);
    const [cx, cy] = applyData(t, v, 5, 1);
    const [ex, ey] = pxToClipSpace(v, v.xToPx(5), v.yToPx(1));
    expect(cx).toBeCloseTo(ex, 9);
    expect(cy).toBeCloseTo(ey, 9);
    expect(Number.isFinite(cx) && Number.isFinite(cy)).toBe(true);
  });

  it("laneToClip maps [lo, hi] onto the pixel band [bandTop, bandBottom]", () => {
    const v = new Viewport();
    v.setSize(500, 240, 1);
    v.setBounds({ xMin: 0, xMax: 1000, yMin: -1, yMax: 1 });
    const bandTop = 43;
    const bandBottom = 117;
    const lo = -0.4;
    const hi = 2.6;
    const t = f64();
    laneToClip(v, bandTop, bandBottom, lo, hi, t);
    // hi → bandTop, lo → bandBottom (screen y grows downward), mid → mid.
    const cases: Array<[number, number]> = [
      [hi, bandTop],
      [lo, bandBottom],
      [(lo + hi) / 2, (bandTop + bandBottom) / 2],
    ];
    for (const [y, py] of cases) {
      const [, cy] = apply(t, 0, y);
      const [, ey] = pxToClipSpace(v, 0, py);
      expect(Math.abs(cy - ey)).toBeLessThan(1e-9);
    }
    // x mapping is the shared plot mapping.
    const [cx] = applyData(t, v, 250, lo);
    const [ex] = pxToClipSpace(v, v.xToPx(250), 0);
    expect(Math.abs(cx - ex)).toBeLessThan(1e-9);
  });

  it("laneToClip guards flat lane extents and degenerate x spans (`|| 1`)", () => {
    const v = new Viewport();
    v.setSize(100, 100, 1);
    v.setBounds({ xMin: 5, xMax: 5, yMin: 0, yMax: 1 });
    const t = f64();
    laneToClip(v, 10, 50, 3, 3, t);
    const [cx, cy] = applyData(t, v, 5, 3);
    expect(Number.isFinite(cx)).toBe(true);
    expect(Number.isFinite(cy)).toBe(true);
  });

  it("pxToClip maps CSS px to clip space (top-left → (-1, 1))", () => {
    const v = new Viewport();
    v.setSize(320, 180, 2);
    const t = f64();
    pxToClip(v, t);
    expect(apply(t, 0, 0)).toEqual([-1, 1]);
    expect(apply(t, 320, 180)).toEqual([1, -1]);
    expect(apply(t, 160, 90)).toEqual([0, 0]);
  });

  it("keeps sub-0.01px accuracy through fp32 storage past the 2^24 ms cliff", () => {
    const v = new Viewport();
    v.setSize(800, 400, 2);
    // ~13.9 hours of host-relative ms — WELL past 2^24 (4.66 h), where a raw fp32
    // `t` skips whole milliseconds and the shader's large-minus-large subtraction
    // collapses adjacent samples. The delta VBO (t - xMin) sidesteps both.
    const t0 = 50_000_000;
    v.setBounds({ xMin: t0, xMax: t0 + 5000, yMin: -1, yMax: 1 });
    const t = new Float32Array(6);
    dataToClip(v, 0, t);
    for (const x of [t0, t0 + 1234, t0 + 5000]) {
      // fp32 delta vertex + fp32 coefficients, exactly what the GPU computes:
      // buildLineVertices stores fround(x - xMin); the transform's x-origin is 0.
      const vert = Math.fround(x - v.bounds.xMin);
      const cx = (vert - t[0]!) * t[2]! + t[4]!;
      const expectedPx = v.xToPx(x);
      const gotPx = ((cx + 1) / 2) * v.widthPx;
      expect(Math.abs(gotPx - expectedPx)).toBeLessThan(0.01);
    }
    // Sanity: the raw-t encoding this replaced loses a 1 ms distinction here
    // (fp32 ulp at ~50 M ms is 4 ms), while the delta stores it exactly.
    expect(Math.fround(t0 + 1)).toBe(Math.fround(t0)); // raw: 1 ms collapsed
    expect(Math.fround(t0 + 1 - t0)).toBe(1); // delta: 1 ms preserved
  });
});
