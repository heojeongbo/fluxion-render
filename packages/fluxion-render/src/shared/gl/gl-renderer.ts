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
import type { LabelSprite } from "../lib/label-cache";
import { parseColor, type Rgba } from "../lib/parse-color";
import type { Viewport } from "../model/viewport";
import {
  buildLineProgram,
  buildQuadProgram,
  type LineProgram,
  type QuadProgram,
} from "./gl-programs";
import type { ClipTransform } from "./gl-transform";

/** Sprite-texture LRU capacity; oldest texture is deleted at the cap. */
export const MAX_SPRITE_TEXTURES = 256;

export class GlRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly canvas: OffscreenCanvas;
  private readonly onRestored: () => void;
  private lost = false;
  private readonly onLostEvt = (e: Event) => {
    // preventDefault is REQUIRED for the browser to attempt a restore.
    e.preventDefault();
    this.lost = true;
    console.warn(
      "[fluxion] webgl context lost — rendering suspended until restore. " +
        "If this fires while MANY charts are mounted, the browser's live-WebGL-" +
        "context cap was likely hit (Chromium keeps ~16 — evicted contexts do " +
        "NOT restore while over the cap). Use renderer:'2d' there, or fewer " +
        "webgl charts; Firefox's cap is far higher (~300).",
    );
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
  // Label-sprite quad pipeline: program + static unit-quad VBO + texture LRU
  // keyed by sprite canvas identity (sprite rasters are immutable).
  private quadProgram: QuadProgram | null = null;
  private quadVbo: WebGLBuffer | null = null;
  private readonly spriteTextures = new Map<OffscreenCanvas, WebGLTexture>();

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
  resolveColor(s: string): readonly [number, number, number, number] {
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
    const gl = this.setupLineDraw(vertices, count, transform, color, opacity, widthPx);
    if (!gl) return;
    let segStart = 0;
    for (let i = 0; i <= breaks.length; i++) {
      const segEnd = i < breaks.length ? breaks[i]! : count;
      if (segEnd - segStart >= 2)
        gl.drawArrays(gl.LINE_STRIP, segStart, segEnd - segStart);
      segStart = segEnd;
    }
  }

  /**
   * Draw `count` vertices as independent line SEGMENTS (gl.LINES — vertex
   * pairs), for grid lines / tick marks / zero axes built by
   * `LineListBuilder`. Same color/width/transform semantics as
   * {@link drawLineStrip}.
   */
  drawLineList(
    vertices: Float32Array,
    count: number,
    transform: ClipTransform,
    color: Rgba,
    opacity: number,
    widthPx: number,
  ): void {
    const gl = this.setupLineDraw(vertices, count, transform, color, opacity, widthPx);
    if (!gl) return;
    gl.drawArrays(gl.LINES, 0, count);
  }

  /**
   * Shared prologue for both line primitives: program + streaming VBO upload +
   * uniforms + clamped width. Returns the context ready to draw, or null when
   * the draw must be skipped (lost context, degenerate count, program failure).
   */
  private setupLineDraw(
    vertices: Float32Array,
    count: number,
    transform: ClipTransform,
    color: Rgba,
    opacity: number,
    widthPx: number,
  ): WebGLRenderingContext | null {
    if (this.lost || count < 2) return null;
    const gl = this.gl;
    const prog = this.ensureLineProgram();
    if (!prog) return null;
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
    return gl;
  }

  private ensureLineProgram(): LineProgram | null {
    if (!this.lineProgram) this.lineProgram = buildLineProgram(this.gl);
    return this.lineProgram;
  }

  /**
   * Blit a label sprite as a textured quad with its top-left at CSS-px
   * (dx, dy) — the position `labelBlitPos` computed, so GL labels land on the
   * same pixels as the 2d `drawImage` blit. `transform` is the px→clip affine
   * (`pxToClip`). The sprite raster is premultiplied on upload (matching the
   * frame blend) and sampled NEAREST at 1:1 device scale.
   */
  drawSprite(
    sprite: LabelSprite,
    dx: number,
    dy: number,
    transform: ClipTransform,
  ): void {
    if (this.lost) return;
    const gl = this.gl;
    const prog = this.ensureQuadProgram();
    if (!prog) return;
    const tex = this.textureFor(sprite.canvas);
    /* v8 ignore start -- createTexture returns null only on a lost context */
    if (!tex) return;
    /* v8 ignore stop */
    gl.useProgram(prog.program);
    if (!this.quadVbo) {
      this.quadVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    }
    gl.enableVertexAttribArray(prog.aUnit);
    gl.vertexAttribPointer(prog.aUnit, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(prog.uRect, dx, dy, sprite.cssW, sprite.cssH);
    gl.uniform2f(prog.uOrigin, transform[0]!, transform[1]!);
    gl.uniform2f(prog.uScale, transform[2]!, transform[3]!);
    gl.uniform2f(prog.uOffset, transform[4]!, transform[5]!);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private ensureQuadProgram(): QuadProgram | null {
    if (!this.quadProgram) this.quadProgram = buildQuadProgram(this.gl);
    return this.quadProgram;
  }

  /**
   * LRU-cached texture for a sprite canvas. Sprite rasters are immutable, so
   * identity is a safe cache key; the oldest texture is DELETED at the cap
   * (a WeakMap would leak GPU memory — GC never runs deleteTexture).
   */
  private textureFor(canvas: OffscreenCanvas): WebGLTexture | null {
    const gl = this.gl;
    const cached = this.spriteTextures.get(canvas);
    if (cached) {
      this.spriteTextures.delete(canvas);
      this.spriteTextures.set(canvas, cached);
      return cached;
    }
    const tex = gl.createTexture();
    /* v8 ignore start -- createTexture returns null only on a lost context */
    if (!tex) return null;
    /* v8 ignore stop */
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Premultiply on upload so the sprite composites under the frame-wide
    // (ONE, ONE_MINUS_SRC_ALPHA) blend exactly like a 2d drawImage.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    // NPOT sprite dimensions: clamp + non-mip NEAREST are REQUIRED; NEAREST is
    // also correct — the quad is a 1:1 device-pixel blit (grid-snapped).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (this.spriteTextures.size >= MAX_SPRITE_TEXTURES) {
      const oldest = this.spriteTextures.keys().next().value as OffscreenCanvas;
      const evicted = this.spriteTextures.get(oldest)!;
      this.spriteTextures.delete(oldest);
      gl.deleteTexture(evicted);
    }
    this.spriteTextures.set(canvas, tex);
    return tex;
  }

  /** Drop GPU-object caches after a context restore (extended by later stages). */
  private dropGpuCaches(): void {
    this.lineProgram = null;
    this.lineVbo = null;
    this.lineWidthRange = null;
    this.quadProgram = null;
    this.quadVbo = null;
    // The GL objects died with the old context — just forget the handles.
    this.spriteTextures.clear();
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
    if (this.quadProgram) this.gl.deleteProgram(this.quadProgram.program);
    if (this.quadVbo) this.gl.deleteBuffer(this.quadVbo);
    for (const tex of this.spriteTextures.values()) this.gl.deleteTexture(tex);
    this.dropGpuCaches();
    try {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Extension unavailable — the context is released with the canvas.
    }
  }
}
