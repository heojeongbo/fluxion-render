import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeResize, onDprChange, resetResizeObserver } from "./resize-observer";

// Capturing stubs: one RO dispatcher + a matchMedia whose change handler we can fire.
let roCb: ((entries: unknown[]) => void) | null;
let disconnectCount: number;
let mediaChange: (() => void) | null;
const removeSpy = vi.fn();
const realRO = globalThis.ResizeObserver;
const realMM = window.matchMedia;

beforeEach(() => {
  roCb = null;
  disconnectCount = 0;
  mediaChange = null;
  removeSpy.mockClear();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: (entries: unknown[]) => void) {
      roCb = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {
      disconnectCount++;
    }
  };
  window.matchMedia = vi.fn().mockImplementation(() => ({
    addEventListener: (_t: string, cb: () => void) => {
      mediaChange = cb;
    },
    removeEventListener: removeSpy,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  resetResizeObserver();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
  window.matchMedia = realMM;
});

function el(): Element {
  return document.createElement("div");
}

describe("shared resize-observer", () => {
  it("shares one observer, demuxes by target, and disconnects when empty", () => {
    const a = el();
    const b = el();
    const ca = vi.fn();
    const cb = vi.fn();
    const stopA = observeResize(a, ca);
    const stopB = observeResize(b, cb);

    roCb!([{ target: a, contentRect: { width: 10, height: 20 } }]);
    expect(ca).toHaveBeenCalledWith({ width: 10, height: 20 });
    expect(cb).not.toHaveBeenCalled();

    // An entry for an unregistered target is ignored (defensive `if (fn)`).
    roCb!([{ target: el(), contentRect: { width: 1, height: 1 } }]);

    stopA();
    expect(disconnectCount).toBe(0); // b still observed
    expect(() => stopA()).not.toThrow(); // double-unobserve is a no-op
    stopB();
    expect(disconnectCount).toBe(1); // last one out disconnects
  });

  it("fans a dpr change out to all subscribers and re-subscribes; unsubscribe is idempotent", () => {
    const c1 = vi.fn();
    const c2 = vi.fn();
    const stop1 = onDprChange(c1);
    onDprChange(c2);

    mediaChange!(); // dpr changed
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalled(); // stale (resolution: Xdppx) listener dropped

    stop1();
    expect(() => stop1()).not.toThrow(); // double-unsubscribe is a no-op
  });

  it("resetResizeObserver clears observers and watchers", () => {
    observeResize(el(), vi.fn());
    onDprChange(vi.fn());
    resetResizeObserver();
    // A fresh observe after reset re-creates the singleton (new roCb).
    roCb = null;
    observeResize(el(), vi.fn());
    expect(roCb).toBeTypeOf("function");
  });
});
