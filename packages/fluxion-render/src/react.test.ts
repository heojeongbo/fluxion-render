import { describe, expect, it } from "vitest";
import * as react from "./react";

// Regression guard: the `/react` entry re-exports the widgets barrel with an
// EXPLICIT named list, which has silently drifted before (a documented knob
// existed in the barrel but wasn't re-exported → a type-error to import). Assert
// the documented app-init `configure*` knobs are reachable from the public entry.
describe("@heojeongbo/fluxion-render/react public entry", () => {
  it("exports the documented configure* startup functions", () => {
    for (const name of [
      "configureDefaultPool",
      "configureLifecycleScheduler",
      "configureOnScreenObserver",
      "configureFluxionDefaults",
    ] as const) {
      expect(typeof react[name]).toBe("function");
    }
  });
});
