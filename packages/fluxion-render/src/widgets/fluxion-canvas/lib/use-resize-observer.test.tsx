import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ResizeInfo, useResizeObserver } from "./use-resize-observer";

describe("useResizeObserver", () => {
  let roCb: ((entries: unknown[]) => void) | null;
  let observed: Element | null;
  let disconnected: boolean;
  let mqlChange: (() => void) | null;
  let removeChangeSpy: ReturnType<typeof vi.fn>;
  const realRO = globalThis.ResizeObserver;
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    roCb = null;
    observed = null;
    disconnected = false;
    mqlChange = null;
    removeChangeSpy = vi.fn();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(cb: (entries: unknown[]) => void) {
        roCb = cb;
      }
      observe(el: Element) {
        observed = el;
      }
      unobserve() {}
      disconnect() {
        disconnected = true;
      }
    };
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      addEventListener: (_t: string, cb: () => void) => {
        mqlChange = cb;
      },
      removeEventListener: removeChangeSpy,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
    window.matchMedia = realMatchMedia;
  });

  function Harness({
    onResize,
    debounceMs,
  }: {
    onResize: (i: ResizeInfo) => void;
    debounceMs?: number;
  }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useResizeObserver(
      ref,
      onResize,
      debounceMs !== undefined ? { debounceMs } : undefined,
    );
    return <div ref={ref} style={{ width: 400, height: 300 }} />;
  }

  // The shared observer demuxes by entry.target, so deliver the observed element.
  const deliver = (w: number, h: number) =>
    roCb!([{ target: observed, contentRect: { width: w, height: h } }]);

  it("observes the element and subscribes to dpr on mount", () => {
    render(<Harness onResize={vi.fn()} />);
    expect(roCb).toBeTypeOf("function");
    expect(observed).not.toBeNull();
    expect(mqlChange).toBeTypeOf("function");
  });

  it("fires the first measurement from the observer entry — no getBoundingClientRect", () => {
    const onResize = vi.fn();
    render(<Harness onResize={onResize} />);
    expect(onResize).not.toHaveBeenCalled(); // nothing until the observer reports
    deliver(400, 300);
    expect(onResize).toHaveBeenCalledTimes(1);
    const info = onResize.mock.calls[0][0] as ResizeInfo;
    expect(info.width).toBe(400);
    expect(info.height).toBe(300);
    expect(info.dpr).toBeGreaterThan(0);
  });

  it("debounces subsequent observer callbacks into one fire with the latest size", () => {
    const onResize = vi.fn();
    render(<Harness onResize={onResize} debounceMs={100} />);
    deliver(400, 300); // first → immediate
    expect(onResize).toHaveBeenCalledTimes(1);
    onResize.mockClear();
    deliver(401, 301);
    deliver(402, 302);
    expect(onResize).not.toHaveBeenCalled(); // still pending
    vi.advanceTimersByTime(100);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect((onResize.mock.calls[0][0] as ResizeInfo).width).toBe(402);
  });

  it("re-fires (debounced) and re-subscribes the media query on a dpr change", () => {
    const onResize = vi.fn();
    render(<Harness onResize={onResize} debounceMs={100} />);
    deliver(400, 300);
    onResize.mockClear();
    mqlChange!();
    expect(removeChangeSpy).toHaveBeenCalled(); // old listener removed on re-subscribe
    vi.advanceTimersByTime(100);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("a dpr change before the first measurement does not fire", () => {
    const onResize = vi.fn();
    render(<Harness onResize={onResize} debounceMs={0} />);
    mqlChange!(); // no observer entry yet → not measured
    expect(onResize).not.toHaveBeenCalled();
  });

  it("fires immediately when debounceMs is 0 and falls back to dpr 1", () => {
    const realDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: 0, configurable: true });

    const onResize = vi.fn();
    const { unmount } = render(<Harness onResize={onResize} debounceMs={0} />);
    deliver(400, 300); // first
    expect(onResize).toHaveBeenCalledTimes(1);
    expect((onResize.mock.calls[0][0] as ResizeInfo).dpr).toBe(1);
    deliver(410, 310); // subsequent, no debounce → immediate
    expect(onResize).toHaveBeenCalledTimes(2);

    // After unmount the `cancelled` guard makes a late observer callback a no-op.
    unmount();
    expect(disconnected).toBe(true);
    onResize.mockClear();
    deliver(420, 320);
    expect(onResize).not.toHaveBeenCalled();

    if (realDpr) Object.defineProperty(window, "devicePixelRatio", realDpr);
  });

  it("does nothing when the ref is never attached to an element", () => {
    const onResize = vi.fn();
    function NoRefHarness() {
      const ref = useRef<HTMLDivElement | null>(null);
      useResizeObserver(ref, onResize);
      return <div />;
    }
    render(<NoRefHarness />);
    expect(roCb).toBeNull(); // effect bailed before creating an observer
    expect(onResize).not.toHaveBeenCalled();
  });

  it("does not throw when unmounted", () => {
    const { unmount } = render(<Harness onResize={vi.fn()} />);
    expect(() => unmount()).not.toThrow();
  });
});
