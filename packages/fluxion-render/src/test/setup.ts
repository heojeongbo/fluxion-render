/**
 * Global test environment stubs. Happy-DOM ships DOM + window but not the
 * browser graphics APIs that FluxionRender depends on (OffscreenCanvas,
 * transferControlToOffscreen, ResizeObserver). We patch enough of each to
 * exercise the host/worker/react surface without a real browser.
 */

import { afterEach } from "vitest";
import { resetFluxionDefaults } from "../features/host/model/fluxion-defaults";
import { resetFlushScheduler } from "../shared/lib/flush-scheduler";
import { labelMetaOf, resetLabelCache } from "../shared/lib/label-cache";
import { resetOnScreenObserver } from "../shared/lib/onscreen-observer";
import { resetFrameDriver } from "../shared/model/frame-driver";

// The frame singletons (shared flush scheduler, shared frame driver) and the
// label-sprite cache hold module-level state. A test that leaves a frame armed
// — especially under a stubbed/fake-timer rAF that never fires — would wedge
// every later test in the process, and sprites cached in one test would
// satisfy construction-count assertions in the next; always reset them.
// Registered in setup so it runs AFTER each file's own afterEach hooks
// (vitest 'stack' hook order).
afterEach(() => {
  resetFlushScheduler();
  resetFrameDriver();
  resetLabelCache();
  resetOnScreenObserver();
  resetFluxionDefaults();
  fakeIntersectionObservers.length = 0;
});

export interface CtxCall {
  name: string;
  args: unknown[];
}

export interface FakeCtx {
  calls: CtxCall[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: string;
  textAlign: string;
  globalAlpha: number;
  setTransform(...args: unknown[]): void;
  fillRect(...args: unknown[]): void;
  clearRect(...args: unknown[]): void;
  strokeRect(...args: unknown[]): void;
  rect(...args: unknown[]): void;
  beginPath(): void;
  closePath(): void;
  clip(): void;
  moveTo(...args: unknown[]): void;
  lineTo(...args: unknown[]): void;
  stroke(): void;
  fill(): void;
  fillText(...args: unknown[]): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  save(): void;
  restore(): void;
  arc(...args: unknown[]): void;
  scale(...args: unknown[]): void;
  translate(...args: unknown[]): void;
  drawImage(...args: unknown[]): void;
  createLinearGradient(...args: unknown[]): { addColorStop(...a: unknown[]): void };
}

export function createFakeCtx(): FakeCtx {
  const calls: CtxCall[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  return {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textBaseline: "",
    textAlign: "",
    globalAlpha: 1,
    setTransform: rec("setTransform"),
    fillRect: rec("fillRect"),
    clearRect: rec("clearRect"),
    strokeRect: rec("strokeRect"),
    rect: rec("rect"),
    beginPath: rec("beginPath") as () => void,
    closePath: rec("closePath") as () => void,
    clip: rec("clip") as () => void,
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke") as () => void,
    fill: rec("fill") as () => void,
    fillText: rec("fillText"),
    measureText: (_text: string) => ({ width: 50 }),
    setLineDash: rec("setLineDash") as (segments: number[]) => void,
    save: rec("save") as () => void,
    restore: rec("restore") as () => void,
    arc: rec("arc"),
    scale: rec("scale"),
    translate: rec("translate"),
    drawImage: rec("drawImage"),
    createLinearGradient: (..._args: unknown[]) => ({
      addColorStop: rec("addColorStop"),
    }),
  };
}

/** Call-recording WebGL context stub (mirrors the FakeCtx convention). */
export interface FakeGl {
  calls: CtxCall[];
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  COLOR_BUFFER_BIT: number;
  BLEND: number;
  ONE: number;
  ONE_MINUS_SRC_ALPHA: number;
  SCISSOR_TEST: number;
  VERTEX_SHADER: number;
  FRAGMENT_SHADER: number;
  COMPILE_STATUS: number;
  LINK_STATUS: number;
  ARRAY_BUFFER: number;
  DYNAMIC_DRAW: number;
  STATIC_DRAW: number;
  LINE_STRIP: number;
  LINES: number;
  TRIANGLE_STRIP: number;
  FLOAT: number;
  ALIASED_LINE_WIDTH_RANGE: number;
  TEXTURE_2D: number;
  TEXTURE0: number;
  RGBA: number;
  UNSIGNED_BYTE: number;
  TEXTURE_WRAP_S: number;
  TEXTURE_WRAP_T: number;
  TEXTURE_MIN_FILTER: number;
  TEXTURE_MAG_FILTER: number;
  CLAMP_TO_EDGE: number;
  NEAREST: number;
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: number;
  viewport(...args: unknown[]): void;
  clearColor(...args: unknown[]): void;
  clear(...args: unknown[]): void;
  enable(...args: unknown[]): void;
  disable(...args: unknown[]): void;
  blendFunc(...args: unknown[]): void;
  scissor(...args: unknown[]): void;
  createShader(...args: unknown[]): object;
  shaderSource(...args: unknown[]): void;
  compileShader(...args: unknown[]): void;
  getShaderParameter(...args: unknown[]): boolean;
  getShaderInfoLog(...args: unknown[]): string;
  deleteShader(...args: unknown[]): void;
  createProgram(...args: unknown[]): object;
  attachShader(...args: unknown[]): void;
  linkProgram(...args: unknown[]): void;
  getProgramParameter(...args: unknown[]): boolean;
  getProgramInfoLog(...args: unknown[]): string;
  deleteProgram(...args: unknown[]): void;
  useProgram(...args: unknown[]): void;
  getAttribLocation(...args: unknown[]): number;
  getUniformLocation(...args: unknown[]): object;
  createBuffer(...args: unknown[]): object;
  bindBuffer(...args: unknown[]): void;
  bufferData(...args: unknown[]): void;
  deleteBuffer(...args: unknown[]): void;
  enableVertexAttribArray(...args: unknown[]): void;
  vertexAttribPointer(...args: unknown[]): void;
  uniform1i(...args: unknown[]): void;
  uniform2f(...args: unknown[]): void;
  uniform4f(...args: unknown[]): void;
  lineWidth(...args: unknown[]): void;
  drawArrays(...args: unknown[]): void;
  createTexture(...args: unknown[]): object;
  bindTexture(...args: unknown[]): void;
  deleteTexture(...args: unknown[]): void;
  activeTexture(...args: unknown[]): void;
  pixelStorei(...args: unknown[]): void;
  texImage2D(...args: unknown[]): void;
  texParameteri(...args: unknown[]): void;
  getParameter(pname: number): unknown;
  getExtension(name: string): { loseContext(): void } | null;
  /** Test knobs: force shader-compile or program-link failure. */
  failCompile: boolean;
  failLink: boolean;
}

export function createFakeGl(canvas: { width: number; height: number }): FakeGl {
  const calls: CtxCall[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const recReturning =
    <T>(name: string, value: () => T) =>
    (...args: unknown[]): T => {
      calls.push({ name, args });
      return value();
    };
  const fake: FakeGl = {
    calls,
    get drawingBufferWidth() {
      return canvas.width;
    },
    get drawingBufferHeight() {
      return canvas.height;
    },
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SCISSOR_TEST: 0x0c11,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    STATIC_DRAW: 0x88e4,
    LINE_STRIP: 3,
    LINES: 1,
    TRIANGLE_STRIP: 5,
    FLOAT: 0x1406,
    ALIASED_LINE_WIDTH_RANGE: 0x846e,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    NEAREST: 0x2600,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    viewport: rec("viewport"),
    clearColor: rec("clearColor"),
    clear: rec("clear"),
    enable: rec("enable"),
    disable: rec("disable"),
    blendFunc: rec("blendFunc"),
    scissor: rec("scissor"),
    createShader: recReturning("createShader", () => ({})),
    shaderSource: rec("shaderSource"),
    compileShader: rec("compileShader"),
    getShaderParameter: recReturning("getShaderParameter", () => !fake.failCompile),
    getShaderInfoLog: recReturning("getShaderInfoLog", () => "fake compile log"),
    deleteShader: rec("deleteShader"),
    createProgram: recReturning("createProgram", () => ({})),
    attachShader: rec("attachShader"),
    linkProgram: rec("linkProgram"),
    getProgramParameter: recReturning("getProgramParameter", () => !fake.failLink),
    getProgramInfoLog: recReturning("getProgramInfoLog", () => "fake link log"),
    deleteProgram: rec("deleteProgram"),
    useProgram: rec("useProgram"),
    getAttribLocation: recReturning("getAttribLocation", () => 0),
    getUniformLocation: recReturning("getUniformLocation", () => ({})),
    createBuffer: recReturning("createBuffer", () => ({})),
    bindBuffer: rec("bindBuffer"),
    bufferData: rec("bufferData"),
    deleteBuffer: rec("deleteBuffer"),
    enableVertexAttribArray: rec("enableVertexAttribArray"),
    vertexAttribPointer: rec("vertexAttribPointer"),
    uniform1i: rec("uniform1i"),
    uniform2f: rec("uniform2f"),
    uniform4f: rec("uniform4f"),
    lineWidth: rec("lineWidth"),
    drawArrays: rec("drawArrays"),
    createTexture: recReturning("createTexture", () => ({})),
    bindTexture: rec("bindTexture"),
    deleteTexture: rec("deleteTexture"),
    activeTexture: rec("activeTexture"),
    pixelStorei: rec("pixelStorei"),
    texImage2D: rec("texImage2D"),
    texParameteri: rec("texParameteri"),
    getParameter: recReturning("getParameter", () => [1, 8] as unknown),
    getExtension(name: string) {
      calls.push({ name: "getExtension", args: [name] });
      return name === "WEBGL_lose_context" ? { loseContext: rec("loseContext") } : null;
    },
    failCompile: false,
    failLink: false,
  };
  return fake;
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  /** Records the most recent `getContext` options arg (for asserting `alpha` etc.). */
  contextOptions: unknown;
  private ctx: FakeCtx | null = null;
  private glCtx: FakeGl | null = null;
  private listeners = new Map<string, Set<EventListener>>();
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  getContext(type: string, options?: unknown): FakeCtx | FakeGl {
    this.contextOptions = options;
    if (type === "webgl") {
      if (!this.glCtx) this.glCtx = createFakeGl(this);
      return this.glCtx;
    }
    if (!this.ctx) this.ctx = createFakeCtx();
    return this.ctx;
  }
  addEventListener(type: string, fn: EventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: EventListener): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(evt: { type: string; preventDefault?: () => void }): boolean {
    for (const fn of this.listeners.get(evt.type) ?? []) {
      fn(evt as Event);
    }
    return true;
  }
}

// biome-ignore lint: installing global stub
(globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

if (typeof HTMLCanvasElement !== "undefined") {
  // biome-ignore lint: installing global stub
  (HTMLCanvasElement.prototype as any).transferControlToOffscreen = function (
    this: HTMLCanvasElement,
  ) {
    return new FakeOffscreenCanvas(this.width || 300, this.height || 150);
  };
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// biome-ignore lint: installing global stub
(globalThis as any).ResizeObserver = FakeResizeObserver;

/**
 * Call-recording IntersectionObserver stub. Happy-DOM ships no Intersection
 * observer, and the `pauseWhenOffscreen` path needs one. Tests drive
 * intersection changes via {@link triggerIntersection}. Live instances are
 * tracked so the global afterEach can drop stale ones between tests.
 */
export interface FakeIntersectionEntry {
  target: Element;
  isIntersecting: boolean;
}
const fakeIntersectionObservers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
  readonly callback: (entries: FakeIntersectionEntry[]) => void;
  readonly options: IntersectionObserverInit | undefined;
  readonly elements = new Set<Element>();
  disconnected = false;
  constructor(
    callback: (entries: FakeIntersectionEntry[]) => void,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.options = options;
    fakeIntersectionObservers.push(this);
  }
  observe(el: Element): void {
    this.elements.add(el);
  }
  unobserve(el: Element): void {
    this.elements.delete(el);
  }
  disconnect(): void {
    this.elements.clear();
    this.disconnected = true;
  }
  takeRecords(): [] {
    return [];
  }
}
// biome-ignore lint: installing global stub
(globalThis as any).IntersectionObserver = FakeIntersectionObserver;

/**
 * Fire an intersection change for `el` on every live observer watching it.
 * With `foreignTarget`, delivers an entry whose target was never observed by
 * that observer (exercises the "callback for an unregistered element" guard).
 */
export function triggerIntersection(
  el: Element,
  isIntersecting: boolean,
  opts?: { foreignTarget?: Element },
): void {
  for (const io of fakeIntersectionObservers) {
    if (io.disconnected || !io.elements.has(el)) continue;
    io.callback([{ target: opts?.foreignTarget ?? el, isIntersecting }]);
  }
}

/** Test seam: live (non-disconnected) fake IntersectionObserver instances. */
export function liveIntersectionObservers(): FakeIntersectionObserver[] {
  return fakeIntersectionObservers.filter((io) => !io.disconnected);
}

export interface LabelDraw {
  text: string;
  x: number;
  y: number;
}

/**
 * Label blits recorded on a FakeCtx. `x` is the raw blit dx (align-dependent;
 * rarely asserted); `y` is the RECONSTRUCTED ANCHOR y (`dy + sprite yAnchor`)
 * — exactly the y the call site passed, for integer anchors at dpr 1 (sprite
 * cssH is forced even, so anchors are integral). Non-label drawImage calls
 * (heatmap blits etc.) are filtered out via the sprite meta WeakMap.
 */
export function labelDraws(ctx: FakeCtx): LabelDraw[] {
  return ctx.calls
    .filter((c) => c.name === "drawImage")
    .flatMap((c) => {
      const m = labelMetaOf(c.args[0] as object);
      return m
        ? [{ text: m.text, x: c.args[1] as number, y: (c.args[2] as number) + m.yAnchor }]
        : [];
    });
}
