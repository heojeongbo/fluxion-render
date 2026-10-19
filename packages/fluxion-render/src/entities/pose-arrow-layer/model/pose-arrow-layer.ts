import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export type { PoseArrowConfig } from "../../../shared/model/layer-configs";

import type { PoseArrowConfig } from "../../../shared/model/layer-configs";

/**
 * Streaming pose layer. Each sample is (t, y, theta) rendered as an arrow
 * glyph on the time-series canvas: x-axis = time, y-axis = position/value,
 * theta = heading angle (radians, 0=right, π/2=up).
 *
 * Data layout: Float32Array `[t, y, theta, t, y, theta, ...]` stride=3.
 */
export class PoseArrowLayer implements Layer {
  readonly id: string;
  private arrowLength = 14;
  private arrowWidth = 5;
  private color = "#80ffa0";
  private visible = true;
  private ring: RingBuffer;

  constructor(id: string) {
    this.id = id;
    this.ring = new RingBuffer(4096, 3);
  }

  setConfig(config: unknown): void {
    const c = config as PoseArrowConfig;
    if (c.arrowLength !== undefined) this.arrowLength = Math.max(4, c.arrowLength);
    if (c.arrowWidth !== undefined) this.arrowWidth = Math.max(2, c.arrowWidth);
    if (c.color !== undefined) this.color = c.color;
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
    const t = arr[length - 3];
    if (t !== undefined && t > viewport.latestT) viewport.latestT = t;
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
    const len = this.arrowLength;
    const hw = this.arrowWidth;

    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
    ctx.lineWidth = 1.5;

    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      const px = viewport.xToPx(t);
      const py = viewport.yToPx(data[off + 1]);
      const theta = data[off + 2]!;

      // In canvas: x=right, y=down. theta=0 → right, π/2 → up (negate sin for canvas).
      const cos = Math.cos(theta);
      const sin = -Math.sin(theta); // negate for canvas y-flip

      const tipX = px + cos * len;
      const tipY = py + sin * len;

      // Arrow body
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      // Arrowhead: perpendicular to direction
      const perpX = -sin;
      const perpY = cos;
      const baseX = tipX - cos * hw;
      const baseY = tipY - sin * hw;

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX + perpX * hw, baseY + perpY * hw);
      ctx.lineTo(baseX - perpX * hw, baseY - perpY * hw);
      ctx.closePath();
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
