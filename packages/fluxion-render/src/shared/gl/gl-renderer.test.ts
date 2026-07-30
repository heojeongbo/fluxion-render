import { afterEach, describe, expect, it, vi } from "vitest";
import type { CtxCall, FakeGl } from "../../test/setup";
import { resetParseColorCache } from "../lib/parse-color";
import { Viewport } from "../model/viewport";
import { GlRenderer } from "./gl-renderer";

function newGlCanvas(w = 200, h = 100) {
  // biome-ignore lint: using global stub
  const canvas = new (globalThis as any).OffscreenCanvas(w, h);
  return canvas as OffscreenCanvas & {
    getContext(type: string): FakeGl;
    dispatchEvent(evt: { type: string; preventDefault?: () => void }): boolean;
  };
}

function names(calls: CtxCall[]): string[] {
  return calls.map((c) => c.name);
}

describe("GlRenderer", () => {
  afterEach(() => {
    resetParseColorCache();
  });

  it("beginFrame sizes the viewport, clears premultiplied bg, and sets the frame blend state", () => {
    const canvas = newGlCanvas(200, 100);
    const glr = GlRenderer.tryCreate(canvas, { alpha: false }, () => {})!;
    expect(glr).not.toBeNull();
    const gl = canvas.getContext("webgl");

    expect(glr.beginFrame("rgba(255, 0, 0, 0.5)")).toBe(true);
    const seq = names(gl.calls);
    expect(seq).toEqual([
      "viewport",
      "disable",
      "clearColor",
      "clear",
      "enable",
      "blendFunc",
    ]);
    expect(gl.calls[0]!.args).toEqual([0, 0, 200, 100]);
    // Premultiplied: (1*0.5, 0, 0, 0.5).
    expect(gl.calls[2]!.args).toEqual([0.5, 0, 0, 0.5]);
    expect(gl.calls[4]!.args).toEqual([gl.BLEND]);
    expect(gl.calls[5]!.args).toEqual([gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);
  });

  it("falls back to opaque white for unparseable colors, warning once per string", () => {
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = newGlCanvas();
    const glr = GlRenderer.tryCreate(canvas, { alpha: false }, () => {})!;
    const gl = canvas.getContext("webgl");

    glr.beginFrame("tomato");
    glr.beginFrame("tomato");
    const clears = gl.calls.filter((c) => c.name === "clearColor");
    expect(clears[0]!.args).toEqual([1, 1, 1, 1]);
    expect(errSpy).toHaveBeenCalledTimes(1); // warn-once per string
    errSpy.mockRestore();
  });

  it("scissors the plot rect in device px with a bottom-left origin", () => {
    const canvas = newGlCanvas(400, 260);
    const glr = GlRenderer.tryCreate(canvas, { alpha: false }, () => {})!;
    const gl = canvas.getContext("webgl");

    const v = new Viewport();
    v.setSize(200, 130, 2);
    v.insetLeft = 60;
    v.insetBottom = 30;
    glr.scissorPlotRect(v);
    expect(gl.calls.at(-1)!.args).toEqual([120, 60, 280, 200]); // ×dpr, y = insetBottom
    expect(gl.calls.at(-2)!.args).toEqual([gl.SCISSOR_TEST]); // enable

    glr.scissorOff();
    expect(gl.calls.at(-1)).toEqual({ name: "disable", args: [gl.SCISSOR_TEST] });
  });

  it("suspends on context lost and resumes (with onRestored) after restore", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onRestored = vi.fn();
    const canvas = newGlCanvas();
    const glr = GlRenderer.tryCreate(canvas, { alpha: false }, onRestored)!;
    const gl = canvas.getContext("webgl");

    const preventDefault = vi.fn();
    canvas.dispatchEvent({ type: "webglcontextlost", preventDefault });
    expect(preventDefault).toHaveBeenCalled(); // required to allow restore
    expect(glr.isLost).toBe(true);
    const before = gl.calls.length;
    expect(glr.beginFrame("#000")).toBe(false); // whole frame skipped
    expect(gl.calls.length).toBe(before);

    canvas.dispatchEvent({ type: "webglcontextrestored" });
    expect(glr.isLost).toBe(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(glr.beginFrame("#000")).toBe(true);
    warnSpy.mockRestore();
  });

  it("dispose releases the context and detaches the loss listeners", () => {
    const onRestored = vi.fn();
    const canvas = newGlCanvas();
    const glr = GlRenderer.tryCreate(canvas, { alpha: false }, onRestored)!;
    const gl = canvas.getContext("webgl");

    glr.dispose();
    expect(gl.calls.some((c) => c.name === "getExtension")).toBe(true);
    expect(gl.calls.some((c) => c.name === "loseContext")).toBe(true);
    canvas.dispatchEvent({ type: "webglcontextrestored" });
    expect(onRestored).not.toHaveBeenCalled(); // listener removed
  });

  it("tryCreate returns null when the context is unavailable or throws", () => {
    const nullCanvas = {
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as OffscreenCanvas;
    expect(GlRenderer.tryCreate(nullCanvas, { alpha: false }, () => {})).toBeNull();

    const throwingCanvas = {
      getContext() {
        throw new Error("no gl");
      },
    } as unknown as OffscreenCanvas;
    expect(GlRenderer.tryCreate(throwingCanvas, { alpha: false }, () => {})).toBeNull();
  });

  it("requests the documented context attributes (alpha follows `transparent`)", () => {
    const canvas = newGlCanvas();
    GlRenderer.tryCreate(canvas, { alpha: true }, () => {});
    expect(
      (canvas as unknown as { contextOptions: { alpha: boolean; antialias: boolean } })
        .contextOptions,
    ).toMatchObject({
      alpha: true,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
  });
});
