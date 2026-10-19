import { lutFor } from "../../../shared/lib/colormap";
import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export type { TrajectoryConfig } from "../../../shared/model/layer-configs";

import type { TrajectoryConfig } from "../../../shared/model/layer-configs";

/**
 * Streaming 2-D trajectory / path layer for robot or vehicle position.
 *
 * Data layout: Float32Array `[x, y, t, ...]` stride=3 — `x`/`y` are world-space
 * coordinates (use `axisGridLayer({ xMode: "fixed" })`), `t` is host-relative ms
 * used only for time-coloring and fading. Renders a connected polyline through
 * the points, optionally colored by age (`colorByTime`) and with a head marker
 * at the current position. Complements `poseArrowLayer` (discrete heading
 * arrows) with a continuous path.
 */
export class TrajectoryLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private lineWidth = 1.5;
  private colorByTime = false;
  private lut: Uint8Array = lutFor("viridis");
  private headMarker = true;
  private headMarkerSize = 4;
  private fadeOlderMs = 0;
  private visible = true;
  private ring: RingBuffer;

  constructor(id: string) {
    this.id = id;
    this.ring = new RingBuffer(4096, 3);
  }

  setConfig(config: unknown): void {
    const c = config as TrajectoryConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.lineWidth !== undefined) this.lineWidth = c.lineWidth;
    if (c.colorByTime !== undefined) this.colorByTime = c.colorByTime;
    if (c.colormap !== undefined) this.lut = lutFor(c.colormap);
    if (c.headMarker !== undefined) this.headMarker = c.headMarker;
    if (c.headMarkerSize !== undefined)
      this.headMarkerSize = Math.max(1, c.headMarkerSize);
    if (c.fadeOlderMs !== undefined) this.fadeOlderMs = Math.max(0, c.fadeOlderMs);
    if (c.visible !== undefined) this.visible = c.visible;
    const newCapacity = computeRingCapacity(c);
    if (newCapacity !== undefined && newCapacity !== this.ring.capacity) {
      this.ring = new RingBuffer(newCapacity, 3);
    }
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    if (length < 3) return;
    const arr = new Float32Array(buffer, 0, length);
    this.ring.pushMany(arr);
    const t = arr[length - 1];
    if (t > viewport.latestT) viewport.latestT = t;
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;
    // Trajectory x/y are world coordinates — contribute the y extent so
    // yMode:"auto" frames the path. (x is framed by xMode:"fixed" / xRange.)
    let localMin = viewport.observedYMin;
    let localMax = viewport.observedYMax;
    this.ring.forEach((data, off) => {
      const y = data[off + 1];
      if (y < localMin) localMin = y;
      if (y > localMax) localMax = y;
    });
    viewport.observedYMin = localMin;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;

    const latestT = viewport.latestT;
    const fade = this.fadeOlderMs;
    const colorByTime = this.colorByTime;
    const lut = this.lut;
    // Oldest sample time, for time-coloring normalisation.
    let oldestT = latestT;
    this.ring.forEach((data, off) => {
      const t = data[off + 2]!;
      if (t < oldestT) oldestT = t;
    });
    const span = latestT - oldestT || 1;

    ctx.lineWidth = this.lineWidth;
    ctx.lineJoin = "round";

    // Track the most recent point for the head marker (ring iterates
    // chronologically, so the final visited sample is the latest).
    let headPx = 0;
    let headPy = 0;

    if (colorByTime) {
      // Per-segment color: draw each segment with its own stroke style.
      let prevPx = 0;
      let prevPy = 0;
      let have = false;
      this.ring.forEach((data, off) => {
        const px = viewport.xToPx(data[off]!);
        const py = viewport.yToPx(data[off + 1]!);
        const t = data[off + 2]!;
        if (have) {
          const f = (t - oldestT) / span;
          const idx = Math.floor(Math.max(0, Math.min(1, f)) * 255) * 3;
          const a = fade > 0 ? Math.max(0, Math.min(1, 1 - (latestT - t) / fade)) : 1;
          ctx.strokeStyle = `rgba(${lut[idx]},${lut[idx + 1]},${lut[idx + 2]},${a})`;
          ctx.beginPath();
          ctx.moveTo(prevPx, prevPy);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
        prevPx = px;
        prevPy = py;
        have = true;
        headPx = px;
        headPy = py;
      });
    } else if (fade > 0) {
      // Solid color, per-segment alpha for fading.
      let prevPx = 0;
      let prevPy = 0;
      let have = false;
      this.ring.forEach((data, off) => {
        const px = viewport.xToPx(data[off]!);
        const py = viewport.yToPx(data[off + 1]!);
        const t = data[off + 2]!;
        if (have) {
          const a = Math.max(0, Math.min(1, 1 - (latestT - t) / fade));
          ctx.globalAlpha = a;
          ctx.strokeStyle = this.color;
          ctx.beginPath();
          ctx.moveTo(prevPx, prevPy);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
        prevPx = px;
        prevPy = py;
        have = true;
        headPx = px;
        headPy = py;
      });
      ctx.globalAlpha = 1;
    } else {
      // Fast path: one polyline.
      ctx.strokeStyle = this.color;
      ctx.beginPath();
      let first = true;
      this.ring.forEach((data, off) => {
        const px = viewport.xToPx(data[off]!);
        const py = viewport.yToPx(data[off + 1]!);
        if (first) {
          ctx.moveTo(px, py);
          first = false;
        } else {
          ctx.lineTo(px, py);
        }
        headPx = px;
        headPy = py;
      });
      ctx.stroke();
    }

    if (this.headMarker) {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(headPx, headPy, this.headMarkerSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  clearData(): void {
    this.ring.clear();
  }

  dispose(): void {
    this.ring.clear();
  }
}
