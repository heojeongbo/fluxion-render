/**
 * Shared, rAF-throttled queue for spreading expensive chart lifecycle work
 * (host creation AND teardown) across frames.
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
 * per animation frame, fanning both bursts out over time. Tune the rate with
 * `configureMountScheduler({ perFrame })`.
 */

type LifecycleTask = { run: () => void; cancelled: boolean };

let perFrame = 4;
const queue: LifecycleTask[] = [];
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  // setTimeout fallback for non-DOM/worker contexts where rAF is absent.
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(drain);
  } else {
    setTimeout(drain, 16);
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
    try {
      task.run();
    } catch (err) {
      console.error("[fluxion] lifecycle task error:", err);
    }
  }
  // Still work left this batch couldn't cover → continue next frame.
  if (queue.length > 0) schedule();
}

function enqueue(run: () => void): LifecycleTask {
  const task: LifecycleTask = { run, cancelled: false };
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
  const t = enqueue(task);
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
  enqueue(task);
}

/**
 * Tune how many queued host creations run per animation frame. Higher = charts
 * appear faster but with a larger per-frame spike; lower = smoother but slower
 * to fill. Default 4. Ignored for non-positive values.
 */
export function configureMountScheduler(opts: { perFrame?: number }): void {
  if (opts.perFrame != null && opts.perFrame > 0) {
    perFrame = Math.floor(opts.perFrame);
  }
}

/**
 * Run every queued lifecycle task NOW — synchronously, ignoring `perFrame` and
 * the animation frame — then clear the pending-frame flag. For tests: makes the
 * deferred (default) mount/dispose deterministic without fake timers. Render,
 * `flushMountScheduler()`, then assert the host is ready; unmount,
 * `flushMountScheduler()` again, then assert teardown ran. Wrap the call in
 * `act()` when asserting React state, since a flushed mount calls `setHost`.
 * Cancelled tasks are skipped and a throwing task is isolated (logged).
 */
export function flushMountScheduler(): void {
  while (queue.length > 0) {
    const task = queue.shift() as LifecycleTask;
    if (task.cancelled) continue;
    try {
      task.run();
    } catch (err) {
      console.error("[fluxion] lifecycle task error:", err);
    }
  }
  scheduled = false;
}

/**
 * Drop all queued tasks and clear the pending-frame flag without running them.
 * Call in a test `afterEach` so the module-global queue can't leak pending
 * mounts/disposes across tests.
 */
export function resetMountScheduler(): void {
  queue.length = 0;
  scheduled = false;
}
