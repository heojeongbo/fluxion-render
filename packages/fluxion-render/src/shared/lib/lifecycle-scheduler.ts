/**
 * Shared, rAF-throttled queues for spreading expensive chart lifecycle work
 * (host creation, teardown, AND canvas resizes) across frames.
 *
 * Mounting many `FluxionCanvas`es at once — an accordion section expanding, a
 * dashboard grid appearing — runs `new FluxionHost()` (OffscreenCanvas alloc +
 * `transferControlToOffscreen` handshake + `POOL_INIT` + first render) for each
 * in a single frame. Collapsing that section is the symmetric problem: every
 * chart's `host.dispose()` (final flush + `DISPOSE`/`POOL_DISPOSE` post + worker
 * engine teardown) runs in one frame, a thousand-plus synchronous `postMessage`s
 * layered on React's bulk unmount — enough to freeze the main thread for a beat.
 *
 * `enqueueMount` / `enqueueDispose` defer each task and drain at most `perFrame`
 * per animation frame, fanning both bursts out over time.
 *
 * Resizes are the third burst shape: one layout change (a split-pane drag, a
 * window resize, a DPR flip) hits EVERY chart's ResizeObserver in the same
 * tick, and each `Op.RESIZE` reallocates up to three GPU backing stores (main +
 * axis canvases) in the worker. `scheduleResize` coalesces those into a
 * latest-wins-per-host lane drained at most `resizePerFrame` per frame, so a
 * grid-wide resize spreads across frames instead of spiking one. Tune both
 * rates with `configureLifecycleScheduler({ perFrame, resizePerFrame })`.
 */

type LifecycleTask = { run: () => void; cancelled: boolean; kind: "mount" | "dispose" };

/** Structural target for {@link scheduleResize} — satisfied by `FluxionHost`. */
export interface Resizable {
  resize(width: number, height: number, dpr: number): void;
}

/** CSS-pixel size + devicePixelRatio a {@link scheduleResize} target should adopt. */
export interface ResizeRequest {
  width: number;
  height: number;
  dpr: number;
}

/** Snapshot returned by {@link getLifecycleStats}. */
export interface LifecycleSchedulerStats {
  /** Host creations the queue has run (lifetime, until reset). */
  mountsRun: number;
  /** Host teardowns the queue has run (lifetime, until reset). */
  disposesRun: number;
  /** Resizes the lane has applied (lifetime, until reset). */
  resizesApplied: number;
  /** Live (non-cancelled) mount/dispose tasks currently queued. */
  pendingTasks: number;
  /** Hosts with a resize currently pending. */
  pendingResizes: number;
}

let perFrame = 4;
let resizePerFrame = 8;
const queue: LifecycleTask[] = [];
// Latest-wins per target: `Map.set` on an existing key replaces the pending
// size but KEEPS the original insertion position, so a chart that resizes
// repeatedly neither queues stale sizes nor jumps the FIFO line.
const resizeQueue = new Map<Resizable, ResizeRequest>();
let scheduled = false;
// Burst observability — read via getLifecycleStats(), zeroed by resetLifecycleScheduler().
let mountsRun = 0;
let disposesRun = 0;
let resizesApplied = 0;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  // rAF is the normal drain trigger, but it never fires in a hidden tab — a
  // teardown queued right before backgrounding (route change, pool dispose)
  // would hold its GPU backings until the tab is foregrounded. Fall back to a
  // (browser-throttled) timeout while hidden; the same fallback covers
  // non-DOM/worker contexts where rAF is absent.
  const hidden = typeof document !== "undefined" && document.hidden;
  if (typeof requestAnimationFrame !== "undefined" && !hidden) {
    requestAnimationFrame(drain);
  } else {
    setTimeout(drain, 16);
  }
}

function applyResize(target: Resizable, size: ResizeRequest): void {
  resizesApplied++;
  // A throwing resize must not stop the drain — same isolation as tasks.
  try {
    target.resize(size.width, size.height, size.dpr);
  } catch (err) {
    console.error("[fluxion] lifecycle task error:", err);
  }
}

function drain(): void {
  scheduled = false;
  let ran = 0;
  while (queue.length > 0 && ran < perFrame) {
    const task = queue.shift() as LifecycleTask;
    // Cancelled tasks (a chart unmounted before its mount ran) are dropped for
    // free and don't consume the per-frame budget — bulk cancel stays O(n).
    if (task.cancelled) continue;
    ran++;
    // A throwing task must not stop the drain — isolate and keep going so one
    // bad mount/dispose can't strand every later one in the queue.
    runTask(task);
  }
  // Resize lane: independent budget so a grid-wide resize storm can't starve
  // pending mounts/disposes (or vice versa). Deleting while iterating a Map is
  // safe, and entries are removed BEFORE applying so a re-schedule from inside
  // `resize` lands in a later frame instead of this loop.
  let resized = 0;
  for (const [target, size] of resizeQueue) {
    if (resized >= resizePerFrame) break;
    resizeQueue.delete(target);
    resized++;
    applyResize(target, size);
  }
  // Still work left this batch couldn't cover → continue next frame.
  if (queue.length > 0 || resizeQueue.size > 0) schedule();
}

function runTask(task: LifecycleTask): void {
  if (task.kind === "mount") mountsRun++;
  else disposesRun++;
  try {
    task.run();
  } catch (err) {
    console.error("[fluxion] lifecycle task error:", err);
  }
}

function enqueue(run: () => void, kind: LifecycleTask["kind"]): LifecycleTask {
  const task: LifecycleTask = { run, cancelled: false, kind };
  queue.push(task);
  schedule();
  return task;
}

/**
 * Queue a host-creation callback to run on a later frame (at most `perFrame`
 * run per frame). Returns a cancel function — call it on unmount so a chart that
 * disappears before its turn never creates a host. Cancel is O(1) (a tombstone),
 * so collapsing a large accordion mid-mount doesn't spike.
 */
export function enqueueMount(task: () => void): () => void {
  const t = enqueue(task, "mount");
  return () => {
    t.cancelled = true;
  };
}

/**
 * Queue a host-teardown callback to run on a later frame (same `perFrame` budget
 * as mounts). Use it to spread a bulk unmount's `host.dispose()` burst across
 * frames instead of running every teardown in the unmount commit.
 */
export function enqueueDispose(task: () => void): void {
  enqueue(task, "dispose");
}

/**
 * Queue a resize for `target`, coalescing with any resize already pending for
 * it (latest size wins; queue position is kept). At most `resizePerFrame`
 * targets are resized per animation frame, so a layout change that hits N
 * charts at once reallocates their GPU backings over ⌈N/resizePerFrame⌉ frames
 * instead of one. A queued resize is never dropped — it stays pending until
 * applied or explicitly removed via {@link cancelResize}.
 */
export function scheduleResize(target: Resizable, size: ResizeRequest): void {
  resizeQueue.set(target, size);
  schedule();
}

/**
 * Drop the pending resize for `target`, if any. Call on unmount so a stale
 * resize can't touch a host after its chart is gone — it would reallocate a
 * parked (recycled) host's backing, or resize one queued for dispose.
 */
export function cancelResize(target: Resizable): void {
  resizeQueue.delete(target);
}

/**
 * Tune the per-frame budgets. `perFrame`: how many queued host creations /
 * teardowns run per animation frame (default 4). `resizePerFrame`: how many
 * pending host resizes are applied per frame (default 8 — a resize is cheaper
 * than a create: ≤3 backing reallocations, no worker init or first render).
 * Higher = faster settle but a larger per-frame spike; lower = smoother but
 * slower. Values below 1 (and missing/NaN) are ignored — a budget can never
 * be configured to 0, which would starve the lane forever.
 */
export function configureLifecycleScheduler(opts: {
  perFrame?: number;
  resizePerFrame?: number;
}): void {
  // Floor BEFORE validating: 0.5 must be rejected, not floored to a 0 budget.
  if (opts.perFrame != null) {
    const v = Math.floor(opts.perFrame);
    if (v > 0) perFrame = v;
  }
  if (opts.resizePerFrame != null) {
    const v = Math.floor(opts.resizePerFrame);
    if (v > 0) resizePerFrame = v;
  }
}

/**
 * Run every queued lifecycle task and pending resize NOW — synchronously,
 * ignoring the per-frame budgets and the animation frame — then clear the
 * pending-frame flag. For tests: makes the deferred (default) mount/dispose and
 * scheduled resizes deterministic without fake timers. Render,
 * `flushLifecycleScheduler()`, then assert the host is ready; unmount,
 * `flushLifecycleScheduler()` again, then assert teardown ran. Wrap the call in
 * `act()` when asserting React state, since a flushed mount calls `setHost`.
 * Cancelled tasks are skipped and a throwing task is isolated (logged).
 */
export function flushLifecycleScheduler(): void {
  while (queue.length > 0) {
    const task = queue.shift() as LifecycleTask;
    if (task.cancelled) continue;
    runTask(task);
  }
  for (const [target, size] of resizeQueue) {
    resizeQueue.delete(target);
    applyResize(target, size);
  }
  scheduled = false;
}

/**
 * Snapshot of the scheduler's counters and queue depths — the main-thread half
 * of a burst investigation. Pair with the recycle pool's `stats` (cold creates
 * vs warm reuses vs overflow disposes) to see WHERE a mount/resize storm comes
 * from and how fast the queues are draining. Counters accumulate until
 * {@link resetLifecycleScheduler}; the two `pending*` fields are live gauges.
 */
export function getLifecycleStats(): LifecycleSchedulerStats {
  let pendingTasks = 0;
  for (const t of queue) {
    if (!t.cancelled) pendingTasks++;
  }
  return {
    mountsRun,
    disposesRun,
    resizesApplied,
    pendingTasks,
    pendingResizes: resizeQueue.size,
  };
}

/**
 * Drop all queued tasks and pending resizes, zero the stats counters, and
 * clear the pending-frame flag, without running anything. Call in a test
 * `afterEach` so the module-global queues can't leak pending
 * mounts/disposes/resizes across tests.
 */
export function resetLifecycleScheduler(): void {
  queue.length = 0;
  resizeQueue.clear();
  scheduled = false;
  mountsRun = 0;
  disposesRun = 0;
  resizesApplied = 0;
}
