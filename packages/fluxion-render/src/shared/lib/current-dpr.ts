/**
 * THE devicePixelRatio read.
 *
 * Three spellings had drifted apart across the package — `window.devicePixelRatio
 * || 1` (rejects 0), `typeof devicePixelRatio === "number" ? devicePixelRatio : 1`
 * (does NOT, since 0 is a number), and a raw interpolation into a `matchMedia`
 * query string (no guard at all). They disagree exactly when it matters:
 *
 *  - a `0` reaching `Op.INIT` makes `Engine.resize` allocate a 1x1 backing and
 *    `render2d` apply a degenerate `setTransform(0, 0, 0, 0, 0, 0)`;
 *  - a `0` or `NaN` interpolated into `(resolution: Xdppx)` produces an INVALID
 *    media query, which never matches and never fires `change` — silently
 *    killing DPR-change detection for every chart on the page, since the
 *    watcher is a singleton.
 *
 * Anything non-numeric, non-finite, or non-positive collapses to 1. The
 * `typeof` guard also covers SSR, where `devicePixelRatio` is undefined.
 */
export function currentDpr(): number {
  /* v8 ignore start -- devicePixelRatio is always defined in the DOM test env; SSR fallback */
  const raw = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  /* v8 ignore stop */
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
