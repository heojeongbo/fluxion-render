import { afterEach, describe, expect, it, vi } from "vitest";
import { liveIntersectionObservers, triggerIntersection } from "../../test/setup";
import {
  configureOnScreenObserver,
  observeOnScreen,
  resetOnScreenObserver,
} from "./onscreen-observer";

function div(): HTMLDivElement {
  return document.createElement("div");
}

describe("onscreen-observer", () => {
  afterEach(() => {
    resetOnScreenObserver();
  });

  it("reports intersection changes to the callback", () => {
    const el = div();
    const cb = vi.fn();
    observeOnScreen(el, cb);
    triggerIntersection(el, true);
    triggerIntersection(el, false);
    expect(cb.mock.calls).toEqual([[true], [false]]);
  });

  it("shares ONE observer across elements with the same config", () => {
    const a = div();
    const b = div();
    observeOnScreen(a, vi.fn());
    observeOnScreen(b, vi.fn());
    expect(liveIntersectionObservers()).toHaveLength(1);
  });

  it("routes each element's entry to its own callback", () => {
    const a = div();
    const b = div();
    const ca = vi.fn();
    const cb = vi.fn();
    observeOnScreen(a, ca);
    observeOnScreen(b, cb);
    triggerIntersection(a, false);
    expect(ca).toHaveBeenCalledWith(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores an entry whose target was never registered (defensive guard)", () => {
    const el = div();
    const foreign = div();
    const cb = vi.fn();
    observeOnScreen(el, cb);
    // The observer fires an entry for an element it isn't tracking a cb for.
    triggerIntersection(el, true, { foreignTarget: foreign });
    expect(cb).not.toHaveBeenCalled();
  });

  it("unobserve stops callbacks and disconnects the observer when empty", () => {
    const a = div();
    const b = div();
    const ca = vi.fn();
    const stopA = observeOnScreen(a, ca);
    observeOnScreen(b, vi.fn());
    expect(liveIntersectionObservers()).toHaveLength(1);

    stopA();
    triggerIntersection(a, false);
    expect(ca).not.toHaveBeenCalled(); // no longer observed
    expect(liveIntersectionObservers()).toHaveLength(1); // b still there

    // Double unobserve is a no-op (owner already gone).
    expect(() => stopA()).not.toThrow();
  });

  it("disconnects the shared observer once its last element unregisters", () => {
    const el = div();
    const stop = observeOnScreen(el, vi.fn());
    expect(liveIntersectionObservers()).toHaveLength(1);
    stop();
    expect(liveIntersectionObservers()).toHaveLength(0);
  });

  it("uses a distinct observer per (root, rootMargin) config", () => {
    const root = div();
    observeOnScreen(div(), vi.fn()); // viewport, default margin
    observeOnScreen(div(), vi.fn(), { rootMargin: "50px" }); // different margin
    observeOnScreen(div(), vi.fn(), { root }); // different root
    expect(liveIntersectionObservers()).toHaveLength(3);
  });

  it("passes the resolved root/rootMargin to the IntersectionObserver", () => {
    const root = div();
    observeOnScreen(div(), vi.fn(), { root, rootMargin: "123px" });
    const io = liveIntersectionObservers()[0]!;
    expect(io.options).toMatchObject({ root, rootMargin: "123px" });
  });

  it("configureOnScreenObserver sets process-wide defaults", () => {
    const root = div();
    configureOnScreenObserver({ root, rootMargin: "42px" });
    observeOnScreen(div(), vi.fn());
    const io = liveIntersectionObservers()[0]!;
    expect(io.options).toMatchObject({ root, rootMargin: "42px" });
  });

  it("configureOnScreenObserver merges: rootMargin-only keeps the default root", () => {
    observeOnScreen(div(), vi.fn()); // default: viewport root, 200px
    const first = liveIntersectionObservers()[0]!;
    expect(first.options).toMatchObject({ root: null, rootMargin: "200px" });
  });

  it("resetOnScreenObserver disconnects observers and restores defaults", () => {
    configureOnScreenObserver({ rootMargin: "999px" });
    observeOnScreen(div(), vi.fn());
    expect(liveIntersectionObservers()).toHaveLength(1);

    resetOnScreenObserver();
    expect(liveIntersectionObservers()).toHaveLength(0);

    // Defaults restored: next observer uses the built-in 200px again.
    observeOnScreen(div(), vi.fn());
    expect(liveIntersectionObservers()[0]!.options).toMatchObject({
      rootMargin: "200px",
    });
  });

  it("falls back to always-on-screen when IntersectionObserver is unavailable", () => {
    const g = globalThis as { IntersectionObserver?: unknown };
    const real = g.IntersectionObserver;
    g.IntersectionObserver = undefined;
    try {
      const cb = vi.fn();
      const stop = observeOnScreen(div(), cb);
      expect(cb).toHaveBeenCalledWith(true); // renders normally without an observer
      expect(() => stop()).not.toThrow(); // no-op unobserve
      expect(liveIntersectionObservers()).toHaveLength(0);
    } finally {
      g.IntersectionObserver = real;
    }
  });
});
