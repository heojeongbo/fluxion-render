/**
 * `@heojeongbo/fluxion-render/testing` — deterministic signal generators,
 * PRNG utilities, and lifecycle-scheduler helpers for consumer integration tests.
 *
 * Lives in its own sub-path so the production bundle doesn't have to ship
 * test fixtures. Import via:
 *
 *     import { mulberry32, createSineSynth, createLinearRamp }
 *       from "@heojeongbo/fluxion-render/testing";
 */

// Lifecycle-scheduler test helpers. Because `staggerMount` is on by default,
// mounting/unmounting a `<FluxionCanvas>` defers host creation/teardown across
// animation frames — so a test can't observe the host synchronously. These make
// it deterministic: render → `flushMountScheduler()` → assert (wrap in `act()`
// for React state); `resetMountScheduler()` in `afterEach` for isolation.
export {
  configureMountScheduler,
  flushMountScheduler,
  resetMountScheduler,
} from "../shared/lib/lifecycle-scheduler";
export { mulberry32 } from "./signals/mulberry32";
export type { LinearRampOptions, SineSynthOptions } from "./signals/pumps";
export { createLinearRamp, createSineSynth } from "./signals/pumps";
