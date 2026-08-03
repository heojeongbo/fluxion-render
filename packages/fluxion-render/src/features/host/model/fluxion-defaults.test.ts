import { describe, expect, it } from "vitest";
import {
  configureFluxionDefaults,
  getFluxionDefaults,
  resetFluxionDefaults,
} from "./fluxion-defaults";

// The global afterEach in test/setup.ts calls resetFluxionDefaults(); these
// tests also reset explicitly where they assert the empty baseline.

describe("fluxion-defaults", () => {
  it("starts empty", () => {
    resetFluxionDefaults();
    expect(getFluxionDefaults()).toEqual({});
  });

  it("stores only the provided fields", () => {
    configureFluxionDefaults({ bgColor: "#ffffff", maxFps: 30 });
    expect(getFluxionDefaults()).toEqual({ bgColor: "#ffffff", maxFps: 30 });
  });

  it("accumulates across calls (merges, doesn't replace)", () => {
    configureFluxionDefaults({ bgColor: "#ffffff" });
    configureFluxionDefaults({ maxFps: 30, renderer: "webgl" });
    expect(getFluxionDefaults()).toEqual({
      bgColor: "#ffffff",
      maxFps: 30,
      renderer: "webgl",
    });
    // A later call overrides a previously-set field.
    configureFluxionDefaults({ bgColor: "#000000" });
    expect(getFluxionDefaults().bgColor).toBe("#000000");
  });

  it("getFluxionDefaults returns a copy — mutating it doesn't leak", () => {
    configureFluxionDefaults({ bgColor: "#ffffff" });
    const a = getFluxionDefaults();
    a.bgColor = "#tampered";
    expect(getFluxionDefaults().bgColor).toBe("#ffffff");
  });

  it("resetFluxionDefaults clears everything", () => {
    configureFluxionDefaults({ bgColor: "#ffffff", maxFps: 30 });
    resetFluxionDefaults();
    expect(getFluxionDefaults()).toEqual({});
  });
});
