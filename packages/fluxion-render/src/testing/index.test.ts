import { describe, expect, it } from "vitest";
import * as testing from "./index";

describe("/testing barrel", () => {
  it("re-exports the public signal + lifecycle-scheduler helpers", () => {
    // Signal generators
    expect(typeof testing.mulberry32).toBe("function");
    expect(typeof testing.createSineSynth).toBe("function");
    expect(typeof testing.createLinearRamp).toBe("function");
    // Lifecycle-scheduler test helpers (deterministic mount/unmount)
    expect(typeof testing.flushLifecycleScheduler).toBe("function");
    expect(typeof testing.resetLifecycleScheduler).toBe("function");
    expect(typeof testing.configureLifecycleScheduler).toBe("function");
  });
});
