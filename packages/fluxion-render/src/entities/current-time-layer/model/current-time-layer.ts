import type { GlRenderer } from "../../../shared/gl/gl-renderer";
import { type ClipTransform, pxToClip } from "../../../shared/gl/gl-transform";
import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export interface CurrentTimeConfig {
  /** Host-relative milliseconds for a replay playhead. null (default) follows the clock. */
  currentTime?: number | null;
  /** Epoch milliseconds corresponding to x=0. Required for live clock mode. */
  timeOrigin?: number;
  /** Bar color. Default "#ff5252". */
  color?: string;
  /** Bar width in CSS pixels. Default 2; minimum 0.5. */
  lineWidth?: number;
  /** Hide the bar and stop its continuous rendering. Default true. */
  visible?: boolean;
}

/** Config-only vertical playhead. Add after data layers to draw above them. */
export class CurrentTimeLayer implements Layer {
  private currentTime: number | null = null;
  private timeOrigin: number | undefined;
  private color = "#ff5252";
  private lineWidth = 2;
  private visible = true;
  private readonly vertices = new Float32Array(12);
  private readonly transform: ClipTransform = new Float32Array(6);

  constructor(readonly id: string) {}

  setConfig(config: unknown): void {
    const c = config as CurrentTimeConfig;
    if (c.currentTime !== undefined) this.currentTime = c.currentTime;
    if (c.timeOrigin !== undefined) this.timeOrigin = c.timeOrigin;
    if (c.color !== undefined) this.color = c.color;
    if (c.lineWidth !== undefined && Number.isFinite(c.lineWidth)) {
      this.lineWidth = Math.max(0.5, c.lineWidth);
    }
    if (c.visible !== undefined) this.visible = c.visible;
  }

  needsContinuousRender(): boolean {
    return this.visible && this.currentTime === null && Number.isFinite(this.timeOrigin);
  }

  setData(_buffer: ArrayBuffer, _length: number, _viewport: Viewport): void {}
  resize(_viewport: Viewport): void {}
  dispose(): void {}

  private x(viewport: Viewport): number | null {
    if (!this.visible || viewport.plotWidth <= 0 || viewport.plotHeight <= 0) return null;
    const t =
      this.currentTime ??
      (this.timeOrigin === undefined
        ? Number.NaN
        : (viewport.clockTime ?? Date.now()) - this.timeOrigin);
    const { xMin, xMax } = viewport.bounds;
    if (
      !Number.isFinite(t) ||
      !Number.isFinite(xMin) ||
      !Number.isFinite(xMax) ||
      xMax <= xMin ||
      t < xMin ||
      t > xMax
    )
      return null;
    // Keep the entire stroke inside the plot, including at either time-window edge.
    const halfWidth = Math.min(this.lineWidth, viewport.plotWidth) / 2;
    return Math.max(
      viewport.plotLeft + halfWidth,
      Math.min(viewport.widthPx - halfWidth, viewport.xToPx(t)),
    );
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    const x = this.x(viewport);
    if (x === null) return;
    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = Math.min(this.lineWidth, viewport.plotWidth);
    ctx.lineCap = "butt";
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.plotBottom);
    ctx.stroke();
    ctx.restore();
  }

  drawGl(glr: GlRenderer, viewport: Viewport): void {
    const x = this.x(viewport);
    if (x === null) return;
    const half = Math.min(this.lineWidth, viewport.plotWidth) / 2;
    const left = x - half;
    const right = x + half;
    const bottom = viewport.plotBottom;
    // Two filled triangles preserve CSS width on drivers limited to 1px lines.
    const v = this.vertices;
    v[0] = left;
    v[1] = 0;
    v[2] = right;
    v[3] = 0;
    v[4] = left;
    v[5] = bottom;
    v[6] = left;
    v[7] = bottom;
    v[8] = right;
    v[9] = 0;
    v[10] = right;
    v[11] = bottom;
    pxToClip(viewport, this.transform);
    glr.drawTriangles(v, 6, this.transform, glr.resolveColor(this.color));
  }
}
