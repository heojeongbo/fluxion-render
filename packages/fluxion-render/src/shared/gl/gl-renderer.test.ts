import { afterEach, describe, expect, it, vi } from "vitest";
import type { CtxCall, FakeGl } from "../../test/setup";
import { resetParseColorCache } from "../lib/parse-color";
import { Viewport } from "../model/viewport";
import { GlRenderer, MAX_SPRITE_TEXTURES } from "./gl-renderer";

interface GlCanvasHarness {
  canvas: OffscreenCanvas;
  gl: FakeGl;
  dispatch(evt: { type: string; preventDefault?: () => void }): void;
  options(): unknown;
}

function newGlCanvas(w = 200, h = 100): GlCanvasHarness {
  // biome-ignore lint: using global stub
  const raw = new (globalThis as any).OffscreenCanvas(w, h);
  return {
    canvas: raw as OffscreenCanvas,
    get gl() {
      return raw.getContext("webgl") as FakeGl;
    },
    dispatch: (evt) => raw.dispatchEvent(evt),
    options: () => raw.contextOptions,
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
    const h = newGlCanvas(200, 100);
    const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
    expect(glr).not.toBeNull();
    const gl = h.gl;

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
    const h = newGlCanvas();
    const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
    const gl = h.gl;

    glr.beginFrame("tomato");
    glr.beginFrame("tomato");
    const clears = gl.calls.filter((c) => c.name === "clearColor");
    expect(clears[0]!.args).toEqual([1, 1, 1, 1]);
    expect(errSpy).toHaveBeenCalledTimes(1); // warn-once per string
    errSpy.mockRestore();
  });

  it("scissors the plot rect in device px with a bottom-left origin", () => {
    const h = newGlCanvas(400, 260);
    const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
    const gl = h.gl;

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
    const h = newGlCanvas();
    const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, onRestored)!;
    const gl = h.gl;

    const preventDefault = vi.fn();
    h.dispatch({ type: "webglcontextlost", preventDefault });
    expect(preventDefault).toHaveBeenCalled(); // required to allow restore
    expect(glr.isLost).toBe(true);
    const before = gl.calls.length;
    expect(glr.beginFrame("#000")).toBe(false); // whole frame skipped
    expect(gl.calls.length).toBe(before);

    h.dispatch({ type: "webglcontextrestored" });
    expect(glr.isLost).toBe(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(glr.beginFrame("#000")).toBe(true);
    warnSpy.mockRestore();
  });

  it("dispose releases the context and detaches the loss listeners", () => {
    const onRestored = vi.fn();
    const h = newGlCanvas();
    const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, onRestored)!;
    const gl = h.gl;

    glr.dispose();
    expect(gl.calls.some((c) => c.name === "getExtension")).toBe(true);
    expect(gl.calls.some((c) => c.name === "loseContext")).toBe(true);
    h.dispatch({ type: "webglcontextrestored" });
    expect(onRestored).not.toHaveBeenCalled(); // listener removed
  });

  describe("drawLineStrip", () => {
    const TRANSFORM = new Float32Array([0, 0, 1, 1, 0, 0]);

    function drawOnce(
      glr: GlRenderer,
      verts = new Float32Array([0, 0, 1, 1, 2, 0, 3, 1]),
      breaks: number[] = [],
      count = 4,
    ): void {
      glr.drawLineStrip(verts, count, breaks, TRANSFORM, [0.2, 0.4, 0.8, 0.5], 0.5, 2);
    }

    it("uploads the visible prefix and draws one strip with premultiplied color", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      const verts = new Float32Array(16); // scratch larger than the fill
      verts.set([0, 0, 1, 1, 2, 0]);
      glr.drawLineStrip(verts, 3, [], TRANSFORM, [0.2, 0.4, 0.8, 0.5], 0.5, 2);

      const upload = gl.calls.find((c) => c.name === "bufferData")!;
      expect((upload.args[1] as Float32Array).length).toBe(6); // count*2, not scratch len
      const color = gl.calls.find((c) => c.name === "uniform4f")!;
      // a = 0.5 (color alpha) × 0.5 (opacity) = 0.25; rgb premultiplied by a.
      expect(color.args.slice(1)).toEqual([0.2 * 0.25, 0.4 * 0.25, 0.8 * 0.25, 0.25]);
      const draws = gl.calls.filter((c) => c.name === "drawArrays");
      expect(draws).toHaveLength(1);
      expect(draws[0]!.args).toEqual([gl.LINE_STRIP, 0, 3]);
    });

    it("splits at break indices and skips degenerate (<2 vertex) segments", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      const verts = new Float32Array(12);
      // 6 vertices, breaks at 2 and 5 → segments [0,2) [2,5) [5,6); last is 1 vertex → skipped.
      glr.drawLineStrip(verts, 6, [2, 5], TRANSFORM, [1, 1, 1, 1], 1, 1);
      const draws = gl.calls.filter((c) => c.name === "drawArrays");
      expect(draws.map((c) => c.args)).toEqual([
        [gl.LINE_STRIP, 0, 2],
        [gl.LINE_STRIP, 2, 3],
      ]);
    });

    it("clamps line width to ALIASED_LINE_WIDTH_RANGE (queried once)", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl; // FakeGl reports [1, 8]
      drawOnce(glr); // width 2 → within range
      glr.drawLineStrip(new Float32Array(8), 4, [], TRANSFORM, [1, 1, 1, 1], 1, 40);
      glr.drawLineStrip(new Float32Array(8), 4, [], TRANSFORM, [1, 1, 1, 1], 1, 0.1);
      const widths = gl.calls.filter((c) => c.name === "lineWidth").map((c) => c.args[0]);
      expect(widths).toEqual([2, 8, 1]);
      const queries = gl.calls.filter(
        (c) => c.name === "getParameter" && c.args[0] === gl.ALIASED_LINE_WIDTH_RANGE,
      );
      expect(queries).toHaveLength(1); // cached after first draw
    });

    it("reuses one streaming VBO and the lazily built program across draws", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      drawOnce(glr);
      drawOnce(glr);
      expect(gl.calls.filter((c) => c.name === "createBuffer")).toHaveLength(1);
      expect(gl.calls.filter((c) => c.name === "linkProgram")).toHaveLength(1);
    });

    it("no-ops with fewer than 2 vertices, while lost, or when the program fails to build", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      drawOnce(glr, new Float32Array([0, 0]), [], 1); // count < 2
      expect(gl.calls.filter((c) => c.name === "drawArrays")).toHaveLength(0);

      h.dispatch({ type: "webglcontextlost", preventDefault: () => {} });
      const before = gl.calls.length;
      drawOnce(glr);
      expect(gl.calls.length).toBe(before); // lost → untouched
      h.dispatch({ type: "webglcontextrestored" });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      gl.failCompile = true; // context restore dropped the cached program
      drawOnce(glr);
      expect(gl.calls.filter((c) => c.name === "drawArrays")).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("rebuilds GL objects dropped by a context restore", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      drawOnce(glr);
      h.dispatch({ type: "webglcontextlost", preventDefault: () => {} });
      h.dispatch({ type: "webglcontextrestored" });
      drawOnce(glr);
      expect(gl.calls.filter((c) => c.name === "createBuffer")).toHaveLength(2);
      expect(gl.calls.filter((c) => c.name === "linkProgram")).toHaveLength(2);
      // Width range re-queried too (device limits can change across restores).
      const queries = gl.calls.filter(
        (c) => c.name === "getParameter" && c.args[0] === gl.ALIASED_LINE_WIDTH_RANGE,
      );
      expect(queries).toHaveLength(2);
      warnSpy.mockRestore();
    });
  });

  describe("drawLineList / drawSprite (grid + label pipeline)", () => {
    const TRANSFORM = new Float32Array([0, 0, 1, 1, 0, 0]);

    function makeSprite(cssW = 52, cssH = 22) {
      // biome-ignore lint: using global stub
      const canvas = new (globalThis as any).OffscreenCanvas(cssW, cssH);
      return { canvas, textW: cssW - 2, cssW, cssH, yAnchor: 4 };
    }

    it("draws a segment list as one gl.LINES call", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      glr.drawLineList(new Float32Array(12), 6, TRANSFORM, [1, 1, 1, 1], 1, 2);
      const draws = gl.calls.filter((c) => c.name === "drawArrays");
      expect(draws).toHaveLength(1);
      expect(draws[0]!.args).toEqual([gl.LINES, 0, 6]);
    });

    it("uploads sprite textures premultiplied, NEAREST, clamped — then quads them", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      const sprite = makeSprite();
      glr.drawSprite(sprite as never, 10.5, 20.5, TRANSFORM);

      expect(
        gl.calls.some(
          (c) =>
            c.name === "pixelStorei" &&
            c.args[0] === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL &&
            c.args[1] === true,
        ),
      ).toBe(true);
      const upload = gl.calls.find((c) => c.name === "texImage2D")!;
      expect(upload.args[5]).toBe(sprite.canvas);
      const params = gl.calls
        .filter((c) => c.name === "texParameteri")
        .map((c) => c.args.slice(1));
      expect(params).toContainEqual([gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE]);
      expect(params).toContainEqual([gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]);
      expect(params).toContainEqual([gl.TEXTURE_MIN_FILTER, gl.NEAREST]);
      expect(params).toContainEqual([gl.TEXTURE_MAG_FILTER, gl.NEAREST]);
      const rect = gl.calls.find((c) => c.name === "uniform4f")!;
      expect(rect.args.slice(1)).toEqual([10.5, 20.5, 52, 22]);
      const draws = gl.calls.filter((c) => c.name === "drawArrays");
      expect(draws).toHaveLength(1);
      expect(draws[0]!.args).toEqual([gl.TRIANGLE_STRIP, 0, 4]);
    });

    it("caches the texture per sprite canvas (one upload across draws)", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      const sprite = makeSprite();
      glr.drawSprite(sprite as never, 0, 0, TRANSFORM);
      glr.drawSprite(sprite as never, 5, 5, TRANSFORM);
      expect(gl.calls.filter((c) => c.name === "texImage2D")).toHaveLength(1);
      expect(gl.calls.filter((c) => c.name === "createBuffer")).toHaveLength(1); // static quad VBO
      expect(gl.calls.filter((c) => c.name === "linkProgram")).toHaveLength(1);
    });

    it("evicts the least-recent texture (deleteTexture) at the LRU cap", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      const first = makeSprite();
      glr.drawSprite(first as never, 0, 0, TRANSFORM);
      for (let i = 0; i < MAX_SPRITE_TEXTURES; i++) {
        glr.drawSprite(makeSprite() as never, 0, 0, TRANSFORM);
      }
      expect(gl.calls.filter((c) => c.name === "deleteTexture")).toHaveLength(1);
      // `first` was the oldest → re-drawing it must re-upload.
      const before = gl.calls.filter((c) => c.name === "texImage2D").length;
      glr.drawSprite(first as never, 0, 0, TRANSFORM);
      expect(gl.calls.filter((c) => c.name === "texImage2D")).toHaveLength(before + 1);
    });

    it("skips sprite draws while lost; restore drops texture/program caches", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      const sprite = makeSprite();
      glr.drawSprite(sprite as never, 0, 0, TRANSFORM);
      h.dispatch({ type: "webglcontextlost", preventDefault: () => {} });
      const before = gl.calls.length;
      glr.drawSprite(sprite as never, 0, 0, TRANSFORM);
      expect(gl.calls.length).toBe(before); // lost → untouched
      h.dispatch({ type: "webglcontextrestored" });
      glr.drawSprite(sprite as never, 0, 0, TRANSFORM);
      // Same sprite re-uploaded and program relinked on the fresh context.
      expect(gl.calls.filter((c) => c.name === "texImage2D")).toHaveLength(2);
      expect(gl.calls.filter((c) => c.name === "linkProgram")).toHaveLength(2);
      warnSpy.mockRestore();
    });

    it("no-ops when the quad program fails to build", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      gl.failCompile = true;
      glr.drawSprite(makeSprite() as never, 0, 0, TRANSFORM);
      expect(gl.calls.filter((c) => c.name === "drawArrays")).toHaveLength(0);
      expect(gl.calls.filter((c) => c.name === "texImage2D")).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("dispose deletes cached textures and the quad pipeline", () => {
      const h = newGlCanvas();
      const glr = GlRenderer.tryCreate(h.canvas, { alpha: false }, () => {})!;
      const gl = h.gl;
      glr.drawSprite(makeSprite() as never, 0, 0, TRANSFORM);
      glr.drawSprite(makeSprite() as never, 0, 0, TRANSFORM);
      glr.dispose();
      expect(gl.calls.filter((c) => c.name === "deleteTexture")).toHaveLength(2);
      expect(gl.calls.filter((c) => c.name === "deleteProgram")).toHaveLength(1);
      expect(gl.calls.filter((c) => c.name === "deleteBuffer")).toHaveLength(1);
    });
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
    const h = newGlCanvas();
    GlRenderer.tryCreate(h.canvas, { alpha: true }, () => {});
    expect(h.options()).toMatchObject({
      alpha: true,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
  });
});
