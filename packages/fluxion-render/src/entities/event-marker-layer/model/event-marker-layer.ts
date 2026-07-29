import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export interface EventMarkerConfig {
  /** Colors per severity level: [info, warning, error]. Defaults: ["#4fc3f7","#ffb060","#ff5252"]. */
  colors?: [string, string, string];
  /** Line width in pixels. Default 1. */
  lineWidth?: number;
  /** Triangle marker height in pixels. Default 8. */
  markerSize?: number;
  /** When false, skip draw. Default true. */
  visible?: boolean;
}

interface MarkerRecord {
  t: number;
  severity: number;
}

/**
 * Event/annotation marker layer. Renders vertical dashed lines with triangle
 * markers at the top for each annotated time point.
 *
 * Data layout: Float32Array `[t, severity, t, severity, ...]` stride=2.
 * severity: 0=info, 1=warning, 2=error (clamped to 0–2).
 *
 * Unlike streaming layers, all markers are kept in a flat array and replaced
 * in full when `setData` is called. Use `clearEvents` on the handle to reset.
 */
export class EventMarkerLayer implements Layer {
  readonly id: string;
  private colors: [string, string, string] = ["#4fc3f7", "#ffb060", "#ff5252"];
  private lineWidth = 1;
  private markerSize = 8;
  private visible = true;
  private markers: MarkerRecord[] = [];

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as EventMarkerConfig;
    if (c.colors !== undefined) this.colors = c.colors;
    if (c.lineWidth !== undefined) this.lineWidth = Math.max(0.5, c.lineWidth);
    if (c.markerSize !== undefined) this.markerSize = Math.max(4, c.markerSize);
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(buffer: ArrayBuffer, length: number, _viewport: Viewport): void {
    if (length < 2) {
      this.markers = [];
      return;
    }
    const arr = new Float32Array(buffer, 0, length);
    const count = Math.floor(length / 2);
    const next: MarkerRecord[] = new Array(count);
    for (let i = 0; i < count; i++) {
      next[i] = {
        t: arr[i * 2]!,
        severity: Math.max(0, Math.min(2, Math.round(arr[i * 2 + 1]!))),
      };
    }
    this.markers = next;
  }

  resize(_viewport: Viewport): void {}

  scan(_viewport: Viewport): void {}

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.markers.length === 0) return;

    const { xMin, xMax } = viewport.bounds;
    const h = viewport.plotBottom;
    const ms = this.markerSize;
    ctx.lineWidth = this.lineWidth;

    for (const { t, severity } of this.markers) {
      if (t < xMin || t > xMax) continue;
      const px = viewport.xToPx(t);
      const color = this.colors[severity] ?? this.colors[0];

      // Dashed vertical line
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(px, ms);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Triangle marker at top
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(px, ms);
      ctx.lineTo(px - ms / 2, 0);
      ctx.lineTo(px + ms / 2, 0);
      ctx.closePath();
      ctx.fill();
    }
  }

  dispose(): void {
    this.markers = [];
  }
}
