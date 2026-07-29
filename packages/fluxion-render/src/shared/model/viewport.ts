export interface Bounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export class Viewport {
  widthPx = 0;
  heightPx = 0;
  dpr = 1;

  bounds: Bounds = { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };

  /**
   * Most recent data timestamp (ms, host-relative) seen across all streaming
   * layers. Streaming `LineChartLayer` updates this on setData; `AxisGridLayer`
   * in time mode uses it to compute a sliding window.
   */
  latestT = 0;

  /**
   * Per-frame aggregate of observed y values across all data layers that
   * currently overlap the visible time window. `AxisGridLayer` in
   * `yMode: "auto"` reads these in draw to compute bounds.yMin/yMax.
   */
  observedYMin = Number.POSITIVE_INFINITY;
  observedYMax = Number.NEGATIVE_INFINITY;

  /**
   * Vertical inset padding in CSS pixels. When set > 0, `yToPx` maps the
   * data range into `[yPadPx, heightPx - yPadPx]` instead of `[0, heightPx]`.
   * This keeps grid lines and data strokes away from the canvas top/bottom
   * edge, matching the external axis canvas's padding so they stay aligned.
   *
   * Set by `AxisGridLayer` from its `yPadPx` config.
   */
  yPadPx = 0;

  /**
   * True when the engine renders x/y tick labels onto a dedicated external
   * axis canvas (SET_AXIS_CANVAS). `AxisGridLayer` then skips its in-plot
   * LABELS (grid lines are unaffected) so labels aren't formatted and drawn
   * twice per frame. Set by Engine when an axis canvas attaches; axis-canvas
   * bindings survive host recycling, so these are not cleared on RESET.
   */
  externalXAxis = false;
  externalYAxis = false;

  setSize(width: number, height: number, dpr: number) {
    this.widthPx = width;
    this.heightPx = height;
    this.dpr = dpr;
  }

  setBounds(b: Bounds) {
    this.bounds = b;
  }

  /** Called by Engine at the start of each render frame before scan pass. */
  beginScan(): void {
    this.observedYMin = Number.POSITIVE_INFINITY;
    this.observedYMax = Number.NEGATIVE_INFINITY;
  }

  xToPx(x: number): number {
    const { xMin, xMax } = this.bounds;
    // `|| 1` guards a degenerate (xMin === xMax) span so the result is a finite
    // pixel instead of NaN/Infinity (matches engine.ts's `yMax - yMin || 1`).
    const span = xMax - xMin || 1;
    return ((x - xMin) / span) * this.widthPx;
  }

  yToPx(y: number): number {
    const { yMin, yMax } = this.bounds;
    const pad = this.yPadPx;
    const usable = this.heightPx - pad * 2;
    const span = yMax - yMin || 1;
    return pad + usable - ((y - yMin) / span) * usable;
  }
}
