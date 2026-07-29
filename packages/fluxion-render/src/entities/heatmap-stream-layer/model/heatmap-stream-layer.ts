import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export interface HeatmapStreamConfig {
  /**
   * Number of y-bins (rows) in the heatmap grid.
   * Must match the length of each column pushed via the handle. Default 32.
   */
  yBins?: number;
  /**
   * Number of time columns to keep (ring buffer width). Default 256.
   * Columns older than `maxCols` are evicted.
   */
  maxCols?: number;
  /** Y range of the grid: [yMin, yMax]. Default [0, 1]. */
  yRange?: [number, number];
  colormap?: "viridis" | "plasma" | "hot";
  /** Value mapped to the cold end of the colormap. Default: auto (data min). */
  minValue?: number;
  /** Value mapped to the hot end of the colormap. Default: auto (data max). */
  maxValue?: number;
  /** When false, skip draw. Default true. */
  visible?: boolean;
}

/**
 * Streaming heatmap. Accumulates column-by-column updates in a ring buffer.
 *
 * Data layout per `setData` call: Float32Array `[t, v0, v1, ..., v_{yBins-1}]`
 * where `t` is the column timestamp and `v_i` is the value for y-bin `i`.
 * Length must equal `yBins + 1`.
 *
 * Use for occupancy grids, joint temperature maps, frequency spectrograms, etc.
 */
export class HeatmapStreamLayer implements Layer {
  readonly id: string;
  private yBins = 32;
  private maxCols = 256;
  private yMin = 0;
  private yMax = 1;
  private colormap: "viridis" | "plasma" | "hot" = "viridis";
  // Cached `rgb(...)` string per LUT entry — avoids a string alloc per cell per
  // frame (yBins × visible columns can be large on a streaming spectrogram).
  private lutStrings: string[] = VIRIDIS_STRINGS;
  private minValue: number | undefined;
  private maxValue: number | undefined;
  private visible = true;

  // Ring buffer of columns: circular array of Float32Array(yBins) + timestamp Float32Array.
  private colData: Float32Array; // flat [col0_v0..v_{yBins-1}, col1_v0..., ...]
  private colTs: Float32Array; // timestamps per column
  private head = 0;
  private count = 0;
  // Cached auto value-range over the retained columns. Recomputed on setData
  // (when minValue/maxValue is auto) instead of rescanning O(cols×bins) every
  // draw — the ring only changes on setData, so the cache is always fresh.
  private autoMin = Number.POSITIVE_INFINITY;
  private autoMax = Number.NEGATIVE_INFINITY;

  constructor(id: string) {
    this.id = id;
    this.colData = new Float32Array(this.maxCols * this.yBins);
    this.colTs = new Float32Array(this.maxCols);
  }

  private allocBuffers(): void {
    this.colData = new Float32Array(this.maxCols * this.yBins);
    this.colTs = new Float32Array(this.maxCols);
    this.head = 0;
    this.count = 0;
    this.autoMin = Number.POSITIVE_INFINITY;
    this.autoMax = Number.NEGATIVE_INFINITY;
  }

  /** Rescan the retained columns for the auto value-range (min/max). */
  private recomputeAuto(): void {
    const bins = this.yBins;
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    const start = this.count < this.maxCols ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const slot = (start + i) % this.maxCols;
      const base = slot * bins;
      for (let b = 0; b < bins; b++) {
        const v = this.colData[base + b]!;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    this.autoMin = mn;
    this.autoMax = mx;
  }

  setConfig(config: unknown): void {
    const c = config as HeatmapStreamConfig;
    let needRealloc = false;
    if (c.yBins !== undefined && c.yBins !== this.yBins) {
      this.yBins = Math.max(1, c.yBins);
      needRealloc = true;
    }
    if (c.maxCols !== undefined && c.maxCols !== this.maxCols) {
      this.maxCols = Math.max(4, c.maxCols);
      needRealloc = true;
    }
    if (needRealloc) this.allocBuffers();
    if (c.yRange !== undefined) {
      this.yMin = c.yRange[0];
      this.yMax = c.yRange[1];
    }
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

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    // Expect [t, v0, v1, ..., v_{yBins-1}] — length = yBins + 1
    if (length < 2) return;
    const arr = new Float32Array(buffer, 0, length);
    const t = arr[0]!;
    const bins = Math.min(this.yBins, length - 1);

    const slot = this.head;
    this.colTs[slot] = t;
    const base = slot * this.yBins;
    for (let i = 0; i < bins; i++) {
      this.colData[base + i] = arr[i + 1]!;
    }
    this.head = (this.head + 1) % this.maxCols;
    if (this.count < this.maxCols) this.count++;

    if (t > viewport.latestT) viewport.latestT = t;

    // Refresh the auto value-range only when a dimension actually needs it.
    if (this.minValue === undefined || this.maxValue === undefined) {
      this.recomputeAuto();
    }
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.count === 0) return;
    // Report y range for axis-grid auto mode.
    if (viewport.observedYMin > this.yMin) viewport.observedYMin = this.yMin;
    if (viewport.observedYMax < this.yMax) viewport.observedYMax = this.yMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.count === 0) return;

    const { xMin, xMax } = viewport.bounds;
    const lutStrings = this.lutStrings;
    const bins = this.yBins;

    // Determine value range for normalisation — auto bounds come from the cache
    // maintained on setData (see recomputeAuto), not a per-frame rescan.
    let vMin = this.minValue;
    let vMax = this.maxValue;
    if (vMin === undefined) vMin = this.autoMin;
    if (vMax === undefined) vMax = this.autoMax;
    const range = vMax - vMin || 1;

    // Compute cell pixel dimensions.
    const cellH = viewport.plotHeight / bins;
    const start = this.count < this.maxCols ? 0 : this.head;

    // Draw columns oldest→newest, clipped to visible x range.
    for (let i = 0; i < this.count; i++) {
      const slot = (start + i) % this.maxCols;
      const t = this.colTs[slot]!;
      if (t < xMin || t > xMax) continue;
      const px = viewport.xToPx(t);

      // Determine cell width from adjacent column spacing.
      let cellW = 4;
      if (i + 1 < this.count) {
        const nextSlot = (start + i + 1) % this.maxCols;
        const nextT = this.colTs[nextSlot]!;
        cellW = Math.max(1, Math.abs(viewport.xToPx(nextT) - px));
      }

      const base = slot * bins;
      for (let b = 0; b < bins; b++) {
        // y-bin 0 = bottom (yMin), b = bins-1 = top (yMax).
        const yVal = this.yMin + (b / bins) * (this.yMax - this.yMin);
        const py = viewport.yToPx(yVal + (this.yMax - this.yMin) / bins);
        const norm = Math.max(0, Math.min(1, (this.colData[base + b]! - vMin) / range));
        ctx.fillStyle = lutStrings[Math.floor(norm * 255)]!;
        ctx.fillRect(px - cellW / 2, py, cellW, Math.ceil(cellH) + 1);
      }
    }
  }

  dispose(): void {
    this.colData = new Float32Array(0);
    this.colTs = new Float32Array(0);
    this.count = 0;
  }
}

// ── Colormaps (256-entry RGB LUTs) ───────────────────────────────────────────

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
