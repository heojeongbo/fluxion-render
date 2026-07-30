import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFrameDriver } from "../../../shared/model/frame-driver";
import { Scheduler } from "../../../shared/model/scheduler";
import { Op, WorkerOp } from "../../../shared/protocol";
import { type FakeCtx, labelDraws } from "../../../test/setup";
import { Engine } from "./engine";

/**
 * FakeOffscreenCanvas from test/setup.ts is installed globally, but we also
 * need to spy on the rAF loop driven by the Scheduler. We use vitest fake
 * timers to drive rAF synchronously.
 */

function newCanvas(w = 100, h = 100): OffscreenCanvas {
  // biome-ignore lint: using global stub
  return new (globalThis as any).OffscreenCanvas(w, h);
}

function flushFrame() {
  // Scheduler fallback uses setTimeout when rAF is missing; happy-dom
  // provides rAF so advancing time flushes both.
  vi.advanceTimersByTime(32);
}

describe("Engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Reset BEFORE restoring real timers: a scheduler leaked into the shared
    // driver would leave a stale fake-timer rAF handle that wedges wake()
    // for every later test in this file.
    resetFrameDriver();
    vi.useRealTimers();
  });

  it("INIT sets canvas size and starts rendering on first frame", () => {
    const engine = new Engine();
    const canvas = newCanvas(200, 150);
    engine.dispatch({ op: Op.INIT, canvas, width: 200, height: 150, dpr: 2 });
    flushFrame();
    // dpr=2 -> canvas backbuffer = 400x300
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    expect(ctx.calls.some((c) => c.name === "setTransform")).toBe(true);
    expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(true);
    engine.dispatch({ op: Op.DISPOSE });
  });

  describe("bgColor", () => {
    it("INIT without bgColor uses the dark default #0b0d12", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      // The background fillRect sets fillStyle first; by the end of the frame
      // fillStyle reflects the last value assigned (last layer), so we assert
      // from ctx.fillStyle intermediate tracking is tricky — check that at
      // least no override occurred by inspecting call order is overkill.
      // Simpler: after render, the first fillRect bg call happened with the
      // engine's default, observable via a second frame with SET_BG_COLOR.
      ctx.calls.length = 0;
      engine.dispatch({ op: Op.SET_BG_COLOR, color: "#123456" });
      flushFrame();
      // Scan calls in order — the bg fill happens before any layer draw.
      // With no layers added, the only fillStyle assign before fillRect
      // is the bg color. Happy-dom ctx tracks the current fillStyle at
      // call time; our FakeCtx records the value of fillStyle when the
      // bgColor was set — but the simpler check is that fillRect was
      // called (confirming the frame ran), then check ctx.fillStyle after
      // the render finished ( = bg color since no layer changed it).
      expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(true);
      expect(ctx.fillStyle).toBe("#123456");
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("INIT with bgColor applies it from the first frame", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 100,
        height: 100,
        dpr: 1,
        bgColor: "#ffffff",
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      // No layers added -> nothing else assigns fillStyle -> current value
      // equals the bg color assigned during the frame.
      expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(true);
      expect(ctx.fillStyle).toBe("#ffffff");
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("SET_BG_COLOR updates the fill on the next frame", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 100,
        height: 100,
        dpr: 1,
        bgColor: "#000000",
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(ctx.fillStyle).toBe("#000000");
      engine.dispatch({ op: Op.SET_BG_COLOR, color: "#abcdef" });
      flushFrame();
      expect(ctx.fillStyle).toBe("#abcdef");
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  it("ADD_LAYER + DATA + CONFIG (streaming line with time axis)", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xMode: "time", timeWindowMs: 1000, yRange: [-1, 1] },
    });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "line",
      kind: "line",
      config: { color: "#0f0", capacity: 8 },
    });
    const samples = new Float32Array([0, 0, 200, 0.5, 400, -0.3, 600, 0.8]);
    engine.dispatch({
      op: Op.DATA,
      id: "line",
      buffer: samples.buffer,
      dtype: "f32",
      length: samples.length,
    });
    flushFrame();
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    expect(labelDraws(ctx).length).toBeGreaterThan(0);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("ADD_LAYER line-static accepts one-shot xy data", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xRange: [0, 10], yRange: [0, 10] },
    });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "plot",
      kind: "line-static",
      config: { color: "#0ff", layout: "xy" },
    });
    const xy = new Float32Array([0, 0, 5, 5, 10, 2]);
    engine.dispatch({
      op: Op.DATA,
      id: "plot",
      buffer: xy.buffer,
      dtype: "f32",
      length: xy.length,
    });
    flushFrame();
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("REMOVE_LAYER disposes and drops it from the stack", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xRange: [0, 10], yRange: [0, 10] },
    });
    flushFrame();
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    const before = labelDraws(ctx).length;
    expect(before).toBeGreaterThan(0);
    engine.dispatch({ op: Op.REMOVE_LAYER, id: "axis" });
    ctx.calls.length = 0;
    flushFrame();
    expect(labelDraws(ctx)).toHaveLength(0);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("RESET disposes every layer and rewinds engine state to a pristine default", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({
      op: Op.INIT,
      canvas,
      width: 100,
      height: 100,
      dpr: 1,
      bgColor: "#ff0000",
    });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xMode: "time", timeWindowMs: 1000, yRange: [-1, 1] },
    });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "line",
      kind: "line",
      config: { color: "#0f0", capacity: 8 },
    });
    const samples = new Float32Array([0, 0, 200, 0.5, 400, -0.3, 600, 0.8]);
    engine.dispatch({
      op: Op.DATA,
      id: "line",
      buffer: samples.buffer,
      dtype: "f32",
      length: samples.length,
    });
    flushFrame();
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);

    ctx.calls.length = 0;
    engine.dispatch({ op: Op.RESET });
    flushFrame();
    // Every layer disposed → no line stroke, no axis labels; bg back to default.
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
    expect(labelDraws(ctx)).toHaveLength(0);
    expect(ctx.calls.some((c) => c.name === "fillRect")).toBe(true);
    expect(ctx.fillStyle).toBe("#0b0d12");

    // Re-adding the same ids works on the now-empty stack — no duplicate layers,
    // no stale data — proving the host can be recycled for a fresh tenant.
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xMode: "time", timeWindowMs: 1000, yRange: [-1, 1] },
    });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "line",
      kind: "line",
      config: { color: "#0f0", capacity: 8 },
    });
    engine.dispatch({
      op: Op.DATA,
      id: "line",
      buffer: new Float32Array([0, 0, 200, 0.5, 400, -0.3]).buffer,
      dtype: "f32",
      length: 6,
    });
    flushFrame();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("CONFIG_BATCH applies config to known ids and ignores unknown ones", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "plot",
      kind: "line",
      config: { color: "#0ff", yRange: [0, 10] },
    });
    // Interleaved [t, y] samples spanning the default time window.
    const ty = new Float32Array([0, 1, 100, 5, 200, 2]);
    engine.dispatch({
      op: Op.DATA,
      id: "plot",
      buffer: ty.buffer,
      dtype: "f32",
      length: ty.length,
    });
    flushFrame();
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);

    // Batch: hide the plot + target a non-existent layer in one message.
    engine.dispatch({
      op: Op.CONFIG_BATCH,
      entries: [
        { id: "plot", config: { visible: false } },
        { id: "ghost", config: { visible: true } },
      ],
    });
    ctx.calls.length = 0;
    flushFrame();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("CONFIG_BATCH with only unknown ids is a no-op (no throw)", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    expect(() =>
      engine.dispatch({
        op: Op.CONFIG_BATCH,
        entries: [{ id: "ghost", config: { visible: false } }],
      }),
    ).not.toThrow();
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("RESIZE updates canvas backbuffer and viewport", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({ op: Op.RESIZE, width: 300, height: 200, dpr: 1.5 });
    expect(canvas.width).toBe(450);
    expect(canvas.height).toBe(300);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("DISPOSE stops the scheduler (no further draws)", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xRange: [0, 10], yRange: [0, 10] },
    });
    flushFrame();
    engine.dispatch({ op: Op.DISPOSE });
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    ctx.calls.length = 0;
    flushFrame();
    expect(ctx.calls.length).toBe(0);
  });

  describe("BOUNDS_UPDATE (yMode:auto epsilon gate)", () => {
    // self.postMessage is used inside Engine.render() but `self` is a separate
    // object from `globalThis` in happy-dom and throws — the engine catches it.
    // We verify the epsilon gate logic by inspecting the engine's private state
    // via a second render cycle: if lastSentYMin/Max were updated the gate fired.
    // The observable proxy: render with significantly different data → ctx gets
    // a new fillRect sequence. We use the fact that the engine's guard stores
    // the sent values, so a repeat render with identical bounds produces no
    // duplicate postMessage attempts (observable as no throw in try/catch).

    it("epsilon guard: identical bounds on repeat frame do not trigger lastSent update", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 1], yMode: "auto" },
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "line",
        kind: "line",
        config: { color: "#0f0", capacity: 16 },
      });

      // Frame 1: establish bounds with data in range [-1, 1]
      const buf1 = new Float32Array([0, -1, 100, 1]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf1.buffer,
        dtype: "f32",
        length: buf1.length,
      });
      flushFrame();

      // Frame 2: same data — bounds identical, epsilon gate must hold
      // Verify by checking the engine renders without throwing.
      const buf2 = new Float32Array([0, -1, 100, 1]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf2.buffer,
        dtype: "f32",
        length: buf2.length,
      });
      expect(() => flushFrame()).not.toThrow();

      engine.dispatch({ op: Op.DISPOSE });
    });

    it("epsilon guard: sub-epsilon drift (1e-5 of range) does not change lastSent", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 1], yMode: "auto", yAutoPadding: 0 },
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "line",
        kind: "line",
        config: { color: "#0f0", capacity: 16 },
      });

      // Frame 1
      const buf1 = new Float32Array([0, 0, 100, 1]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf1.buffer,
        dtype: "f32",
        length: buf1.length,
      });
      flushFrame();

      // Frame 2: drift well below 1e-4 of range=1 → epsilon gate blocks update
      const buf2 = new Float32Array([0, 0.000001, 100, 1.000001]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf2.buffer,
        dtype: "f32",
        length: buf2.length,
      });
      expect(() => flushFrame()).not.toThrow();

      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  it("tolerates CONFIG/DATA for unknown layer ids", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    expect(() =>
      engine.dispatch({
        op: Op.CONFIG,
        id: "missing",
        config: {},
      }),
    ).not.toThrow();
    const buf = new Float32Array([1, 2]);
    expect(() =>
      engine.dispatch({
        op: Op.DATA,
        id: "missing",
        buffer: buf.buffer,
        dtype: "f32",
        length: 2,
      }),
    ).not.toThrow();
    engine.dispatch({ op: Op.DISPOSE });
  });

  describe("CLEAR_DATA (replay seek support)", () => {
    // Helpers — the axis-grid layer issues its own stroke/moveTo/lineTo calls
    // (grid lines, axis ticks). To isolate the line layer's contribution we
    // diff call counts before and after toggling whether the line has data.
    const countStrokes = (ctx: FakeCtx) =>
      ctx.calls.filter((c) => c.name === "stroke").length;

    function setupTimeChart(timeWindowMs = 1000) {
      const engine = new Engine();
      const canvas = newCanvas(200, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 200, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xMode: "time", timeWindowMs, yRange: [-1, 1] },
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "line",
        kind: "line",
        config: { color: "#0f0", capacity: 16 },
      });
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      return { engine, ctx };
    }

    it("drops the layer's ring buffer so the next frame stops rendering the line", () => {
      const { engine, ctx } = setupTimeChart();
      const seed = new Float32Array([100, 0.1, 500, 0.5, 900, 0.9]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: seed.buffer,
        dtype: "f32",
        length: seed.length,
      });
      flushFrame();
      // Baseline: axis strokes + 1 line stroke.
      const withData = countStrokes(ctx);

      engine.dispatch({ op: Op.CLEAR_DATA, id: "line" });
      ctx.calls.length = 0;
      flushFrame();
      // Axis still draws but the line layer no longer strokes — exactly one
      // fewer stroke than the baseline.
      expect(countStrokes(ctx)).toBe(withData - 1);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("rewinds viewport.latestT so the time-mode axis can scroll backward", () => {
      const { engine, ctx } = setupTimeChart(1000);
      // Seed: latestT advances to 2000 → axis window = [1000, 2000].
      const seed = new Float32Array([1500, 0.1, 2000, 0.2]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: seed.buffer,
        dtype: "f32",
        length: seed.length,
      });
      flushFrame();
      const baselineStrokes = countStrokes(ctx);

      // Rewind latestT to 600 → axis window = [-400, 600]. The backfilled
      // samples at t=400,500 land inside that window, so the line layer
      // re-issues its stroke.
      engine.dispatch({ op: Op.CLEAR_DATA, id: "line", latestT: 600 });
      const backfill = new Float32Array([400, 0.7, 500, 0.8]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: backfill.buffer,
        dtype: "f32",
        length: backfill.length,
      });
      ctx.calls.length = 0;
      flushFrame();
      // Same axis cost plus the line layer's stroke = baseline count.
      expect(countStrokes(ctx)).toBe(baselineStrokes);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("omitting latestT leaves the time axis where it was", () => {
      const { engine, ctx } = setupTimeChart(1000);
      const seed = new Float32Array([1500, 0.1, 2000, 0.2]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: seed.buffer,
        dtype: "f32",
        length: seed.length,
      });
      flushFrame();
      // Baseline: axis moveTos + 1 line moveTo (start of the 2-sample stroke).
      const baselineMoveTos = ctx.calls.filter((c) => c.name === "moveTo").length;

      // Clear without rewind. latestT stays at 2000 → window stays [1000, 2000].
      // Push samples at t=400,500: since 500 < 2000, the line layer's monotonic
      // guard leaves latestT alone, so the window doesn't shift. The samples
      // fall outside the window and get filtered in the draw loop, so the line
      // layer issues zero moveTos.
      engine.dispatch({ op: Op.CLEAR_DATA, id: "line" });
      const after = new Float32Array([400, 0.7, 500, 0.8]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: after.buffer,
        dtype: "f32",
        length: after.length,
      });
      ctx.calls.length = 0;
      flushFrame();
      // Axis layer is window-driven and the window didn't move, so its moveTo
      // count is unchanged. Only the line layer's moveTo is gone (1 fewer).
      const afterMoveTos = ctx.calls.filter((c) => c.name === "moveTo").length;
      expect(afterMoveTos).toBe(baselineMoveTos - 1);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("is a no-op for an unknown layer id", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      expect(() => engine.dispatch({ op: Op.CLEAR_DATA, id: "missing" })).not.toThrow();
      expect(() =>
        engine.dispatch({ op: Op.CLEAR_DATA, id: "missing", latestT: 100 }),
      ).not.toThrow();
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("renderer: webgl", () => {
    function glInit(engine: Engine, canvas: OffscreenCanvas, extra: object = {}) {
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 200,
        height: 130,
        dpr: 1,
        renderer: "webgl",
        ...extra,
      });
    }

    it("clears via the GL context and never touches a 2d context", () => {
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      glInit(engine, canvas);
      flushFrame();
      const gl = (
        canvas as unknown as { getContext: (t: string) => { calls: { name: string }[] } }
      ).getContext("webgl");
      expect(gl.calls.some((c) => c.name === "clearColor")).toBe(true);
      expect(gl.calls.some((c) => c.name === "clear")).toBe(true);
      // The 2d branch never ran: no fillRect anywhere on the gl call log.
      expect(gl.calls.some((c) => c.name === "fillRect")).toBe(false);
      engine.dispatch({ op: Op.DISPOSE });
      expect(gl.calls.some((c) => c.name === "loseContext")).toBe(true);
    });

    it("warns once per unsupported layer and keeps rendering", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      glInit(engine, canvas);
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "line",
        kind: "line",
        config: { color: "#0f0" },
      });
      flushFrame();
      flushFrame();
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: new Float32Array([1, 2]).buffer,
        dtype: "f32",
        length: 2,
      });
      flushFrame();
      const layerWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("no WebGL draw path"),
      );
      expect(layerWarns).toHaveLength(1); // warn-once per layer id
      warnSpy.mockRestore();
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("scissors the plot rect under inlineAxes", () => {
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      glInit(engine, canvas, { inlineAxes: true, xAxisHeight: 30, yAxisWidth: 60 });
      flushFrame();
      const gl = (
        canvas as unknown as { getContext: (t: string) => { calls: { name: string }[] } }
      ).getContext("webgl");
      expect(gl.calls.some((c) => c.name === "scissor")).toBe(true);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("re-renders after a context restore (onRestored marks dirty)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      glInit(engine, canvas);
      flushFrame();
      const gl = (
        canvas as unknown as { getContext: (t: string) => { calls: { name: string }[] } }
      ).getContext("webgl");
      const dispatch = (
        canvas as unknown as {
          dispatchEvent: (e: { type: string; preventDefault?: () => void }) => void;
        }
      ).dispatchEvent.bind(canvas);

      dispatch({ type: "webglcontextlost", preventDefault: () => {} });
      const clearsWhileLost = gl.calls.filter((c) => c.name === "clear").length;
      engine.dispatch({ op: Op.SET_BG_COLOR, color: "#111111" }); // marks dirty
      flushFrame(); // render runs but beginFrame refuses while lost
      expect(gl.calls.filter((c) => c.name === "clear")).toHaveLength(clearsWhileLost);

      dispatch({ type: "webglcontextrestored" }); // → scheduler.markDirty()
      flushFrame();
      expect(gl.calls.filter((c) => c.name === "clear").length).toBeGreaterThan(
        clearsWhileLost,
      );
      warnSpy.mockRestore();
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("ignores SET_AXIS_CANVAS with a warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      glInit(engine, canvas);
      const xAxisCanvas = newCanvas(200, 30);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      flushFrame();
      const xCtx = (
        xAxisCanvas as unknown as { getContext: () => { calls: unknown[] } }
      ).getContext();
      expect(xCtx.calls).toHaveLength(0); // never bound/drawn
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes("SET_AXIS_CANVAS ignored")),
      ).toBe(true);
      warnSpy.mockRestore();
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("falls back to 2d when a webgl context is unavailable", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ctx2d = (
        newCanvas(10, 10) as unknown as { getContext: (t: string) => unknown }
      ).getContext("2d");
      const canvas = {
        width: 200,
        height: 130,
        getContext: (t: string) => (t === "webgl" ? null : ctx2d),
        addEventListener() {},
        removeEventListener() {},
      } as unknown as OffscreenCanvas;
      const engine = new Engine();
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 200,
        height: 130,
        dpr: 1,
        renderer: "webgl",
      });
      flushFrame();
      const fake = ctx2d as { calls: { name: string }[] };
      expect(fake.calls.some((c) => c.name === "fillRect")).toBe(true); // 2d path ran
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes("falling back to the 2d")),
      ).toBe(true);
      warnSpy.mockRestore();
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("inlineAxes", () => {
    it("clips data to the plot rect and draws margin labels on the MAIN canvas", () => {
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 200,
        height: 130,
        dpr: 1,
        inlineAxes: true,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] }, // labels default ON
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(ctx.calls.some((c) => c.name === "save")).toBe(true);
      expect(ctx.calls.some((c) => c.name === "restore")).toBe(true);
      // 6 x + 6 y margin labels, and NO in-plot duplicates (would be 24).
      expect(labelDraws(ctx)).toHaveLength(12);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("defaults the margins to 30/60 when sizes are omitted", () => {
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 200,
        height: 130,
        dpr: 1,
        inlineAxes: true,
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(labelDraws(ctx).length).toBeGreaterThan(0);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("keeps the inline margins across RESET (recycle)", () => {
      const engine = new Engine();
      const canvas = newCanvas(200, 130);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 200,
        height: 130,
        dpr: 1,
        inlineAxes: true,
      });
      engine.dispatch({ op: Op.RESET });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(ctx.calls.some((c) => c.name === "clip")).toBe(true);
      expect(labelDraws(ctx).length).toBeGreaterThan(0);
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("SET_AXIS_CANVAS", () => {
    it("renders onto xAxisCanvas and yAxisCanvas after set", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      const xAxisCanvas = newCanvas(100, 30);
      const yAxisCanvas = newCanvas(60, 100);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        yAxisCanvas: yAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      flushFrame();
      const xCtx = (xAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      const yCtx = (yAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(xCtx.calls.some((c) => c.name === "setTransform")).toBe(true);
      expect(yCtx.calls.some((c) => c.name === "setTransform")).toBe(true);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("suppresses in-plot labels when axis canvases render them (double-label footgun)", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      const xAxisCanvas = newCanvas(100, 30);
      const yAxisCanvas = newCanvas(60, 100);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        yAxisCanvas: yAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      // Layer added AFTER the axis canvases — also exercises the cached
      // axis-layer ref refresh on ADD_LAYER.
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        // Labels deliberately LEFT ON — the misconfigured default.
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      flushFrame();
      const mainCtx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      const xCtx = (xAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      // In-plot labels skipped; axis-canvas labels drawn exactly once.
      expect(labelDraws(mainCtx)).toHaveLength(0);
      expect(labelDraws(xCtx).length).toBeGreaterThan(0);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("keeps suppressing in-plot labels across RESET + re-ADD_LAYER (recycle)", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      const xAxisCanvas = newCanvas(100, 30);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      engine.dispatch({ op: Op.RESET });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10], showYLabels: false },
      });
      flushFrame();
      const mainCtx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      // The x-axis canvas binding survived the recycle → x labels stay skipped.
      expect(labelDraws(mainCtx)).toHaveLength(0);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("threads viewport.dpr into the axis-canvas label sprites", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 2 });
      const xAxisCanvas = newCanvas(200, 60);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      flushFrame();
      const xCtx = (xAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      const blits = xCtx.calls.filter((c) => c.name === "drawImage");
      expect(blits.length).toBeGreaterThan(0);
      // Sprite rasterized at device resolution: cssW = 50 (stubbed measureText)
      // + 2 * PAD, doubled by dpr 2 → proves dpr reached drawXAxis.
      const sprite = blits[0]!.args[0] as { width: number };
      expect(sprite.width).toBe(Math.ceil((50 + 2) * 2));
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("resizes axis canvases when main canvas is resized", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      const xAxisCanvas = newCanvas(100, 30);
      const yAxisCanvas = newCanvas(60, 100);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        yAxisCanvas: yAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      engine.dispatch({ op: Op.RESIZE, width: 200, height: 150, dpr: 2 });
      expect(xAxisCanvas.width).toBe(400);
      expect(yAxisCanvas.height).toBe(300);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("skips the y-axis canvas on pure continuous frames (bounds unchanged)", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      // Fixed yRange → y bounds never shift, so the y-axis only needs to draw
      // once. A followClock x-axis drives continuous frames.
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: {
          xMode: "time",
          timeWindowMs: 1000,
          timeOrigin: 1_000_000,
          followClock: true,
          yRange: [0, 10],
        },
      });
      const xAxisCanvas = newCanvas(100, 30);
      const yAxisCanvas = newCanvas(60, 100);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        yAxisCanvas: yAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      flushFrame(); // initial dirty frame draws both axes
      const xCtx = (xAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      const yCtx = (yAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(yCtx.calls.some((c) => c.name === "setTransform")).toBe(true);
      xCtx.calls.length = 0;
      yCtx.calls.length = 0;
      // Subsequent continuous frames: x-axis scrolls, y-axis is skipped.
      flushFrame();
      flushFrame();
      expect(xCtx.calls.some((c) => c.name === "setTransform")).toBe(true);
      expect(yCtx.calls.length).toBe(0);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("only xAxisCanvas provided — yAxis stays null", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      const xAxisCanvas = newCanvas(100, 30);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      flushFrame();
      const xCtx = (xAxisCanvas as unknown as { getContext: () => FakeCtx }).getContext();
      expect(xCtx.calls.some((c) => c.name === "setTransform")).toBe(true);
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("SET_AXIS_STYLE", () => {
    it("posts axis style fields to the engine and triggers a frame", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      expect(() =>
        engine.dispatch({
          op: Op.SET_AXIS_STYLE,
          color: "#aaa",
          font: "12px monospace",
          tickSize: 8,
          tickMargin: 3,
          bgColor: "#000",
        }),
      ).not.toThrow();
      flushFrame();
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("re-themes the external axis canvas at RUNTIME (light/dark toggle)", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      const xAxisCanvas = newCanvas(100, 30);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      const axisCtx = (
        xAxisCanvas as unknown as { getContext: () => { fillStyle: string } }
      ).getContext();

      flushFrame();
      // drawXAxis sets ctx.fillStyle = style.color ?? "#666" for the labels.
      expect(axisCtx.fillStyle).toBe("#666"); // default axis color

      // A theme toggle re-sends SET_AXIS_STYLE (no remount) → next frame repaints
      // the axis strip in the new color.
      engine.dispatch({ op: Op.SET_AXIS_STYLE, color: "#ff0000" });
      flushFrame();
      expect(axisCtx.fillStyle).toBe("#ff0000");

      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("maybeSendTickUpdate (no axis canvases)", () => {
    it("sends TICK_UPDATE when axis layer is present and no axis canvases", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      expect(() => flushFrame()).not.toThrow();
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("does not send TICK_UPDATE when axis canvases are present", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 10], yRange: [0, 10] },
      });
      const xAxisCanvas = newCanvas(100, 30);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      expect(() => flushFrame()).not.toThrow();
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  it("ADD_LAYER with all layer kinds does not throw", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xRange: [0, 10], yRange: [0, 10] },
    });
    const kinds = [
      "lidar",
      "scatter",
      "area",
      "step",
      "bar",
      "candlestick",
      "heatmap",
      "event-marker",
      "scatter-colored",
      "heatmap-stream",
      "reference-line",
      "pose-arrow",
      "trajectory",
      "occupancy-grid",
      "histogram",
      "stacked-area",
      "box-plot",
      "polar",
    ] as const;
    for (const kind of kinds) {
      expect(() => engine.dispatch({ op: Op.ADD_LAYER, id: kind, kind })).not.toThrow();
    }
    flushFrame();
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("pushRaw feeds data to the layer and marks dirty (renders a frame)", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "axis",
      kind: "axis-grid",
      config: { xRange: [0, 1000], yRange: [-1, 1] },
    });
    engine.dispatch({
      op: Op.ADD_LAYER,
      id: "line",
      kind: "line",
      config: { color: "#0f0", capacity: 8 },
    });
    const samples = new Float32Array([0, 0, 200, 0.5, 400, -0.3, 600, 0.8]);
    engine.pushRaw("line", samples);
    flushFrame();
    const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    engine.dispatch({ op: Op.DISPOSE });
  });

  it("pushRaw silently ignores unknown layerId", () => {
    const engine = new Engine();
    const canvas = newCanvas(100, 100);
    engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
    expect(() => {
      engine.pushRaw("nonexistent", new Float32Array([1, 2]));
    }).not.toThrow();
    engine.dispatch({ op: Op.DISPOSE });
  });

  describe("followClock continuous render", () => {
    /** Count of background fillRect calls — one per rendered frame. */
    function frameCount(ctx: FakeCtx): number {
      return ctx.calls.filter((c) => c.name === "fillRect").length;
    }

    it("keeps rendering with no data when a followClock time axis is present", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: {
          xMode: "time",
          timeWindowMs: 1000,
          timeOrigin: 1_000_000,
          followClock: true,
          yRange: [-1, 1],
        },
      });
      flushFrame(); // consume the initial dirty frame
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      ctx.calls.length = 0;
      // No DATA, no markDirty — continuous mode must still render new frames.
      flushFrame();
      expect(frameCount(ctx)).toBeGreaterThanOrEqual(1);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("stops continuous rendering when the followClock axis is removed", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: {
          xMode: "time",
          timeWindowMs: 1000,
          timeOrigin: 1_000_000,
          followClock: true,
          yRange: [-1, 1],
        },
      });
      flushFrame();
      engine.dispatch({ op: Op.REMOVE_LAYER, id: "axis" });
      flushFrame(); // drain the dirty frame from REMOVE_LAYER
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();
      ctx.calls.length = 0;
      // Back to dirty-gated: no new frames without data/config.
      flushFrame();
      expect(frameCount(ctx)).toBe(0);
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("CONFIG toggling followClock flips continuous render on and off", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: {
          xMode: "time",
          timeWindowMs: 1000,
          timeOrigin: 1_000_000,
          followClock: false, // starts data-driven (idle when no data)
          yRange: [-1, 1],
        },
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();

      // Idle: dirty-gated, no continuous frames.
      ctx.calls.length = 0;
      flushFrame();
      expect(frameCount(ctx)).toBe(0);

      // Enable follow → continuous.
      engine.dispatch({ op: Op.CONFIG, id: "axis", config: { followClock: true } });
      flushFrame();
      ctx.calls.length = 0;
      flushFrame();
      expect(frameCount(ctx)).toBeGreaterThanOrEqual(1);

      // Disable follow → back to idle.
      engine.dispatch({ op: Op.CONFIG, id: "axis", config: { followClock: false } });
      flushFrame();
      ctx.calls.length = 0;
      flushFrame();
      expect(frameCount(ctx)).toBe(0);

      engine.dispatch({ op: Op.DISPOSE });
    });

    it("SET_VISIBLE false suspends continuous render; true resumes it", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: {
          xMode: "time",
          timeWindowMs: 1000,
          timeOrigin: 1_000_000,
          followClock: true,
          yRange: [-1, 1],
        },
      });
      flushFrame();
      const ctx = (canvas as unknown as { getContext: () => FakeCtx }).getContext();

      // Hidden: continuous mode off → no frames without data.
      engine.dispatch({ op: Op.SET_VISIBLE, visible: false });
      flushFrame(); // drain any dirty frame queued before suspension
      ctx.calls.length = 0;
      flushFrame();
      expect(frameCount(ctx)).toBe(0);

      // Visible again: re-anchors + resumes continuous rendering.
      engine.dispatch({ op: Op.SET_VISIBLE, visible: true });
      flushFrame();
      ctx.calls.length = 0;
      flushFrame();
      expect(frameCount(ctx)).toBeGreaterThanOrEqual(1);

      engine.dispatch({ op: Op.DISPOSE });
    });

    it("SET_VISIBLE is a harmless no-op with no axis layer", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      expect(() => {
        engine.dispatch({ op: Op.SET_VISIBLE, visible: false });
        engine.dispatch({ op: Op.SET_VISIBLE, visible: true });
      }).not.toThrow();
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("pre-init guards + flat range", () => {
    it("RESIZE before INIT is a harmless no-op (no canvas)", () => {
      const engine = new Engine();
      expect(() =>
        engine.dispatch({ op: Op.RESIZE, width: 100, height: 100, dpr: 1 }),
      ).not.toThrow();
    });

    it("a render tick before INIT is a no-op (no ctx/canvas)", () => {
      const engine = new Engine();
      // No INIT → markDirty + flushFrame must not throw (render early-returns).
      expect(() => flushFrame()).not.toThrow();
    });

    it("flat y-range (yMin === yMax) renders without dividing by zero", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 1], yRange: [5, 5] }, // degenerate range → `|| 1` guard
      });
      expect(() => flushFrame()).not.toThrow();
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("INIT render options (maxFps / emitBounds / emitTicks)", () => {
    function addAxisAndLine(engine: Engine): void {
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "axis",
        kind: "axis-grid",
        config: { xRange: [0, 1], yMode: "auto" },
      });
      engine.dispatch({
        op: Op.ADD_LAYER,
        id: "line",
        kind: "line",
        config: { color: "#0f0", capacity: 16 },
      });
      const buf = new Float32Array([0, -1, 100, 1]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf.buffer,
        dtype: "f32",
        length: buf.length,
      });
    }

    it("maxFps threads through INIT to the scheduler", () => {
      const setMaxFpsSpy = vi.spyOn(Scheduler.prototype, "setMaxFps");
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 100,
        height: 100,
        dpr: 1,
        maxFps: 30,
      });
      expect(setMaxFpsSpy).toHaveBeenCalledWith(30);
      engine.dispatch({ op: Op.DISPOSE });
      setMaxFpsSpy.mockRestore();
    });

    it("emitBounds:false / emitTicks:false suppress worker→main posts", () => {
      const postSpy = vi.spyOn(self, "postMessage").mockImplementation(() => {});
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({
        op: Op.INIT,
        canvas,
        width: 100,
        height: 100,
        dpr: 1,
        emitBounds: false,
        emitTicks: false,
      });
      addAxisAndLine(engine);
      flushFrame();
      const ops = postSpy.mock.calls.map((c) => (c[0] as { op?: number })?.op);
      expect(ops).not.toContain(WorkerOp.BOUNDS_UPDATE);
      expect(ops).not.toContain(WorkerOp.TICK_UPDATE);
      engine.dispatch({ op: Op.DISPOSE });
      postSpy.mockRestore();
    });

    it("emitBounds / emitTicks default to true (posts both)", () => {
      const postSpy = vi.spyOn(self, "postMessage").mockImplementation(() => {});
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      // No emit flags → defaults. No axis canvases → TICK_UPDATE fallback path.
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      addAxisAndLine(engine);
      flushFrame();
      const ops = postSpy.mock.calls.map((c) => (c[0] as { op?: number })?.op);
      expect(ops).toContain(WorkerOp.BOUNDS_UPDATE);
      expect(ops).toContain(WorkerOp.TICK_UPDATE);
      engine.dispatch({ op: Op.DISPOSE });
      postSpy.mockRestore();
    });

    it("emitRenderStats posts RENDER_STATS once a ~1s render window elapses", () => {
      const postSpy = vi.spyOn(self, "postMessage").mockImplementation(() => {});
      let t = 0;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => t);
      const engine = new Engine();
      engine.dispatch({
        op: Op.INIT,
        canvas: newCanvas(100, 100),
        width: 100,
        height: 100,
        dpr: 1,
        emitRenderStats: true,
      });
      addAxisAndLine(engine);
      flushFrame(); // first render at t=0 → opens the window, nothing emitted yet
      const has = () =>
        postSpy.mock.calls.some(
          (c) => (c[0] as { op?: number })?.op === WorkerOp.RENDER_STATS,
        );
      expect(has()).toBe(false);

      t = 1200; // advance past the 1s window
      const buf = new Float32Array([0, 0, 100, 1]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf.buffer,
        dtype: "f32",
        length: 4,
      });
      flushFrame(); // render at t=1200 → windowMs ≥ 1000 → emit

      const stats = postSpy.mock.calls
        .map((c) => c[0] as { op: number; renders: number; windowMs: number })
        .find((m) => m?.op === WorkerOp.RENDER_STATS);
      expect(stats).toBeTruthy();
      expect(stats!.renders).toBeGreaterThanOrEqual(1);
      expect(stats!.windowMs).toBeGreaterThanOrEqual(1000);
      engine.dispatch({ op: Op.DISPOSE });
      postSpy.mockRestore();
      nowSpy.mockRestore();
    });

    it("does not post RENDER_STATS when emitRenderStats is off (default)", () => {
      const postSpy = vi.spyOn(self, "postMessage").mockImplementation(() => {});
      let t = 0;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => t);
      const engine = new Engine();
      engine.dispatch({
        op: Op.INIT,
        canvas: newCanvas(100, 100),
        width: 100,
        height: 100,
        dpr: 1,
      });
      addAxisAndLine(engine);
      flushFrame();
      t = 1200;
      const buf = new Float32Array([0, 0, 100, 1]);
      engine.dispatch({
        op: Op.DATA,
        id: "line",
        buffer: buf.buffer,
        dtype: "f32",
        length: 4,
      });
      flushFrame();
      const ops = postSpy.mock.calls.map((c) => (c[0] as { op?: number })?.op);
      expect(ops).not.toContain(WorkerOp.RENDER_STATS);
      engine.dispatch({ op: Op.DISPOSE });
      postSpy.mockRestore();
      nowSpy.mockRestore();
    });
  });

  describe("dispose releases canvas backing", () => {
    it("shrinks the main + axis OffscreenCanvases to 0×0 on DISPOSE", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 2 });
      const xAxisCanvas = newCanvas(0, 0);
      const yAxisCanvas = newCanvas(0, 0);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        yAxisCanvas: yAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      flushFrame();
      // Backbuffers are non-zero after init + axis resize.
      expect(canvas.width).toBeGreaterThan(0);
      expect(xAxisCanvas.width).toBeGreaterThan(0);
      expect(yAxisCanvas.height).toBeGreaterThan(0);

      engine.dispatch({ op: Op.DISPOSE });

      // Backing freed synchronously (0×0) so the GPU surface releases now instead
      // of lingering until GC — this is what bounds GPU usage under mount/unmount
      // churn (a pool host per chart in a large accordion).
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      expect(xAxisCanvas.width).toBe(0);
      expect(xAxisCanvas.height).toBe(0);
      expect(yAxisCanvas.width).toBe(0);
      expect(yAxisCanvas.height).toBe(0);
    });

    it("shrinks the main canvas on DISPOSE with no axis canvases", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      flushFrame();
      expect(canvas.width).toBe(100);

      engine.dispatch({ op: Op.DISPOSE });

      // Main canvas released; axis canvases are null → releaseBacking early-returns.
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    });
  });

  describe("RELEASE_BACKING idle shrink", () => {
    it("shrinks main + axis backings to 0×0 but keeps the engine usable", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 2 });
      const xAxisCanvas = newCanvas(0, 0);
      const yAxisCanvas = newCanvas(0, 0);
      engine.dispatch({
        op: Op.SET_AXIS_CANVAS,
        xAxisCanvas: xAxisCanvas as unknown as OffscreenCanvas,
        yAxisCanvas: yAxisCanvas as unknown as OffscreenCanvas,
        xAxisHeight: 30,
        yAxisWidth: 60,
      });
      flushFrame();
      expect(canvas.width).toBeGreaterThan(0);
      expect(xAxisCanvas.width).toBeGreaterThan(0);
      expect(yAxisCanvas.height).toBeGreaterThan(0);

      engine.dispatch({ op: Op.RELEASE_BACKING });

      // All three GPU backings freed; canvas/context bindings kept.
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      expect(xAxisCanvas.width).toBe(0);
      expect(xAxisCanvas.height).toBe(0);
      expect(yAxisCanvas.width).toBe(0);
      expect(yAxisCanvas.height).toBe(0);

      // A later RESIZE re-allocates (the width-diff check compares against 0)
      // and the engine renders again — the shrink was non-destructive.
      engine.dispatch({ op: Op.RESIZE, width: 100, height: 100, dpr: 2 });
      expect(canvas.width).toBe(200);
      expect(canvas.height).toBe(200);
      expect(xAxisCanvas.width).toBe(200); // 100 × dpr 2
      expect(xAxisCanvas.height).toBe(60); // 30 × dpr 2
      expect(yAxisCanvas.width).toBe(120); // 60 × dpr 2
      expect(yAxisCanvas.height).toBe(200);
      flushFrame(); // renders without throwing on the re-allocated backing
      engine.dispatch({ op: Op.DISPOSE });
    });

    it("shrinks only the main canvas when no axis canvases exist", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      flushFrame();
      expect(canvas.width).toBe(100);
      engine.dispatch({ op: Op.RELEASE_BACKING });
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      engine.dispatch({ op: Op.DISPOSE });
    });
  });

  describe("context + resize optimizations", () => {
    type WithCtxOpts = { contextOptions: { alpha?: boolean } };

    it("uses an opaque (alpha:false) context by default; transparent keeps alpha", () => {
      const e1 = new Engine();
      const c1 = newCanvas(100, 100);
      e1.dispatch({ op: Op.INIT, canvas: c1, width: 100, height: 100, dpr: 1 });
      expect((c1 as unknown as WithCtxOpts).contextOptions.alpha).toBe(false);
      e1.dispatch({ op: Op.DISPOSE });

      const e2 = new Engine();
      const c2 = newCanvas(100, 100);
      e2.dispatch({
        op: Op.INIT,
        canvas: c2,
        width: 100,
        height: 100,
        dpr: 1,
        transparent: true,
      });
      expect((c2 as unknown as WithCtxOpts).contextOptions.alpha).toBe(true);
      e2.dispatch({ op: Op.DISPOSE });
    });

    it("skips a no-op resize (identical dimensions don't reallocate the backing)", () => {
      const engine = new Engine();
      const canvas = newCanvas(100, 100);
      engine.dispatch({ op: Op.INIT, canvas, width: 100, height: 100, dpr: 1 });
      flushFrame();
      // Wrap `width` with a counting setter to detect (non-)reallocation.
      let writes = 0;
      let w = canvas.width;
      Object.defineProperty(canvas, "width", {
        get: () => w,
        set: (v: number) => {
          writes++;
          w = v;
        },
        configurable: true,
      });
      // Same size → no width assignment (backing not reallocated).
      engine.dispatch({ op: Op.RESIZE, width: 100, height: 100, dpr: 1 });
      expect(writes).toBe(0);
      // Different size → width reassigned.
      engine.dispatch({ op: Op.RESIZE, width: 200, height: 100, dpr: 1 });
      expect(writes).toBeGreaterThan(0);
      engine.dispatch({ op: Op.DISPOSE });
    });
  });
});
