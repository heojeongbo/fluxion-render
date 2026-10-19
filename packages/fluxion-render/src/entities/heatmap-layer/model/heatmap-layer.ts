import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { HeatmapConfig } from "../../../shared/model/layer-configs";

import type { HeatmapConfig } from "../../../shared/model/layer-configs";

/**
 * Static heatmap. Replaces the entire grid on each `setData` call.
 * Data layout: `Float32Array [x, y, value, x, y, value, ...]` stride=3.
 * Each cell is rendered as a filled rectangle sized `cellWidth × cellHeight`
 * centred on (x, y) in data space. Value is mapped to colour via a 256-entry LUT.
 */
export class HeatmapLayer implements Layer {
  readonly id: string;
  private cellWidth = 8;
  private cellHeight = 8;
  private minValue: number | undefined;
  private maxValue: number | undefined;
  private colormap: "viridis" | "plasma" | "hot" = "viridis";
  // Cached `rgb(...)` string per LUT entry — avoids building one string per cell
  // per frame (a dense heatmap can have tens of thousands of cells).
  private lutStrings: string[] = VIRIDIS_STRINGS;
  private visible = true;
  private data: Float32Array = new Float32Array(0);
  private dataLength = 0;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as HeatmapConfig;
    if (c.cellWidth !== undefined) this.cellWidth = Math.max(1, c.cellWidth);
    if (c.cellHeight !== undefined) this.cellHeight = Math.max(1, c.cellHeight);
    if (c.minValue !== undefined) this.minValue = c.minValue;
    if (c.maxValue !== undefined) this.maxValue = c.maxValue;
    if (c.visible !== undefined) this.visible = c.visible;
    if (c.colormap !== undefined) {
      this.colormap = c.colormap;
      this.lutStrings =
        c.colormap === "plasma"
          ? PLASMA_STRINGS
          : c.colormap === "hot"
            ? HOT_STRINGS
            : VIRIDIS_STRINGS;
    }
  }

  setData(buffer: ArrayBuffer, length: number, _viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.dataLength = length;
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.dataLength === 0) return;
    // Update y observed bounds from y coords in the data so axis-grid auto mode works.
    let localMin = viewport.observedYMin;
    let localMax = viewport.observedYMax;
    for (let i = 1; i + 2 < this.dataLength; i += 3) {
      const y = this.data[i];
      if (y < localMin) localMin = y;
      if (y > localMax) localMax = y;
    }
    viewport.observedYMin = localMin;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.dataLength < 3) return;

    // Determine value range for normalization (auto if not configured).
    let vMin = this.minValue;
    let vMax = this.maxValue;
    if (vMin === undefined || vMax === undefined) {
      let autoMin = Number.POSITIVE_INFINITY;
      let autoMax = Number.NEGATIVE_INFINITY;
      for (let i = 2; i < this.dataLength; i += 3) {
        const v = this.data[i];
        if (v < autoMin) autoMin = v;
        if (v > autoMax) autoMax = v;
      }
      if (vMin === undefined) vMin = autoMin;
      if (vMax === undefined) vMax = autoMax;
    }

    const range = vMax - vMin || 1;
    const cw = this.cellWidth;
    const ch = this.cellHeight;
    const halfW = cw / 2;
    const halfH = ch / 2;
    const lutStrings = this.lutStrings;

    for (let i = 0; i + 2 < this.dataLength; i += 3) {
      const px = viewport.xToPx(this.data[i]);
      const py = viewport.yToPx(this.data[i + 1]);
      const norm = Math.max(0, Math.min(1, (this.data[i + 2] - vMin) / range));
      ctx.fillStyle = lutStrings[Math.floor(norm * 255)]!;
      ctx.fillRect(px - halfW, py - halfH, cw, ch);
    }
  }

  dispose(): void {
    this.data = new Float32Array(0);
    this.dataLength = 0;
  }
}

// ── Colormaps (256-entry RGB LUTs) ──────────────────────────────────────────
// Viridis, Plasma, Hot — sampled at 256 steps from matplotlib colormaps.

function buildLut(stops: [number, number, number, number][]): Uint8Array {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 1 && stops[j + 1][0] < t) j++;
    const [t0, r0, g0, b0] = stops[j];
    const [t1, r1, g1, b1] = stops[Math.min(j + 1, stops.length - 1)];
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

/** Pre-format each LUT entry as an `rgb(...)` string once (per colormap). */
function buildLutStrings(lut: Uint8Array): string[] {
  const out: string[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    const j = i * 3;
    out[i] = `rgb(${lut[j]},${lut[j + 1]},${lut[j + 2]})`;
  }
  return out;
}

const VIRIDIS_STRINGS = buildLutStrings(VIRIDIS_LUT);
const PLASMA_STRINGS = buildLutStrings(PLASMA_LUT);
const HOT_STRINGS = buildLutStrings(HOT_LUT);
