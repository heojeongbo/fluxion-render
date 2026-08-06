/**
 * Uniform math for the WebGL vertex shader's affine `(aPos - uOrigin) *
 * uScale + uOffset` — pure functions that mirror `Viewport.xToPx`/`yToPx`
 * EXACTLY (including inline-axes insets and `yPadPx`), so GL geometry lands on
 * the same pixels the 2d path strokes.
 *
 * The data-space writers set the **x-origin to 0** because their vertices carry
 * an xMin-relative delta (`t - xMin`), pre-subtracted on the CPU by
 * `buildLineVertices` where the full-precision `t` is still available — the
 * shader's fp32 `aPos - uOrigin` cannot recover precision already lost casting a
 * large raw `t` into the fp32 VBO. The y-origin still carries `yMin`/`lo`
 * (small, no fp32 hazard).
 *
 * All writers fill a caller-provided 6-slot array `[ox, oy, sx, sy, tx, ty]`
 * so per-frame hot paths allocate nothing.
 */
import type { Viewport } from "../model/viewport";

/** clip = (value - o) * s + t, per axis. */
export type ClipTransform = Float32Array; // [ox, oy, sx, sy, tx, ty]

/**
 * Data-space transform for a layer drawing raw `(t, y)` vertices with the
 * shared chart bounds (plus this layer's `yOffset` shift).
 */
export function dataToClip(
  viewport: Viewport,
  yOffset: number,
  out: ClipTransform,
): void {
  const { xMin, xMax, yMin, yMax } = viewport.bounds;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const pad = viewport.yPadPx;
  const usable = viewport.heightPx - viewport.insetBottom - pad * 2;
  out[0] = 0; // vertices are xMin-relative deltas (buildLineVertices)
  out[1] = yMin - yOffset;
  out[2] = (2 * viewport.plotWidth) / (xSpan * viewport.widthPx);
  out[3] = (2 * usable) / (ySpan * viewport.heightPx);
  out[4] = (2 * viewport.insetLeft) / viewport.widthPx - 1;
  out[5] = 1 - (2 * (pad + usable)) / viewport.heightPx;
}

/**
 * Lane-mode transform: this layer's own `[lo, hi]` y-extent maps into the
 * pixel band `[bandTop, bandBottom]` (CSS px, top < bottom) — mirrors
 * `LineChartLayer.yToBandPx`.
 */
export function laneToClip(
  viewport: Viewport,
  bandTop: number,
  bandBottom: number,
  lo: number,
  hi: number,
  out: ClipTransform,
): void {
  const { xMin, xMax } = viewport.bounds;
  const xSpan = xMax - xMin || 1;
  const span = hi - lo || 1;
  out[0] = 0; // vertices are xMin-relative deltas (buildLineVertices)
  out[1] = lo;
  out[2] = (2 * viewport.plotWidth) / (xSpan * viewport.widthPx);
  out[3] = (2 * (bandBottom - bandTop)) / (span * viewport.heightPx);
  out[4] = (2 * viewport.insetLeft) / viewport.widthPx - 1;
  out[5] = 1 - (2 * bandBottom) / viewport.heightPx;
}

/** CSS-px-space transform (grid lines, ticks, label quads). */
export function pxToClip(viewport: Viewport, out: ClipTransform): void {
  out[0] = 0;
  out[1] = 0;
  out[2] = 2 / viewport.widthPx;
  out[3] = -2 / viewport.heightPx;
  out[4] = -1;
  out[5] = 1;
}
