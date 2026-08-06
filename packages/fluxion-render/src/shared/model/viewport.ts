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

  /**
   * Inline-axes plot insets, CSS px. When the engine renders axes into
   * MARGINS of the main canvas (`inlineAxes`), the plot area shrinks to
   * `[insetLeft, widthPx] × [0, heightPx - insetBottom]` and the coordinate
   * mapping below targets that rect. Both default 0 — every existing mode
   * (external axis canvases, React axes, bare) is byte-identical.
   */
  insetLeft = 0;
  insetBottom = 0;

  setSize(width: number, height: number, dpr: number) {
    this.widthPx = width;
    this.heightPx = height;
    this.dpr = dpr;
  }

  setBounds(b: Bounds) {
    this.bounds = b;
  }

  /** Left edge of the plot rect (0 unless inline axes reserve a y strip). */
  get plotLeft(): number {
    return this.insetLeft;
  }

  /** Bottom edge of the plot rect (heightPx unless inline axes reserve an x strip). */
  get plotBottom(): number {
    return this.heightPx - this.insetBottom;
  }

  /** Plot rect width in CSS px. */
  get plotWidth(): number {
    return this.widthPx - this.insetLeft;
  }

  /** Plot rect height in CSS px. */
  get plotHeight(): number {
    return this.heightPx - this.insetBottom;
  }

  /** Called by Engine at the start of each render frame before scan pass. */
  beginScan(): void {
    this.observedYMin = Number.POSITIVE_INFINITY;
    this.observedYMax = Number.NEGATIVE_INFINITY;
  }

  // Cached projection coefficients. `xToPx`/`yToPx` are the engine's hottest
  // primitive (once per visible sample per layer per frame — tens of millions/s
  // at scale). The affine is constant across a frame, so cache the multiplier
  // and recompute it only when an input changed — collapsing a per-sample divide
  // to one divide per axis per frame. Value-guarded on the live inputs (bounds
  // is mutated in place by finalizeBounds), so it self-corrects with no explicit
  // invalidation.
  private _xMin = Number.NaN;
  private _xMax = Number.NaN;
  private _xW = Number.NaN;
  private _xInset = Number.NaN;
  private _xMul = 0;
  private _yMin = Number.NaN;
  private _yMax = Number.NaN;
  private _yH = Number.NaN;
  private _yInsetB = Number.NaN;
  private _yPad = Number.NaN;
  private _yMul = 0;
  private _yBase = 0;

  xToPx(x: number): number {
    const { xMin, xMax } = this.bounds;
    const inset = this.insetLeft;
    const w = this.widthPx;
    if (
      xMin !== this._xMin ||
      xMax !== this._xMax ||
      w !== this._xW ||
      inset !== this._xInset
    ) {
      this._xMin = xMin;
      this._xMax = xMax;
      this._xW = w;
      this._xInset = inset;
      // `|| 1` guards a degenerate (xMin === xMax) span (matches engine's
      // `yMax - yMin || 1`).
      this._xMul = (w - inset) / (xMax - xMin || 1);
    }
    return inset + (x - xMin) * this._xMul;
  }

  yToPx(y: number): number {
    const { yMin, yMax } = this.bounds;
    const pad = this.yPadPx;
    const h = this.heightPx;
    const insetB = this.insetBottom;
    if (
      yMin !== this._yMin ||
      yMax !== this._yMax ||
      h !== this._yH ||
      insetB !== this._yInsetB ||
      pad !== this._yPad
    ) {
      this._yMin = yMin;
      this._yMax = yMax;
      this._yH = h;
      this._yInsetB = insetB;
      this._yPad = pad;
      // `yPadPx` breathing room composes INSIDE the plot rect: data maps into
      // `[pad, plotHeight - pad]` — identical to today when insetBottom is 0.
      const usable = h - insetB - pad * 2;
      this._yMul = usable / (yMax - yMin || 1);
      this._yBase = pad + usable;
    }
    return this._yBase - (y - yMin) * this._yMul;
  }
}
