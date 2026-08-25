/**
 * Shared ResizeObserver + devicePixelRatio watcher — ONE of each for the whole
 * page, mirroring the flush-scheduler / onscreen-observer singleton pattern.
 *
 * `useResizeObserver` used to create one `ResizeObserver` AND one
 * `matchMedia('(resolution: Xdppx)')` per chart; `devicePixelRatio` is a single
 * global, so N charts installed N identical DPR listeners for no benefit and
 * inflated mount + steady-state cost linearly. Here a single RO dispatches to
 * per-element callbacks, and a single DPR watcher fans out to all subscribers.
 */

import { currentDpr } from "./current-dpr";

export interface ResizeSize {
  width: number;
  height: number;
}

// ── One shared ResizeObserver, keyed by observed element ──
let ro: ResizeObserver | null = null;
const resizeCbs = new Map<Element, (size: ResizeSize) => void>();

/**
 * Observe `el`'s content-box size via the shared observer. `cb` fires with the
 * `contentRect` the browser already computed (no `getBoundingClientRect`, so a
 * burst of mounts can't thrash layout). Returns an unobserve; the observer
 * disconnects when its last element leaves.
 */
export function observeResize(el: Element, cb: (size: ResizeSize) => void): () => void {
  /* v8 ignore start -- no-RO (SSR) env; the DOM test env always defines ResizeObserver */
  if (typeof ResizeObserver === "undefined") return () => {};
  /* v8 ignore stop */
  if (!ro) {
    ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const fn = resizeCbs.get(e.target);
        if (fn) fn({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
  }
  resizeCbs.set(el, cb);
  ro.observe(el);
  return () => {
    if (!resizeCbs.delete(el)) return;
    ro?.unobserve(el);
    if (resizeCbs.size === 0) {
      ro?.disconnect();
      ro = null;
    }
  };
}

// ── One shared DPR watcher (matchMedia on the current resolution) ──
let mql: MediaQueryList | null = null;
const dprCbs = new Set<() => void>();
const onDprEvt = () => {
  for (const cb of dprCbs) cb();
  // The `(resolution: Xdppx)` query is now stale — re-subscribe at the new DPR.
  resubscribeDpr();
};
function resubscribeDpr(): void {
  if (mql) mql.removeEventListener("change", onDprEvt);
  mql = window.matchMedia(`(resolution: ${currentDpr()}dppx)`);
  mql.addEventListener("change", onDprEvt);
}

/** Subscribe to devicePixelRatio changes (shared watcher). Returns unsubscribe. */
export function onDprChange(cb: () => void): () => void {
  /* v8 ignore start -- no-matchMedia (SSR) env; the DOM test env always defines it */
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  /* v8 ignore stop */
  dprCbs.add(cb);
  if (!mql) resubscribeDpr();
  return () => {
    if (!dprCbs.delete(cb)) return;
    if (dprCbs.size === 0 && mql) {
      mql.removeEventListener("change", onDprEvt);
      mql = null;
    }
  };
}

/** Test-only: disconnect the shared observer + DPR watcher and drop subscribers. */
export function resetResizeObserver(): void {
  ro?.disconnect();
  ro = null;
  resizeCbs.clear();
  if (mql) mql.removeEventListener("change", onDprEvt);
  mql = null;
  dprCbs.clear();
}
