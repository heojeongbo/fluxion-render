import { hexToRgb } from "../../../shared/lib/colormap";
import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { OccupancyGridConfig } from "../../../shared/model/layer-configs";

import type { OccupancyGridConfig } from "../../../shared/model/layer-configs";

/**
 * 2-D occupancy grid (ROS `nav_msgs/OccupancyGrid` style).
 *
 * Data layout: a header followed by row-major cell values:
 *   `[originX, originY, resolution, cols, rows, c0, c1, …, c_{cols*rows-1}]`
 * - `originX`/`originY`: world coords of the grid's lower-left corner.
 * - `resolution`: cell size in world units (meters).
 * - cell values: `-1` = unknown, `0..100` = occupancy probability.
 *
 * Cells are placed and sized in world space (so they pan/zoom with the axis),
 * unlike the fixed-pixel `heatmap` layer. Use `axisGridLayer({ xMode: "fixed" })`
 * with a world-unit `xRange`/`yRange`.
 */
export class OccupancyGridLayer implements Layer {
  readonly id: string;
  private occupied: [number, number, number] = [26, 26, 26];
  private free: [number, number, number] = [224, 224, 224];
  // Cached `rgb(...)` per occupancy percent (0..100), interpolated free→occupied.
  // Rebuilt only when the colors change — avoids a string + 3 rounds per cell.
  private cellStrings: string[] = [];
  private unknownColor = "#808080";
  private showGridLines = false;
  private gridLineColor = "rgba(0,0,0,0.15)";
  private visible = true;
  private data: Float32Array = new Float32Array(0);
  private dataLength = 0;

  constructor(id: string) {
    this.id = id;
    this.cellStrings = buildCellStrings(this.free, this.occupied);
  }

  setConfig(config: unknown): void {
    const c = config as OccupancyGridConfig;
    if (c.occupiedColor !== undefined) this.occupied = hexToRgb(c.occupiedColor);
    if (c.freeColor !== undefined) this.free = hexToRgb(c.freeColor);
    if (c.occupiedColor !== undefined || c.freeColor !== undefined) {
      this.cellStrings = buildCellStrings(this.free, this.occupied);
    }
    if (c.unknownColor !== undefined) this.unknownColor = c.unknownColor;
    if (c.showGridLines !== undefined) this.showGridLines = c.showGridLines;
    if (c.gridLineColor !== undefined) this.gridLineColor = c.gridLineColor;
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.dataLength = length;
    if (length >= 5) {
      // Surface the grid's world y-extent so yMode:"auto" can frame it.
      const originY = this.data[1]!;
      const res = this.data[2]!;
      const rows = this.data[4]!;
      const yMax = originY + rows * res;
      if (originY < viewport.observedYMin) viewport.observedYMin = originY;
      if (yMax > viewport.observedYMax) viewport.observedYMax = yMax;
    }
  }

  resize(_viewport: Viewport): void {}

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.dataLength < 6) return;
    const originX = this.data[0]!;
    const originY = this.data[1]!;
    const res = this.data[2]!;
    const cols = this.data[3]! | 0;
    const rows = this.data[4]! | 0;
    if (cols <= 0 || rows <= 0) return;

    const cellStrings = this.cellStrings;
    const lines = this.showGridLines;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = 5 + row * cols + col;
        if (idx >= this.dataLength) break;
        const v = this.data[idx]!;
        // World-space cell bounds → pixels.
        const x0 = originX + col * res;
        const y0 = originY + row * res;
        const px = viewport.xToPx(x0);
        const py = viewport.yToPx(y0 + res); // top edge (y grows up, px grows down)
        const pw = viewport.xToPx(x0 + res) - px;
        const ph = viewport.yToPx(y0) - py;

        if (v < 0) {
          ctx.fillStyle = this.unknownColor;
        } else {
          ctx.fillStyle = cellStrings[Math.min(100, Math.round(v))]!;
        }
        ctx.fillRect(px, py, pw, ph);
        if (lines) {
          ctx.strokeStyle = this.gridLineColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(px, py, pw, ph);
        }
      }
    }
  }

  clearData(): void {
    this.data = new Float32Array(0);
    this.dataLength = 0;
  }

  dispose(): void {
    this.data = new Float32Array(0);
    this.dataLength = 0;
  }
}

/** Pre-format the free→occupied gradient as `rgb(...)` strings per percent (0..100). */
function buildCellStrings(
  free: [number, number, number],
  occupied: [number, number, number],
): string[] {
  const [fr, fg, fb] = free;
  const [or, og, ob] = occupied;
  const out: string[] = new Array(101);
  for (let k = 0; k <= 100; k++) {
    const t = k / 100;
    const r = Math.round(fr + (or - fr) * t);
    const g = Math.round(fg + (og - fg) * t);
    const b = Math.round(fb + (ob - fb) * t);
    out[k] = `rgb(${r},${g},${b})`;
  }
  return out;
}
