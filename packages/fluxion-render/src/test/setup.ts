/**
 * Global test environment stubs. Happy-DOM ships DOM + window but not the
 * browser graphics APIs that FluxionRender depends on (OffscreenCanvas,
 * transferControlToOffscreen, ResizeObserver). We patch enough of each to
 * exercise the host/worker/react surface without a real browser.
 */

import { afterEach } from "vitest";
import { resetFlushScheduler } from "../shared/lib/flush-scheduler";
import { labelMetaOf, resetLabelCache } from "../shared/lib/label-cache";
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

class FakeOffscreenCanvas {
  width: number;
  height: number;
  /** Records the most recent `getContext` options arg (for asserting `alpha` etc.). */
  contextOptions: unknown;
  private ctx: FakeCtx | null = null;
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  getContext(_type: string, options?: unknown): FakeCtx {
    this.contextOptions = options;
    if (!this.ctx) this.ctx = createFakeCtx();
    return this.ctx;
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
