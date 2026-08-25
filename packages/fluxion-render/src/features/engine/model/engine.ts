// AxisGridLayer is the ONE layer class engine.ts references directly (the
// `isAxisGrid` instanceof guard), so it is always bundled — fine, axes are
// universal. Every OTHER layer class is pulled in only by the registry
// (register-default-layers), so a custom slim worker tree-shakes the unused ones.
import { AxisGridLayer } from "../../../entities/axis-grid-layer";
import { LayerStack } from "../../../entities/layer-stack";
import { GlRenderer } from "../../../shared/gl/gl-renderer";
import type { Layer } from "../../../shared/model/layer";
import { enqueueBounds, enqueueStats, enqueueTicks } from "../../../shared/model/outbox";
import { Scheduler } from "../../../shared/model/scheduler";
import { Viewport } from "../../../shared/model/viewport";
import type {
  AxisStyle,
  HostMsg,
  RendererKind,
  SetAxisCanvasMsg,
} from "../../../shared/protocol";
import { Op, SOLO_HOST_ID } from "../../../shared/protocol";
import { createLayer } from "./layer-registry";

/** Type guard hoisted to module scope so render() doesn't allocate it per frame. */
function isAxisGrid(l: Layer): l is AxisGridLayer {
  return l instanceof AxisGridLayer;
}

/**
 * Worker-side engine. Owns the OffscreenCanvas, layer stack, viewport,
 * and render scheduler. All state lives here; main thread just pushes messages.
 */
export class Engine {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private xAxisCanvas: OffscreenCanvas | null = null;
  private xAxisCtx: OffscreenCanvasRenderingContext2D | null = null;
  private xAxisHeight = 30;
  private yAxisCanvas: OffscreenCanvas | null = null;
  private yAxisCtx: OffscreenCanvasRenderingContext2D | null = null;
  private yAxisWidth = 60;
  private axisStyle: AxisStyle = {};
  private readonly viewport = new Viewport();
  private readonly stack = new LayerStack();
  private readonly scheduler: Scheduler;
  // Cached first AxisGridLayer of the stack (insertion order), refreshed on
  // layer add/remove/reset — render() and friends read it every frame and must
  // not re-scan the stack (or allocate a type-guard closure) per frame.
  private axisLayer: AxisGridLayer | null = null;
  // WebGL backend (renderer:"webgl"); null = 2d path. Falls back to 2d when
  // context creation fails so the chart always renders.
  private glr: GlRenderer | null = null;
  // Layer ids already warned as unsupported under webgl (cleared on RESET).
  private readonly glWarned = new Set<string>();
  private bgColor = "#0b0d12";
  // Two orthogonal viewability signals. The engine renders only while BOTH are
  // true (see `applyViewability`): a hidden tab OR a scrolled-off chart fully
  // suspends the render loop, while data keeps flowing into the ring.
  // `visible`  — page visibility, driven by the host's `visibilitychange`.
  // `onScreen` — per-chart intersection, driven by the `pauseWhenOffscreen`
  //   IntersectionObserver (SET_ON_SCREEN). Defaults true, so charts that never
  //   opt in are unaffected.
  private visible = true;
  private onScreen = true;
  // Cached `visible && onScreen`, so `applyViewability` acts only on real
  // transitions (a redundant SET must not re-anchor the follow-clock window).
  private renderable = true;
  // Worker→main notifications. Default on; a host with no bounds/tick consumer
  // (e.g. a large thumbnail grid with externalAxes=false) can disable them to
  // skip per-frame postMessage + tick computation.
  private emitBounds = true;
  private emitTicks = true;
  // Opt-in render-load reporting (RENDER_STATS) for perf HUDs. Off → zero cost.
  private emitRenderStats = false;
  private rsRenders = 0;
  private rsBusyMs = 0;
  private rsWindowStart = -1;
  private hostId: string | undefined;
  /** Outbox routing key — solo hosts (no pool id) normalize to SOLO_HOST_ID. */
  private get outHostId(): string {
    return this.hostId ?? SOLO_HOST_ID;
  }
  private lastSentYMin = Number.NaN;
  private lastSentYMax = Number.NaN;
  private lastSentXTickMs = 0;
  // Skip BOUNDS_UPDATE when change is smaller than this fraction of the range.
  // Prevents flooding the main thread for sub-pixel y-range drift.
  private static readonly BOUNDS_EPS = 1e-4;

  constructor() {
    this.scheduler = new Scheduler((dirty) => this.render(dirty));
  }

  dispatch(msg: HostMsg): void {
    switch (msg.op) {
      case Op.INIT:
        this.hostId = msg.hostId;
        this.init(msg.canvas, msg.width, msg.height, msg.dpr, {
          bgColor: msg.bgColor,
          maxFps: msg.maxFps,
          emitBounds: msg.emitBounds,
          emitTicks: msg.emitTicks,
          transparent: msg.transparent,
          emitRenderStats: msg.emitRenderStats,
          inlineAxes: msg.inlineAxes,
          xAxisHeight: msg.xAxisHeight,
          yAxisWidth: msg.yAxisWidth,
          renderer: msg.renderer,
        });
        break;
      case Op.SET_BG_COLOR:
        this.bgColor = msg.color;
        this.scheduler.markDirty();
        break;
      case Op.RESIZE:
        this.resize(msg.width, msg.height, msg.dpr);
        break;
      case Op.ADD_LAYER: {
        const layer = createLayer(msg.id, msg.kind);
        if (msg.config !== undefined) layer.setConfig(msg.config);
        layer.resize(this.viewport);
        this.stack.add(layer);
        this.refreshAxisLayerRef();
        this.syncContinuousMode();
        this.scheduler.markDirty();
        break;
      }
      case Op.REMOVE_LAYER:
        this.stack.remove(msg.id);
        this.refreshAxisLayerRef();
        this.syncContinuousMode();
        this.scheduler.markDirty();
        break;
      case Op.CONFIG: {
        const layer = this.stack.get(msg.id);
        if (layer) {
          layer.setConfig(msg.config);
          this.syncContinuousMode();
          this.scheduler.markDirty();
        }
        break;
      }
      case Op.CONFIG_BATCH: {
        let applied = false;
        for (const { id, config } of msg.entries) {
          const layer = this.stack.get(id);
          if (layer) {
            layer.setConfig(config);
            applied = true;
          }
        }
        if (applied) {
          this.syncContinuousMode();
          this.scheduler.markDirty();
        }
        break;
      }
      case Op.DATA: {
        const layer = this.stack.get(msg.id);
        if (layer) {
          layer.setData(msg.buffer, msg.length, this.viewport);
          this.scheduler.markDirty();
        }
        break;
      }
      case Op.CLEAR_DATA: {
        const layer = this.stack.get(msg.id);
        layer?.clearData?.();
        // `latestT` is normally monotonic-up (advanced by layer setData).
        // An explicit rewind here is the only path a backward replay seek
        // can use to drag the time-mode axis window with it.
        if (msg.latestT !== undefined) {
          this.viewport.latestT = msg.latestT;
        }
        this.scheduler.markDirty();
        break;
      }
      case Op.DISPOSE:
        this.dispose();
        break;
      case Op.SET_AXIS_CANVAS:
        this.setAxisCanvas(msg as SetAxisCanvasMsg);
        break;
      case Op.SET_AXIS_STYLE: {
        const { color, font, tickSize, tickMargin, bgColor } = msg as {
          color?: string;
          font?: string;
          tickSize?: number;
          tickMargin?: number;
          bgColor?: string;
        };
        if (color !== undefined) this.axisStyle.color = color;
        if (font !== undefined) this.axisStyle.font = font;
        if (tickSize !== undefined) this.axisStyle.tickSize = tickSize;
        if (tickMargin !== undefined) this.axisStyle.tickMargin = tickMargin;
        if (bgColor !== undefined) this.axisStyle.bgColor = bgColor;
        this.scheduler.markDirty();
        break;
      }
      case Op.SET_VISIBLE: {
        this.visible = msg.visible;
        this.applyViewability();
        break;
      }
      case Op.SET_ON_SCREEN: {
        this.onScreen = msg.onScreen;
        this.applyViewability();
        break;
      }
      case Op.RESET:
        this.reset();
        break;
      case Op.RELEASE_BACKING:
        this.releaseBackings();
        break;
    }
  }

  /**
   * Free the GPU backing stores (main + axis canvases) by shrinking them to
   * 0×0 while KEEPING the canvas/context bindings and all engine state — the
   * worker half of parked-host idle shrink. Unlike `dispose`, the engine stays
   * fully usable: the next RESIZE re-allocates because the width-diff check
   * compares against 0. No `markDirty` — a parked host is invisible, and a
   * render onto a 0×0 canvas would be a wasted no-op anyway.
   */
  private releaseBackings(): void {
    Engine.releaseBacking(this.canvas);
    Engine.releaseBacking(this.xAxisCanvas);
    Engine.releaseBacking(this.yAxisCanvas);
  }

  /**
   * Reset to a pristine, just-constructed state while KEEPING the OffscreenCanvas
   * binding + worker engine alive — the worker side of host recycling. Disposes
   * every layer (empty stack) and rewinds the viewport/bounds/observed-y, the
   * emitted-bounds latches, and engine-level bg/axis style back to defaults.
   * After this, re-running the normal mount sequence (ADD_LAYER…, SET_BG_COLOR,
   * RESIZE, SET_VISIBLE) re-hydrates a recycled host indistinguishably from a
   * cold one. Construction-fixed settings (maxFps/emitBounds/emitTicks, the
   * canvas context, page-visibility) are intentionally preserved — they form
   * the recycle key, so a reused engine already matches the requesting mount.
   */
  /** Re-resolve the cached first AxisGridLayer after any stack mutation. */
  private refreshAxisLayerRef(): void {
    this.axisLayer = this.stack.findFirst(isAxisGrid) ?? null;
  }

  private reset(): void {
    this.stack.disposeAll();
    this.axisLayer = null;
    this.glWarned.clear();
    this.viewport.latestT = 0;
    this.viewport.setBounds({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
    this.viewport.yPadPx = 0;
    this.viewport.observedYMin = Number.POSITIVE_INFINITY;
    this.viewport.observedYMax = Number.NEGATIVE_INFINITY;
    this.bgColor = "#0b0d12";
    this.axisStyle = {};
    this.lastSentYMin = Number.NaN;
    this.lastSentYMax = Number.NaN;
    this.lastSentXTickMs = 0;
    this.rsRenders = 0;
    this.rsBusyMs = 0;
    this.rsWindowStart = -1;
    // Restore the per-chart on-screen signal to its pristine default. `visible`
    // is re-driven by the host (park sends SET_VISIBLE false, acquire true), but
    // `onScreen` is only re-sent for pauseWhenOffscreen mounts — so a host parked
    // while scrolled off (onScreen=false) and recycled into a plain mount would
    // stay wedged paused forever. Resetting here (and recomputing renderable /
    // unpausing to match `visible`) keeps a recycled engine indistinguishable
    // from a fresh one, whatever the next tenant's options.
    this.onScreen = true;
    this.renderable = this.visible;
    this.scheduler.setPaused(!this.renderable);
    this.syncContinuousMode();
    this.scheduler.markDirty();
  }

  private setAxisCanvas(msg: SetAxisCanvasMsg): void {
    if (this.glr) {
      // Defense-in-depth: the host already refuses to send axis canvases for a
      // webgl engine; a stray message must not bind 2d axis contexts.
      console.warn("[fluxion] SET_AXIS_CANVAS ignored under renderer:'webgl'.");
      return;
    }
    this.xAxisHeight = msg.xAxisHeight;
    this.yAxisWidth = msg.yAxisWidth;
    if (msg.xAxisCanvas) {
      this.xAxisCanvas = msg.xAxisCanvas;
      this.xAxisCtx = msg.xAxisCanvas.getContext("2d");
      // Labels now render on the axis canvas — the grid layer must not also
      // format + draw them in-plot (the double-label footgun).
      this.viewport.externalXAxis = true;
    }
    if (msg.yAxisCanvas) {
      this.yAxisCanvas = msg.yAxisCanvas;
      this.yAxisCtx = msg.yAxisCanvas.getContext("2d");
      this.viewport.externalYAxis = true;
    }
    // Size the axis canvases to match the current viewport.
    this.resizeAxisCanvases(
      this.viewport.widthPx,
      this.viewport.heightPx,
      this.viewport.dpr,
    );
    this.scheduler.markDirty();
  }

  private init(
    canvas: OffscreenCanvas,
    width: number,
    height: number,
    dpr: number,
    opts: {
      bgColor?: string;
      maxFps?: number;
      emitBounds?: boolean;
      emitTicks?: boolean;
      transparent?: boolean;
      emitRenderStats?: boolean;
      inlineAxes?: boolean;
      xAxisHeight?: number;
      yAxisWidth?: number;
      renderer?: RendererKind;
    },
  ) {
    this.canvas = canvas;
    if (opts.inlineAxes) {
      // Reserve in-canvas margins; the viewport maps data into the plot rect
      // and drawInlineAxes renders ticks/labels into the strips. Construction-
      // fixed (part of the recycle key) — RESET keeps them, like axis canvases.
      this.viewport.insetLeft = opts.yAxisWidth ?? 60;
      this.viewport.insetBottom = opts.xAxisHeight ?? 30;
      // Margin labels replace in-plot labels — reuse the external-axis gates
      // so the grid layer doesn't format/draw them twice.
      this.viewport.externalXAxis = true;
      this.viewport.externalYAxis = true;
    }
    // Opaque context (alpha:false) composites faster — the engine fills `bgColor`
    // over the whole canvas every frame, so it's opaque regardless. `transparent`
    // opts back into an alpha channel for translucent backgrounds.
    if (opts.renderer === "webgl") {
      this.glr = GlRenderer.tryCreate(canvas, { alpha: opts.transparent === true }, () =>
        this.scheduler.markDirty(),
      );
      if (!this.glr) {
        console.warn(
          "[fluxion] webgl context unavailable — falling back to the 2d renderer.",
        );
      }
    }
    if (!this.glr) {
      this.ctx = canvas.getContext("2d", { alpha: opts.transparent === true });
    }
    if (opts.bgColor !== undefined) this.bgColor = opts.bgColor;
    if (opts.maxFps !== undefined) this.scheduler.setMaxFps(opts.maxFps);
    if (opts.emitBounds !== undefined) this.emitBounds = opts.emitBounds;
    if (opts.emitTicks !== undefined) this.emitTicks = opts.emitTicks;
    if (opts.emitRenderStats !== undefined) this.emitRenderStats = opts.emitRenderStats;
    this.resize(width, height, dpr);
    // Always clear on init: the freshly created/transferred backing is black
    // regardless of whether `resize` changed its dimensions (a canvas already
    // at the target size wouldn't reallocate, so resize's gated clear skips it).
    this.clearBacking();
    this.scheduler.start();
    this.scheduler.markDirty();
  }

  /**
   * A freshly (re)allocated backing composites as SOLID BLACK until the first
   * rendered frame — the scheduler's first frame is ≥1 rAF after INIT/resize,
   * so a light-theme chart flashes black in the gap. Fill `bgColor` synchronously
   * so the first composite already matches. This is NOT WebGL-only: the default
   * 2d context is opaque (`alpha:false`), whose bitmap also initializes to — and
   * re-clears on every `canvas.width/height` assignment to — opaque black.
   * (`transparent:true` → `alpha:true` → transparent init, so there's no black to
   * hide; filling anyway is harmless — `render2d` fills `bgColor` every frame.)
   */
  private clearBacking(): void {
    if (this.glr) {
      this.glr.beginFrame(this.bgColor);
      return;
    }
    const ctx = this.ctx;
    /* v8 ignore start -- init always binds a 2d ctx when glr is null (mirror render2d) */
    if (!ctx || !this.canvas) return;
    /* v8 ignore stop */
    // viewport.setSize hasn't run yet at init/resize time — fill the raw backing
    // under an identity transform (device px).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(width: number, height: number, dpr: number) {
    if (!this.canvas) return;
    // Assigning width/height reallocates the GPU backing AND clears the canvas
    // even when the value is unchanged — skip no-op resizes (a ResizeObserver can
    // re-fire with the same size during layout churn).
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    // A dimension change reallocates AND clears the backing (to opaque black for
    // the default alpha:false 2d context / to black for a GL buffer). Only then
    // does it need a synchronous bg fill — re-filling on a no-op resize (a
    // ResizeObserver re-firing the same size) would wipe the current frame.
    const reallocated = this.canvas.width !== w || this.canvas.height !== h;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (reallocated) this.clearBacking();
    this.viewport.setSize(width, height, dpr);
    this.stack.resizeAll(this.viewport);
    this.resizeAxisCanvases(width, height, dpr);
    this.scheduler.markDirty();
  }

  private resizeAxisCanvases(width: number, height: number, dpr: number): void {
    if (this.xAxisCanvas) {
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(this.xAxisHeight * dpr));
      if (this.xAxisCanvas.width !== w) this.xAxisCanvas.width = w;
      if (this.xAxisCanvas.height !== h) this.xAxisCanvas.height = h;
    }
    if (this.yAxisCanvas) {
      const w = Math.max(1, Math.round(this.yAxisWidth * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (this.yAxisCanvas.width !== w) this.yAxisCanvas.width = w;
      if (this.yAxisCanvas.height !== h) this.yAxisCanvas.height = h;
    }
  }

  private render(dirty = true) {
    /* v8 ignore start -- render only runs via the scheduler after init; canvas is always set */
    if (!this.canvas) return;
    /* v8 ignore stop */
    const rsStart = this.emitRenderStats ? performance.now() : 0;
    // 2-pass: scan (orchestration: time window, observed y, bounds) then
    // draw. AxisGridLayer.scan writes bounds; LineChartLayer.scan reads
    // bounds and publishes observed y extents; AxisGridLayer.draw finishes
    // the y-auto computation using those extents.
    this.viewport.beginScan();
    this.stack.scanAll(this.viewport);
    if (this.glr) {
      this.renderGl();
    } else {
      this.render2d();
    }

    // Notify main thread when effective y bounds change (yMode:"auto").
    // Uses an epsilon gate so sub-pixel drift doesn't flood the main thread.
    const { yMin, yMax } = this.viewport.bounds;
    const range = yMax - yMin || 1;
    const eps = range * Engine.BOUNDS_EPS;
    // `lastSentYMin/Max` start as NaN; `Math.abs(y - NaN) > eps` is always false,
    // which would suppress the very first BOUNDS_UPDATE forever. Treat an unset
    // (NaN) baseline as "changed" so the initial bounds are reported.
    const boundsChanged =
      Number.isNaN(this.lastSentYMin) ||
      Math.abs(yMin - this.lastSentYMin) > eps ||
      Math.abs(yMax - this.lastSentYMax) > eps;
    if (boundsChanged) {
      // Latch the baseline even when emission is off, so `boundsChanged` (used
      // below to gate the y-axis redraw) stays correct frame to frame.
      this.lastSentYMin = yMin;
      this.lastSentYMax = yMax;
      if (this.emitBounds) {
        // Staged into the shared outbox; the worker entry drains it into one
        // BATCH_UPDATE per frame (shared/model/outbox.ts).
        enqueueBounds(this.outHostId, yMin, yMax, this.viewport.latestT);
      }
    }

    // Draw axis canvases synchronously in the same rAF cycle (zero lag).
    const { dpr } = this.viewport;
    const axisLayer = this.axisLayer;
    if (axisLayer) {
      if (this.xAxisCtx && this.xAxisCanvas) {
        this.xAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // BOTH dimensions come from the backing, not from `xAxisHeight`. The
        // backing is `round(xAxisHeight * dpr)` device px, which at a
        // fractional dpr is not `xAxisHeight * dpr` exactly — e.g. the default
        // 30 at dpr 1.25 rounds 37.5 up to 38, i.e. 30.4 CSS px. Passing the
        // nominal 30 made the layer clear and fill 30 of those 30.4 px, leaving
        // the bottom half-device-row holding the previous frame.
        axisLayer.drawXAxis(
          this.xAxisCtx,
          this.xAxisCanvas.width / dpr,
          this.xAxisCanvas.height / dpr,
          this.axisStyle,
          dpr,
        );
      }
      // The y-axis only changes when y bounds shift or a one-shot redraw was
      // requested (resize/config/style). On a pure follow-clock continuous
      // frame, only the x-axis scrolls — skip the y-axis fill+text entirely.
      if (this.yAxisCtx && this.yAxisCanvas && (dirty || boundsChanged)) {
        this.yAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Backing-derived on both axes, same reason as drawXAxis above.
        axisLayer.drawYAxis(
          this.yAxisCtx,
          this.yAxisCanvas.width / dpr,
          this.yAxisCanvas.height / dpr,
          this.axisStyle,
          this.viewport.yPadPx,
          dpr,
        );
      }
    }

    // Only send TICK_UPDATE when axis canvases are not present (React-side
    // fallback) and a consumer wants them.
    if (this.emitTicks && !this.xAxisCanvas && !this.yAxisCanvas) {
      this.maybeSendTickUpdate(boundsChanged);
    }

    if (this.emitRenderStats) this.recordRenderStats(rsStart);
  }

  /** canvas2d paint pass: bg fill + clipped layer draw + inline axes. */
  private render2d(): void {
    const ctx = this.ctx;
    /* v8 ignore start -- init always binds a 2d ctx when glr is null */
    if (!ctx) return;
    /* v8 ignore stop */
    const { dpr } = this.viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, this.viewport.widthPx, this.viewport.heightPx);
    // Inline-axes mode: confine data/grid strokes to the plot rect so nothing
    // bleeds into the reserved margins; axis ticks/labels are drawn AFTER the
    // restore so they land in the margins unclipped.
    const inline = this.viewport.insetLeft > 0 || this.viewport.insetBottom > 0;
    if (inline) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        this.viewport.plotLeft,
        0,
        this.viewport.plotWidth,
        this.viewport.plotHeight,
      );
      ctx.clip();
    }
    this.stack.drawAll(ctx, this.viewport);
    if (inline) {
      ctx.restore();
      this.axisLayer?.drawInlineAxes(ctx, this.viewport, this.axisStyle);
    }
  }

  /**
   * WebGL paint pass: clear + scissored layer fan-out. Layers without a
   * `drawGl` path are skipped with a one-time warn. While the GL context is
   * lost the whole frame is skipped (the compositor keeps the last image).
   */
  private renderGl(): void {
    const glr = this.glr;
    /* v8 ignore start -- only called when glr is set */
    if (!glr) return;
    /* v8 ignore stop */
    if (!glr.beginFrame(this.bgColor)) return;
    const inline = this.viewport.insetLeft > 0 || this.viewport.insetBottom > 0;
    if (inline) glr.scissorPlotRect(this.viewport);
    this.stack.drawGlAll(glr, this.viewport, (l) => this.warnGlUnsupported(l));
    if (inline) {
      glr.scissorOff();
      this.axisLayer?.drawInlineAxesGl(glr, this.viewport, this.axisStyle);
    }
  }

  private warnGlUnsupported(layer: Layer): void {
    if (this.glWarned.has(layer.id)) return;
    this.glWarned.add(layer.id);
    console.warn(
      `[fluxion] layer "${layer.id}" has no WebGL draw path — skipped under renderer:'webgl'.`,
    );
  }

  /**
   * Accumulate this frame's render time and, once a ~1s wall-clock window has
   * elapsed, post a RENDER_STATS snapshot. Opt-in (emitRenderStats); lets a perf
   * HUD tell main-thread mount spikes from worker-thread render saturation.
   */
  private recordRenderStats(startMs: number): void {
    const now = performance.now();
    this.rsBusyMs += now - startMs;
    this.rsRenders++;
    if (this.rsWindowStart < 0) this.rsWindowStart = startMs;
    const windowMs = now - this.rsWindowStart;
    if (windowMs >= 1000) {
      enqueueStats(this.outHostId, this.rsRenders, this.rsBusyMs, windowMs);
      this.rsRenders = 0;
      this.rsBusyMs = 0;
      this.rsWindowStart = now;
    }
  }

  private maybeSendTickUpdate(boundsChanged: boolean): void {
    const axisLayer = this.axisLayer;
    if (!axisLayer) return;

    const now = Date.now();
    const xInterval = axisLayer.getXTickIntervalMs() ?? 1000;
    const xChanged = now - this.lastSentXTickMs >= xInterval;

    if (!xChanged && !boundsChanged) return;

    if (xChanged) this.lastSentXTickMs = now;

    const ticks = axisLayer.computeTicksForExport();
    enqueueTicks(this.outHostId, ticks.xTicks, ticks.yTicks, ticks.xRawValues);
  }

  /**
   * Push a pre-parsed Float32Array directly into a layer's ring buffer.
   * Called from a custom worker streamHandler — bypasses HostMsg serialization.
   * Data layout must match what the layer expects (e.g. [t, y, t, y, …] for line).
   */
  /**
   * Enable continuous rendering when the stack's axis layer is following the
   * wall clock (time-mode + followClock + timeOrigin); disable it otherwise so
   * static/data-driven charts keep their zero-idle-cost dirty-gated loop.
   * Called after any op that can change layer presence or config.
   */
  private syncContinuousMode(): void {
    const follow = this.axisLayer?.isFollowingClock() ?? false;
    // Suspend the continuous loop whenever the chart isn't viewable (hidden tab
    // or scrolled off-screen) — no point scrolling an axis nobody can see, and
    // it saves CPU/battery.
    this.scheduler.setContinuous(this.visible && this.onScreen && follow);
  }

  /**
   * Apply a change to either viewability signal (`visible`/`onScreen`). Renders
   * iff both are true. Acts only on a real transition so a redundant SET doesn't
   * re-anchor a live follow-clock window (which would visibly jump). On becoming
   * renderable, re-anchors the follow-clock window to the current wall clock
   * (elapsed off-screen time is real) and marks dirty so one frame repaints the
   * full history buffered while paused. On becoming non-renderable, hard-pauses
   * the scheduler — data ingestion continues untouched, only the paint stops.
   */
  private applyViewability(): void {
    const next = this.visible && this.onScreen;
    if (next === this.renderable) return;
    this.renderable = next;
    this.scheduler.setPaused(!next);
    this.syncContinuousMode();
    if (next) {
      this.axisLayer?.resetClockAnchor();
      this.scheduler.markDirty();
    }
  }

  pushRaw(layerId: string, data: Float32Array): void {
    const layer = this.stack.get(layerId);
    if (!layer) return;
    layer.setData(data.buffer as ArrayBuffer, data.length, this.viewport);
    this.scheduler.markDirty();
  }

  private dispose() {
    this.scheduler.stop();
    this.stack.disposeAll();
    this.axisLayer = null;
    this.glr?.dispose();
    this.glr = null;
    // Release each OffscreenCanvas's GPU backing store NOW instead of waiting for
    // GC. A `transferControlToOffscreen()` canvas keeps its GPU surface alive
    // until the OffscreenCanvas is garbage-collected; under rapid mount/unmount
    // churn (e.g. a pool host per chart in a large accordion) those surfaces pile
    // up and exhaust GPU memory, eventually losing the context and freezing every
    // chart. Resizing to 0×0 frees the backing synchronously — and the linked
    // main-thread placeholder <canvas> shrinks with it — so churn can't accumulate.
    Engine.releaseBacking(this.canvas);
    Engine.releaseBacking(this.xAxisCanvas);
    Engine.releaseBacking(this.yAxisCanvas);
    this.canvas = null;
    this.ctx = null;
    this.xAxisCanvas = null;
    this.xAxisCtx = null;
    this.yAxisCanvas = null;
    this.yAxisCtx = null;
  }

  /** Free an OffscreenCanvas's GPU backing immediately by shrinking it to 0×0. */
  private static releaseBacking(canvas: OffscreenCanvas | null): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }
}
