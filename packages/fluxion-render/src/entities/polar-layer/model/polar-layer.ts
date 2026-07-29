import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export interface PolarConfig {
  /** Line/marker color (CSS). Default "#4fc3f7". */
  color?: string;
  /** Line width in CSS px. Default 1.5. */
  lineWidth?: number;
  /** Fill the polygon under the trace with `color` at this opacity. 0 = no fill. Default 0. */
  fillOpacity?: number;
  /**
   * Radius value mapped to the outer edge. When omitted, auto-scales to the
   * largest `r` in the data each frame.
   */
  rMax?: number;
  /** Connect the last point back to the first (closed radar/rose). Default true. */
  closed?: boolean;
  /** Draw a filled dot at each vertex. Default false. */
  showPoints?: boolean;
  /** Point radius in CSS px when `showPoints`. Default 3. */
  pointSize?: number;
  /** Draw concentric radial grid rings. Default true. */
  showRings?: boolean;
  /** Number of grid rings when `showRings`. Default 4. */
  ringCount?: number;
  /** Grid color for rings/spokes. Default "rgba(255,255,255,0.12)". */
  gridColor?: string;
  /** Inset from the canvas edge in CSS px, reserving room for labels. Default 8. */
  insetPx?: number;
  visible?: boolean;
}

/**
 * Polar / radar layer — plots `(theta, r)` pairs around a center point.
 *
 * Data layout: Float32Array `[theta, r, theta, r, …]` stride=2 — `theta` in
 * radians (0 = +x / right, increasing counter-clockwise), `r` ≥ 0. Useful for a
 * single LiDAR scan ring, wind direction, or a multi-axis status radar.
 *
 * Self-contained: it maps polar→pixel against the canvas center and does NOT use
 * the Cartesian x/y viewport bounds, so it ignores `axisGridLayer` y-scaling.
 * Give it its own canvas (don't stack it with cartesian data layers).
 */
export class PolarLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private lineWidth = 1.5;
  private fillOpacity = 0;
  private rMax: number | undefined;
  private closed = true;
  private showPoints = false;
  private pointSize = 3;
  private showRings = true;
  private ringCount = 4;
  private gridColor = "rgba(255,255,255,0.12)";
  private insetPx = 8;
  private visible = true;
  private data: Float32Array = new Float32Array(0);
  private dataLength = 0;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as PolarConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.lineWidth !== undefined) this.lineWidth = Math.max(0.5, c.lineWidth);
    if (c.fillOpacity !== undefined)
      this.fillOpacity = Math.max(0, Math.min(1, c.fillOpacity));
    if (c.rMax !== undefined) this.rMax = c.rMax;
    if (c.closed !== undefined) this.closed = c.closed;
    if (c.showPoints !== undefined) this.showPoints = c.showPoints;
    if (c.pointSize !== undefined) this.pointSize = Math.max(1, c.pointSize);
    if (c.showRings !== undefined) this.showRings = c.showRings;
    if (c.ringCount !== undefined) this.ringCount = Math.max(1, Math.floor(c.ringCount));
    if (c.gridColor !== undefined) this.gridColor = c.gridColor;
    if (c.insetPx !== undefined) this.insetPx = Math.max(0, c.insetPx);
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(buffer: ArrayBuffer, length: number, _viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.dataLength = length;
  }

  resize(_viewport: Viewport): void {}

  // No scan(): polar layer does not contribute to the shared cartesian y-range.

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.dataLength < 2) return;

    const cx = viewport.plotLeft + viewport.plotWidth / 2;
    const cy = viewport.plotHeight / 2;
    const radiusPx = Math.max(0, Math.min(cx, cy) - this.insetPx);

    // Determine the r normalization (auto = max r in data).
    let rMax = this.rMax;
    if (rMax === undefined) {
      let m = 0;
      for (let i = 1; i < this.dataLength; i += 2) {
        const r = this.data[i]!;
        if (r > m) m = r;
      }
      rMax = m;
    }
    const rScale = rMax > 0 ? radiusPx / rMax : 0;

    // Grid rings.
    if (this.showRings) {
      ctx.strokeStyle = this.gridColor;
      ctx.lineWidth = 1;
      for (let k = 1; k <= this.ringCount; k++) {
        const rr = (radiusPx * k) / this.ringCount;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const toPx = (theta: number, r: number): [number, number] => {
      const rp = r * rScale;
      // Screen y grows downward → negate sin so +theta goes counter-clockwise.
      return [cx + rp * Math.cos(theta), cy - rp * Math.sin(theta)];
    };

    // Trace.
    ctx.beginPath();
    for (let i = 0; i + 1 < this.dataLength; i += 2) {
      const [px, py] = toPx(this.data[i]!, this.data[i + 1]!);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (this.closed) ctx.closePath();

    if (this.fillOpacity > 0) {
      ctx.globalAlpha = this.fillOpacity;
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.stroke();

    if (this.showPoints) {
      ctx.fillStyle = this.color;
      for (let i = 0; i + 1 < this.dataLength; i += 2) {
        const [px, py] = toPx(this.data[i]!, this.data[i + 1]!);
        ctx.beginPath();
        ctx.arc(px, py, this.pointSize, 0, Math.PI * 2);
        ctx.fill();
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
