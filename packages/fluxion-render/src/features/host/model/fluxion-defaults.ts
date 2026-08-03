/**
 * App-wide default host options. Set once at startup with
 * {@link configureFluxionDefaults} and every chart inherits them unless a
 * per-chart `hostOptions` field overrides it — so you don't repeat e.g.
 * `bgColor` on every `<FluxionCanvas>` (and, crucially, the light `bgColor`
 * reaches INIT so the first frame paints the theme, not the opaque-black
 * default). Mirrors the module-level `configure*` convention used elsewhere
 * (`configureDefaultPool`, `configureOnScreenObserver`,
 * `configureLifecycleScheduler`).
 *
 * The merge is `{ ...defaults, ...perChartHostOptions }` (per-chart wins),
 * applied both in the React hook (before the recycle-pool key is computed, so
 * the key reflects the effective options) and in the `FluxionHost` constructor
 * (so non-React `new FluxionHost(...)` users inherit them too). The two merges
 * are idempotent.
 *
 * `pool` is better set via `configureDefaultPool`; setting it here also works
 * but participates in recycle-bucket keying.
 */
import type { FluxionHostOptions } from "./fluxion-host";

let _defaults: Partial<FluxionHostOptions> = {};

/**
 * Merge `partial` into the app-wide default host options (only the fields you
 * provide; call repeatedly to accumulate). Per-chart `hostOptions` still
 * override these. Call once at app startup, before any chart mounts.
 */
export function configureFluxionDefaults(partial: Partial<FluxionHostOptions>): void {
  _defaults = { ..._defaults, ...partial };
}

/** The current app-wide default host options (a copy — safe to read/spread). */
export function getFluxionDefaults(): Partial<FluxionHostOptions> {
  return { ..._defaults };
}

/** Test-only: clear the app-wide defaults back to empty. */
export function resetFluxionDefaults(): void {
  _defaults = {};
}
