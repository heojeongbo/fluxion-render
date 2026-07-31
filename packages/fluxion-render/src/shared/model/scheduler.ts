import { type FrameDriver, type FrameSubscriber, getFrameDriver } from "./frame-driver";

/**
 * Per-engine render scheduler. Only calls `tick` on frames where dirty is set.
 * Frames are delivered by the shared per-global {@link FrameDriver} (one rAF
 * loop per worker, shared by every engine multiplexed onto it) rather than a
 * private loop, and the driver idles entirely while no scheduler needs frames.
 */
export class Scheduler implements FrameSubscriber {
  private dirty = false;
  private continuous = false;
  private running = false;
  // Hard render suspend, distinct from the fps cap. While paused, `onFrame`
  // ticks NOTHING and does not consume `dirty`, so the shared driver idle-stops
  // this engine entirely — used when a chart is off-screen or its tab is hidden.
  // `dirty` stays latched across the pause, so a single frame on resume repaints
  // the full buffered history (no data gap: ingestion is never gated on this).
  private paused = false;
  private readonly driver: FrameDriver;
  private readonly tick: (dirty: boolean) => void;
  // Render-rate cap. 0 = uncapped (render on every dirty/continuous frame, the
  // default). When > 0, renders are throttled to at most `1000 / minFrameMs`
  // per second; skipped frames keep the dirty flag latched so no data is lost.
  private minFrameMs = 0;
  private lastRenderMs = Number.NEGATIVE_INFINITY;

  /**
   * `tick` receives whether THIS frame was triggered by the dirty flag (a
   * one-shot redraw: data, config, resize, style) as opposed to a pure
   * continuous frame (a follow-clock scroll where only the time axis moves).
   * The engine uses this to skip redundant work — e.g. re-rendering the y-axis
   * canvas — on continuous frames where nothing y-related changed.
   */
  constructor(tick: (dirty: boolean) => void, driver: FrameDriver = getFrameDriver()) {
    this.tick = tick;
    this.driver = driver;
  }

  /**
   * When true, `tick` fires on every frame regardless of the dirty flag. Used
   * for wall-clock-following time axes that must redraw to scroll even when no
   * data arrives. When false, returns to the default dirty-gated behavior.
   */
  setContinuous(on: boolean) {
    this.continuous = on;
    // Wake the loop immediately so the first continuous frame doesn't wait for
    // an external markDirty. Never wake while paused — a paused engine renders
    // nothing until resumed.
    if (on && !this.paused) {
      this.dirty = true;
      if (this.running) this.driver.wake();
    }
  }

  /**
   * Hard-suspend or resume rendering, independent of the fps cap. While paused,
   * {@link onFrame} skips the tick without consuming `dirty` and reports no need
   * for frames, so the shared driver idles this engine. On resume, a latched
   * `dirty` (or continuous mode) wakes the driver so the pending frame renders
   * immediately — the full history buffered while paused paints in one frame.
   */
  setPaused(on: boolean) {
    this.paused = on;
    if (!on && this.running && (this.dirty || this.continuous)) this.driver.wake();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.driver.add(this);
    this.driver.wake();
  }

  stop() {
    this.running = false;
    this.driver.remove(this);
  }

  markDirty() {
    this.dirty = true;
    // Latch the dirty flag even while paused (so resume repaints), but don't
    // wake the driver — a paused, off-screen chart must not burn a frame per
    // incoming data message.
    if (this.running && !this.paused) this.driver.wake();
  }

  /**
   * Cap the render rate to at most `fps` frames/sec. Useful when many engines
   * share a worker (e.g. a large chart grid): at 500 Hz the dirty flag is set
   * ~60×/sec, so an uncapped engine redraws 60 fps; capping to 30 roughly
   * halves worker scan+draw CPU and is visually indistinguishable for a
   * scrolling time window. `undefined`/`0`/negative restores uncapped.
   *
   * Throttling applies to the dirty path too (not just continuous), and a
   * frame skipped under the interval keeps `dirty` latched so the pending data
   * renders on the next eligible frame — nothing is dropped.
   */
  setMaxFps(fps: number | undefined) {
    this.minFrameMs = fps && fps > 0 ? 1000 / fps : 0;
  }

  // Whether this frame is allowed to render under the FPS cap. Uncapped: always
  // (no clock read, so the default path is unchanged). Capped: only once the
  // min frame interval has elapsed since the last render.
  private shouldRender(): boolean {
    if (this.minFrameMs === 0) return true;
    const now = performance.now();
    if (now - this.lastRenderMs < this.minFrameMs) return false;
    this.lastRenderMs = now;
    return true;
  }

  /**
   * Driver contract ({@link FrameSubscriber}) — not part of the scheduler's
   * public semantics. Returns whether this scheduler still needs frames.
   */
  onFrame(): boolean {
    // Paused: render nothing and keep `dirty` latched (do NOT consume it), and
    // report no need for frames so the shared driver idle-stops this engine.
    if (this.paused) return false;
    if ((this.continuous || this.dirty) && this.shouldRender()) {
      const wasDirty = this.dirty;
      this.dirty = false;
      try {
        this.tick(wasDirty);
      } catch (err) {
        // A render error must NOT stall this engine. The driver also isolates
        // subscriber throws, but catching here preserves this scheduler's own
        // keep-alive answer below (a throwing continuous engine keeps
        // animating next frame) and keeps the log message engine-specific.
        console.error("[fluxion] render error (frame skipped):", err);
      }
    }
    // dirty stays latched when shouldRender() skipped under the fps cap —
    // returning true keeps the shared loop alive until the latched frame
    // renders, with no external markDirty. `running` covers stop() called
    // from inside tick: report no further need instead of one extra frame.
    return this.running && (this.continuous || this.dirty);
  }
}
