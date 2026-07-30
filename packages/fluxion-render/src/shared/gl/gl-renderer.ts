/**
 * WebGL rendering surface for the worker engine (`renderer: "webgl"`).
 *
 * Why it exists: Firefox's worker canvas2d has a measured FIXED ~0.5-1.2 ms
 * per-render submission overhead that is insensitive to pixels, command count,
 * and messages (remote-canvas pipeline cost). WebGL submits straight to the
 * GPU process and bypasses that pipeline entirely.
 *
 * Lives in `shared/` (like the `Layer` contract) so entity layers can type
 * their optional `drawGl(glr, viewport)` methods against it without an
 * entities→features import.
 *
 * Stage 1 surface: context acquisition with 2d-fallback signal (`tryCreate`
 * returns null on failure), per-frame begin (viewport + premultiplied clear +
 * the single frame-wide blend state), plot-rect scissor, context-lost
 * latching, and disposal (with `WEBGL_lose_context` release). Draw programs
 * (lines, label quads) arrive in later stages.
 */
import { parseColor, type Rgba } from "../lib/parse-color";
import type { Viewport } from "../model/viewport";
import { buildLineProgram, type LineProgram } from "./gl-programs";
import type { ClipTransform } from "./gl-transform";

export class GlRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly canvas: OffscreenCanvas;
  private readonly onRestored: () => void;
  private lost = false;
  private readonly onLostEvt = (e: Event) => {
    // preventDefault is REQUIRED for the browser to attempt a restore.
    e.preventDefault();
    this.lost = true;
    console.warn("[fluxion] webgl context lost — rendering suspended until restore");
  };
  private readonly onRestoredEvt = () => {
    this.lost = false;
    // All GL objects died with the old context; later stages drop their
    // program/buffer/texture caches here. Re-render lazily.
    this.dropGpuCaches();
    this.onRestored();
  };
  // Colors that failed to parse — warn once each, then paint opaque white.
  private readonly warnedColors = new Set<string>();
  // Lazily built line program + shared streaming VBO (dropped on context loss).
  private lineProgram: LineProgram | null = null;
  private lineVbo: WebGLBuffer | null = null;
  private lineWidthRange: readonly [number, number] | null = null;

  /**
   * Acquire a webgl context on `canvas`. Returns null when the context can't
   * be created (headless env, blocklisted driver) — the engine then falls
   * back to the 2d path so the chart renders regardless.
   */
  static tryCreate(
    canvas: OffscreenCanvas,
    opts: { alpha: boolean },
    onRestored: () => void,
  ): GlRenderer | null {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", {
        alpha: opts.alpha,
        antialias: true,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        premultipliedAlpha: true,
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return null;
    return new GlRenderer(gl, canvas, onRestored);
  }

  private constructor(
    gl: WebGLRenderingContext,
    canvas: OffscreenCanvas,
    onRestored: () => void,
  ) {
    this.gl = gl;
    this.canvas = canvas;
    this.onRestored = onRestored;
    canvas.addEventListener("webglcontextlost", this.onLostEvt);
    canvas.addEventListener("webglcontextrestored", this.onRestoredEvt);
  }

  get isLost(): boolean {
    return this.lost;
  }

  /**
   * Start a frame: size the GL viewport to the current drawing buffer, clear
   * to the (premultiplied) background color, and set the single frame-wide
   * blend state every subsequent draw relies on. Returns false while the
   * context is lost — the whole frame must then be skipped (the compositor
   * keeps the last presented image).
   */
  beginFrame(bgColor: string): boolean {
    if (this.lost) return false;
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.SCISSOR_TEST);
    const [r, g, b, a] = this.resolveColor(bgColor);
    // Premultiplied drawing buffer: clear color channels are multiplied by a.
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }

  /** Confine subsequent draws to the plot rect (inline-axes margins excluded). */
  scissorPlotRect(viewport: Viewport): void {
    const gl = this.gl;
    const dpr = viewport.dpr;
    // Scissor origin is the BOTTOM-left of the drawing buffer.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.round(viewport.plotLeft * dpr),
      Math.round(viewport.insetBottom * dpr),
      Math.round(viewport.plotWidth * dpr),
      Math.round(viewport.plotHeight * dpr),
    );
  }

  scissorOff(): void {
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  /** Straight-alpha RGBA for `s`, warning once and using white on parse failure. */
  private resolveColor(s: string): readonly [number, number, number, number] {
    const parsed = parseColor(s);
    if (parsed) return parsed;
    if (!this.warnedColors.has(s)) {
      this.warnedColors.add(s);
      console.warn(
        `[fluxion] webgl renderer cannot parse color "${s}" — using opaque white. ` +
          "Supported: #rgb[a], #rrggbb[aa], rgb(), rgba().",
      );
    }
    return [1, 1, 1, 1];
  }

  /**
   * Draw a polyline of `count` raw vertices (already in `vertices[0..count*2)`)
   * under the affine `transform`, split into separate strips at `breaks`
   * (vertex indices that START a new strip). `color` is straight-alpha; the
   * premultiplication for the frame's (ONE, ONE_MINUS_SRC_ALPHA) blend happens
   * here. `widthPx` is clamped to the device's aliased line-width range.
   */
  drawLineStrip(
    vertices: Float32Array,
    count: number,
    breaks: readonly number[],
    transform: ClipTransform,
    color: Rgba,
    opacity: number,
    widthPx: number,
  ): void {
    if (this.lost || count < 2) return;
    const gl = this.gl;
    const prog = this.ensureLineProgram();
    if (!prog) return;
    gl.useProgram(prog.program);
    if (!this.lineVbo) this.lineVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, count * 2), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(prog.aPos);
    gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(prog.uOrigin, transform[0]!, transform[1]!);
    gl.uniform2f(prog.uScale, transform[2]!, transform[3]!);
    gl.uniform2f(prog.uOffset, transform[4]!, transform[5]!);
    const a = color[3] * opacity;
    gl.uniform4f(prog.uColor, color[0] * a, color[1] * a, color[2] * a, a);
    if (!this.lineWidthRange) {
      const range = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) as
        | Float32Array
        | [number, number];
      this.lineWidthRange = [range[0]!, range[1]!];
    }
    gl.lineWidth(
      Math.min(Math.max(widthPx, this.lineWidthRange[0]), this.lineWidthRange[1]),
    );
    let segStart = 0;
    for (let i = 0; i <= breaks.length; i++) {
      const segEnd = i < breaks.length ? breaks[i]! : count;
      if (segEnd - segStart >= 2)
        gl.drawArrays(gl.LINE_STRIP, segStart, segEnd - segStart);
      segStart = segEnd;
    }
  }

  private ensureLineProgram(): LineProgram | null {
    if (!this.lineProgram) this.lineProgram = buildLineProgram(this.gl);
    return this.lineProgram;
  }

  /** Drop GPU-object caches after a context restore (extended by later stages). */
  private dropGpuCaches(): void {
    this.lineProgram = null;
    this.lineVbo = null;
    this.lineWidthRange = null;
  }

  /**
   * Release GL resources and the context itself. Mirrors the engine's
   * eager-release philosophy for canvas backings: under mount/unmount churn,
   * waiting for GC to free GPU contexts piles up surfaces.
   */
  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLostEvt);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestoredEvt);
    if (this.lineProgram) this.gl.deleteProgram(this.lineProgram.program);
    if (this.lineVbo) this.gl.deleteBuffer(this.lineVbo);
    this.dropGpuCaches();
    try {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Extension unavailable — the context is released with the canvas.
    }
  }
}
