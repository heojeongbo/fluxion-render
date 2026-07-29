import { drawLabel } from "../../../shared/lib/label-cache";
import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export interface ReferenceLineConfig {
  /** Y data value at which to draw the reference line. */
  y: number;
  /** Lower bound of the tolerance band (drawn as a shaded rect). */
  bandMin?: number;
  /** Upper bound of the tolerance band. */
  bandMax?: number;
  /** Line color. Default "#4fc3f7". */
  color?: string;
  /** Line width in pixels. Default 1.5. */
  lineWidth?: number;
  /** Label shown at the right edge. */
  label?: string;
  /** Band fill opacity (0–1). Default 0.12. */
  bandOpacity?: number;
  /** When false, skip draw. Default true. */
  visible?: boolean;
}

/**
 * Static reference line with optional ±tolerance band.
 *
 * No data streaming — config-only layer. Re-configure via `useLayerConfig`
 * to move the line at runtime (e.g. live PID setpoint tracking).
 *
 * Data layout: none (setData is a no-op).
 */
export class ReferenceLineLayer implements Layer {
  readonly id: string;
  private y = 0;
  private bandMin: number | undefined;
  private bandMax: number | undefined;
  private color = "#4fc3f7";
  private lineWidth = 1.5;
  private label: string | undefined;
  private bandOpacity = 0.12;
  private visible = true;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as ReferenceLineConfig;
    if (c.y !== undefined) this.y = c.y;
    if (c.bandMin !== undefined) this.bandMin = c.bandMin;
    if (c.bandMax !== undefined) this.bandMax = c.bandMax;
    if (c.color !== undefined) this.color = c.color;
    if (c.lineWidth !== undefined) this.lineWidth = Math.max(0.5, c.lineWidth);
    if (c.label !== undefined) this.label = c.label;
    if (c.bandOpacity !== undefined)
      this.bandOpacity = Math.max(0, Math.min(1, c.bandOpacity));
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(_buffer: ArrayBuffer, _length: number, _viewport: Viewport): void {}

  resize(_viewport: Viewport): void {}

  scan(_viewport: Viewport): void {}

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible) return;

    const py = viewport.yToPx(this.y);
    const w = viewport.widthPx;
    const left = viewport.plotLeft;

    // Band
    if (this.bandMin !== undefined && this.bandMax !== undefined) {
      const pyMin = viewport.yToPx(this.bandMax); // yToPx inverts: higher y → lower px
      const pyMax = viewport.yToPx(this.bandMin);
      ctx.save();
      ctx.globalAlpha = this.bandOpacity;
      ctx.fillStyle = this.color;
      ctx.fillRect(left, pyMin, w - left, pyMax - pyMin);
      ctx.restore();
    }

    // Reference line
    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(w, py);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    if (this.label) {
      ctx.fillStyle = this.color;
      ctx.font = "11px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      drawLabel(ctx, this.label, w - 4, py - 2, {
        font: "11px monospace",
        color: this.color,
        align: "right",
        baseline: "bottom",
        dpr: viewport.dpr,
      });
    }
    ctx.restore();
  }

  dispose(): void {}
}
