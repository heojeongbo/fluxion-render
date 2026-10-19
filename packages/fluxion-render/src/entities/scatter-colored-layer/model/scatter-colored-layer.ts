import { hexToRgb } from "../../../shared/lib/colormap";
import { pushSamples } from "../../../shared/lib/push-samples";
import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export type { ScatterColoredConfig } from "../../../shared/model/layer-configs";

import type { ScatterColoredConfig } from "../../../shared/model/layer-configs";

/**
 * Streaming scatter layer with per-point color and size encoding.
 *
 * Data layout: Float32Array `[t, y, colorValue, size, ...]` stride=4.
 * - `colorValue`: 0–1 normalised, mapped via colormap LUT.
 * - `size`: 0–1 normalised, interpolated between `minSize` and `maxSize`.
 *
 * Useful for encoding a third variable (speed, uncertainty, force magnitude)
 * onto a 2-D scatter plot without a separate axis.
 */
export class ScatterColoredLayer implements Layer {
  readonly id: string;
  private colormap: "viridis" | "plasma" | "hot" | "gradient" = "viridis";
  private lut: Uint8Array = VIRIDIS_LUT;
  private minSize = 2;
  private maxSize = 8;
  private shape: "square" | "circle" = "circle";
  private visible = true;
  private ring: RingBuffer;

  constructor(id: string) {
    this.id = id;
    this.ring = new RingBuffer(4096, 4);
  }

  setConfig(config: unknown): void {
    const c = config as ScatterColoredConfig;
    if (c.colormap !== undefined) {
      this.colormap = c.colormap;
      if (c.colormap === "gradient") {
        this.lut = buildGradientLut(c.minColor ?? "#0000ff", c.maxColor ?? "#ff0000");
      } else {
        this.lut =
          c.colormap === "plasma"
            ? PLASMA_LUT
            : c.colormap === "hot"
              ? HOT_LUT
              : VIRIDIS_LUT;
      }
    }
    if (c.minColor !== undefined && this.colormap === "gradient") {
      this.lut = buildGradientLut(c.minColor, c.maxColor ?? "#ff0000");
    }
    if (c.maxColor !== undefined && this.colormap === "gradient") {
      this.lut = buildGradientLut(c.minColor ?? "#0000ff", c.maxColor);
    }
    if (c.minSize !== undefined) this.minSize = Math.max(1, c.minSize);
    if (c.maxSize !== undefined) this.maxSize = Math.max(1, c.maxSize);
    if (c.shape !== undefined) this.shape = c.shape;
    if (c.visible !== undefined) this.visible = c.visible;
    const newCapacity = computeRingCapacity(c);
    if (newCapacity !== undefined && newCapacity !== this.ring.capacity) {
      this.ring = new RingBuffer(newCapacity, 4);
    }
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    pushSamples(this.ring, buffer, length, viewport, 4);
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;
    const xMin = viewport.bounds.xMin;
    let localMin = viewport.observedYMin;
    let localMax = viewport.observedYMax;
    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      const y = data[off + 1];
      if (y < localMin) localMin = y;
      if (y > localMax) localMax = y;
    });
    viewport.observedYMin = localMin;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;

    const xMin = viewport.bounds.xMin;
    const lut = this.lut;
    const sizeRange = this.maxSize - this.minSize;
    const minSize = this.minSize;
    const isCircle = this.shape === "circle";

    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      const px = viewport.xToPx(t);
      const py = viewport.yToPx(data[off + 1]);
      const colorVal = Math.max(0, Math.min(1, data[off + 2]!));
      const sizeVal = Math.max(0, Math.min(1, data[off + 3]!));

      const lutIdx = Math.floor(colorVal * 255) * 3;
      ctx.fillStyle = `rgb(${lut[lutIdx]},${lut[lutIdx + 1]},${lut[lutIdx + 2]})`;

      const size = minSize + sizeVal * sizeRange;
      const half = size / 2;

      ctx.beginPath();
      if (isCircle) {
        ctx.arc(px, py, half, 0, Math.PI * 2);
      } else {
        ctx.rect(px - half, py - half, size, size);
      }
      ctx.fill();
    });
  }

  clearData(): void {
    this.ring.clear();
  }

  dispose(): void {
    this.ring.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildGradientLut(fromHex: string, toHex: string): Uint8Array {
  const [r0, g0, b0] = hexToRgb(fromHex);
  const [r1, g1, b1] = hexToRgb(toHex);
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = i / 255;
    out[i * 3] = Math.round(r0 + (r1 - r0) * f);
    out[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    out[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return out;
}

function buildLut(stops: [number, number, number, number][]): Uint8Array {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 1 && stops[j + 1]![0]! < t) j++;
    const [t0, r0, g0, b0] = stops[j]!;
    const [t1, r1, g1, b1] = stops[Math.min(j + 1, stops.length - 1)]!;
    /* v8 ignore start -- t0===t1 unreachable: stop times strictly increasing, j capped at length-2 */
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    /* v8 ignore stop */
    out[i * 3] = Math.round(r0 + (r1 - r0) * f);
    out[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    out[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return out;
}

const VIRIDIS_LUT = buildLut([
  [0.0, 68, 1, 84],
  [0.25, 59, 82, 139],
  [0.5, 33, 145, 140],
  [0.75, 94, 201, 98],
  [1.0, 253, 231, 37],
]);

const PLASMA_LUT = buildLut([
  [0.0, 13, 8, 135],
  [0.25, 126, 3, 168],
  [0.5, 204, 71, 120],
  [0.75, 248, 149, 64],
  [1.0, 240, 249, 33],
]);

const HOT_LUT = buildLut([
  [0.0, 0, 0, 0],
  [0.333, 255, 0, 0],
  [0.667, 255, 255, 0],
  [1.0, 255, 255, 255],
]);
