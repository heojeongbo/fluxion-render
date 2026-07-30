import { describe, expect, it, vi } from "vitest";
import type { Layer } from "../../../shared/model/layer";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx } from "../../../test/setup";
import { LayerStack } from "./layer-stack";

function makeStubLayer(id: string): Layer & { _draw: ReturnType<typeof vi.fn> } {
  const draw = vi.fn();
  return {
    id,
    _draw: draw,
    setConfig: vi.fn(),
    setData: vi.fn() as unknown as Layer["setData"],
    resize: vi.fn(),
    draw,
    dispose: vi.fn(),
  };
}

describe("LayerStack", () => {
  it("add + get + remove", () => {
    const stack = new LayerStack();
    const a = makeStubLayer("a");
    stack.add(a);
    expect(stack.get("a")).toBe(a);
    stack.remove("a");
    expect(stack.get("a")).toBeUndefined();
    expect(a.dispose).toHaveBeenCalled();
  });

  it("removing an unknown id is a no-op", () => {
    const stack = new LayerStack();
    expect(() => stack.remove("missing")).not.toThrow();
  });

  it("drawAll preserves insertion order", () => {
    const stack = new LayerStack();
    const order: string[] = [];
    const a: Layer = {
      id: "a",
      setConfig() {},
      setData(_b: ArrayBuffer, _l: number, _v: Viewport) {},
      resize() {},
      draw: () => order.push("a"),
      dispose() {},
    };
    const b: Layer = {
      id: "b",
      setConfig() {},
      setData(_b: ArrayBuffer, _l: number, _v: Viewport) {},
      resize() {},
      draw: () => order.push("b"),
      dispose() {},
    };
    const c: Layer = {
      id: "c",
      setConfig() {},
      setData(_b: ArrayBuffer, _l: number, _v: Viewport) {},
      resize() {},
      draw: () => order.push("c"),
      dispose() {},
    };
    stack.add(a);
    stack.add(b);
    stack.add(c);
    stack.drawAll(
      createFakeCtx() as unknown as OffscreenCanvasRenderingContext2D,
      new Viewport(),
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("resizeAll propagates to every layer", () => {
    const stack = new LayerStack();
    const a = makeStubLayer("a");
    const b = makeStubLayer("b");
    stack.add(a);
    stack.add(b);
    const v = new Viewport();
    stack.resizeAll(v);
    expect(a.resize).toHaveBeenCalledWith(v);
    expect(b.resize).toHaveBeenCalledWith(v);
  });

  it("scanAll calls scan on layers that implement it (insertion order)", () => {
    const stack = new LayerStack();
    const order: string[] = [];
    const withScan: Layer = {
      id: "a",
      setConfig() {},
      setData(_b, _l, _v) {},
      resize() {},
      scan: () => order.push("a"),
      draw() {},
      dispose() {},
    };
    const noScan: Layer = {
      id: "b",
      setConfig() {},
      setData(_b, _l, _v) {},
      resize() {},
      draw() {},
      dispose() {},
    };
    const withScan2: Layer = {
      id: "c",
      setConfig() {},
      setData(_b, _l, _v) {},
      resize() {},
      scan: () => order.push("c"),
      draw() {},
      dispose() {},
    };
    stack.add(withScan);
    stack.add(noScan);
    stack.add(withScan2);
    stack.scanAll(new Viewport());
    // noScan is skipped (optional), scan order follows insertion order
    expect(order).toEqual(["a", "c"]);
  });

  it("disposeAll clears state and calls dispose on each layer", () => {
    const stack = new LayerStack();
    const a = makeStubLayer("a");
    const b = makeStubLayer("b");
    stack.add(a);
    stack.add(b);
    stack.disposeAll();
    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalled();
    expect(stack.get("a")).toBeUndefined();
    expect(stack.get("b")).toBeUndefined();
  });

  it("drawGlAll draws layers with a GL path and reports the rest", () => {
    const stack = new LayerStack();
    const drawGl = vi.fn();
    const glLayer = {
      id: "gl",
      setConfig() {},
      setData() {},
      resize() {},
      draw() {},
      drawGl,
      dispose() {},
    } as unknown as Layer;
    const plainLayer = {
      id: "plain",
      setConfig() {},
      setData() {},
      resize() {},
      draw() {},
      dispose() {},
    } as unknown as Layer;
    stack.add(glLayer);
    stack.add(plainLayer);

    const glr = {} as never;
    const viewport = {} as never;
    const onUnsupported = vi.fn();
    stack.drawGlAll(glr, viewport, onUnsupported);
    expect(drawGl).toHaveBeenCalledWith(glr, viewport);
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    expect(onUnsupported.mock.calls[0]![0]).toBe(plainLayer);
  });
});
