/**
 * Shared IntersectionObserver singleton for the `pauseWhenOffscreen` opt-in.
 *
 * One observer per distinct `(root, rootMargin)` config is shared across every
 * chart using it — a grid of N charts costs ONE observer, not N (mirrors the
 * flush-scheduler / shared-ticker "one main-thread primitive for all hosts"
 * pattern). Each observed element reports its on-screen state to a callback,
 * which the React hook forwards to `host.setOnScreen(...)`.
 *
 * This gates only RENDERING (via the worker engine), never data — a chart
 * scrolled off-screen keeps ingesting into its ring, so scrolling it back into
 * view repaints the full buffered history rather than starting empty.
 */

export interface OnScreenObserveOptions {
  /**
   * Intersection root. `null`/omitted = the viewport (works for page scroll and
   * most nested scrollers). Pass a scroll-container Element for a dashboard pane
   * whose clipping the viewport doesn't capture.
   */
  root?: Element | null;
  /**
   * Margin grown around the root before computing intersection. A positive
   * value (default `"200px"`) pre-warms charts just outside the viewport so
   * they're already painted when scrolled in — avoids a one-frame blank/stale
   * flash. Data correctness never depends on this (the ring already holds the
   * history); it's purely a scroll-in UX knob.
   */
  rootMargin?: string;
}

let defaultRoot: Element | null = null;
let defaultRootMargin = "200px";

interface ObserverEntry {
  io: IntersectionObserver;
  cbs: Map<Element, (onScreen: boolean) => void>;
  key: string;
}

// One entry per (root, rootMargin) config, plus a reverse index so `unobserve`
// finds an element's owning observer without re-deriving its config.
const observers = new Map<string, ObserverEntry>();
const owners = new Map<Element, ObserverEntry>();

// Stable id per root object for the config key (roots aren't stringifiable).
let rootSeq = 0;
const rootIds = new WeakMap<Element, number>();
function rootId(root: Element | null): string {
  if (root === null) return "viewport";
  let id = rootIds.get(root);
  if (id === undefined) {
    id = ++rootSeq;
    rootIds.set(root, id);
  }
  return `r${id}`;
}

/**
 * Set process-wide defaults for `root`/`rootMargin` used by every
 * `observeOnScreen` call that doesn't override them. Call once at startup.
 */
export function configureOnScreenObserver(opts: OnScreenObserveOptions): void {
  if (opts.root !== undefined) defaultRoot = opts.root;
  if (opts.rootMargin !== undefined) defaultRootMargin = opts.rootMargin;
}

/**
 * Observe `el`'s on-screen state, invoking `cb(onScreen)` on every change (and
 * once initially, async, per the IntersectionObserver contract). Returns an
 * unobserve function; when the last element of a shared observer unregisters,
 * that observer is disconnected.
 *
 * When IntersectionObserver is unavailable (SSR, old runtime), `cb(true)` fires
 * once and a no-op unobserve is returned — the chart renders normally.
 */
export function observeOnScreen(
  el: Element,
  cb: (onScreen: boolean) => void,
  opts?: OnScreenObserveOptions,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  const root = opts?.root !== undefined ? opts.root : defaultRoot;
  const rootMargin = opts?.rootMargin ?? defaultRootMargin;
  const key = `${rootId(root)}|${rootMargin}`;

  let entry = observers.get(key);
  if (!entry) {
    const cbs = new Map<Element, (onScreen: boolean) => void>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const fn = cbs.get(e.target);
          if (fn) fn(e.isIntersecting);
        }
      },
      { root, rootMargin },
    );
    entry = { io, cbs, key };
    observers.set(key, entry);
  }
  entry.cbs.set(el, cb);
  owners.set(el, entry);
  entry.io.observe(el);

  return () => {
    const owner = owners.get(el);
    if (!owner) return;
    owners.delete(el);
    owner.cbs.delete(el);
    owner.io.unobserve(el);
    if (owner.cbs.size === 0) {
      owner.io.disconnect();
      observers.delete(owner.key);
    }
  };
}

/** Test-only: disconnect every observer and restore default config. */
export function resetOnScreenObserver(): void {
  for (const entry of observers.values()) entry.io.disconnect();
  observers.clear();
  owners.clear();
  defaultRoot = null;
  defaultRootMargin = "200px";
}
