import { act, render } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { darkTheme, FluxionThemeProvider } from "../../../features/theme";
import { resetLifecycleScheduler } from "../../../shared/lib/lifecycle-scheduler";
import { Op } from "../../../shared/protocol";
import { FluxionCanvas, type FluxionCanvasHandle } from "./fluxion-canvas";

interface RecordedPost {
  msg: unknown;
  transfer?: Transferable[];
}

function makeFakeWorkerFactory() {
  const posts: RecordedPost[] = [];
  const terminate = vi.fn();
  const factory = () =>
    ({
      postMessage: (msg: unknown, transfer?: Transferable[]) => {
        posts.push({ msg, transfer });
      },
      terminate,
      onmessage: null,
      onerror: null,
    }) as unknown as Worker;
  return { factory, posts, terminate };
}

describe("FluxionCanvas", () => {
  it("mounts, creates a host, and forwards the initial layer list", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const handleRef = createRef<FluxionCanvasHandle>();
    render(
      <FluxionCanvas
        ref={handleRef}
        hostOptions={{ workerFactory: factory }}
        staggerMount={false}
        layers={[
          { id: "axis", kind: "axis-grid", config: { xRange: [0, 1] } },
          { id: "line", kind: "line", config: { color: "#0ff" } },
        ]}
      />,
    );
    // Messages: INIT + 2× ADD_LAYER
    const ops = posts.map((p) => (p.msg as { op: number }).op);
    expect(ops).toContain(Op.INIT);
    expect(ops.filter((o) => o === Op.ADD_LAYER)).toHaveLength(2);
    expect(handleRef.current?.getHost()).not.toBeNull();
  });

  it("terminates the worker on unmount", () => {
    const { factory, terminate } = makeFakeWorkerFactory();
    const { unmount } = render(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        staggerMount={false}
        layers={[{ id: "axis", kind: "axis-grid" }]}
      />,
    );
    unmount();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("survives React StrictMode double-invoke (fresh canvas per mount)", () => {
    // Regression: transferControlToOffscreen is one-shot per canvas.
    // StrictMode mounts -> unmounts -> remounts the same component in dev,
    // so the widget must allocate a fresh <canvas> on each mount.
    const { factory, terminate } = makeFakeWorkerFactory();
    expect(() =>
      render(
        <StrictMode>
          <FluxionCanvas
            hostOptions={{ workerFactory: factory }}
            staggerMount={false}
            layers={[{ id: "axis", kind: "axis-grid" }]}
          />
        </StrictMode>,
      ),
    ).not.toThrow();
    // First host was disposed on StrictMode cleanup, second is live.
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("calls onReady with the host after mount", () => {
    const { factory } = makeFakeWorkerFactory();
    const onReady = vi.fn();
    render(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        staggerMount={false}
        layers={[]}
        onReady={onReady}
      />,
    );
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("defers host creation by default (staggerMount on) until a frame passes", () => {
    vi.useFakeTimers();
    resetLifecycleScheduler();
    const { factory } = makeFakeWorkerFactory();
    const onReady = vi.fn();
    render(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        layers={[{ id: "axis", kind: "axis-grid" }]}
        onReady={onReady}
      />,
    );
    expect(onReady).not.toHaveBeenCalled(); // queued, not yet created
    act(() => vi.advanceTimersByTime(20));
    expect(onReady).toHaveBeenCalledTimes(1);
    resetLifecycleScheduler();
    vi.useRealTimers();
  });

  it("renders a single div container when externalAxes is false", () => {
    const { factory } = makeFakeWorkerFactory();
    const { container } = render(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        layers={[]}
        externalAxes={false}
      />,
    );
    expect(container.querySelectorAll("div")).toHaveLength(1);
  });

  it("renders a single div container in inlineAxes mode (no axis canvases)", () => {
    const { factory } = makeFakeWorkerFactory();
    const { container } = render(
      <FluxionCanvas hostOptions={{ workerFactory: factory }} layers={[]} inlineAxes />,
    );
    expect(container.querySelectorAll("div")).toHaveLength(1);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("collapses the external-axes x-axis row when xAxisHeight is 0", () => {
    const { factory } = makeFakeWorkerFactory();
    const { container } = render(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        layers={[{ id: "axis", kind: "axis-grid" }]}
        // externalAxes default (true) → exercises the grid-layout ternary.
        axisLayerId="axis"
        xAxisHeight={0}
      />,
    );
    // xAxisHeight 0 → `xAxisHeight > 0 ? "1fr Npx" : "1fr"` takes the false arm.
    expect(container.firstChild).not.toBeNull();
  });

  it("re-themes the external axis live when the axisColor prop changes (no remount)", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { rerender } = render(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        staggerMount={false}
        layers={[{ id: "axis", kind: "axis-grid" }]}
        axisColor="#666666"
      />,
    );
    posts.length = 0;
    rerender(
      <FluxionCanvas
        hostOptions={{ workerFactory: factory }}
        staggerMount={false}
        layers={[{ id: "axis", kind: "axis-grid" }]}
        axisColor="#e6e6e6"
      />,
    );
    const axis = posts.find((p) => (p.msg as { op: number }).op === Op.SET_AXIS_STYLE);
    expect(axis).toBeDefined();
    expect((axis!.msg as { color: string }).color).toBe("#e6e6e6");
    // No new INIT — a theme flip must not tear the chart down.
    expect(posts.map((p) => (p.msg as { op: number }).op)).not.toContain(Op.INIT);
    resetLifecycleScheduler();
  });

  it("a provider theme's axisStyle survives the component's own axis props", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    // The component always builds an `axisStyle` object from its axis* props.
    // With none passed every field is `undefined` — and a shallow merge would
    // let that empty object REPLACE the provider's axisStyle, so the worker
    // would keep its built-in #666 and a light/dark toggle would only ever
    // change bgColor.
    render(
      <FluxionThemeProvider defaultMode="dark">
        <FluxionCanvas
          hostOptions={{ workerFactory: factory }}
          staggerMount={false}
          layers={[{ id: "axis", kind: "axis-grid" }]}
        />
      </FluxionThemeProvider>,
    );
    const axis = posts.find((p) => (p.msg as { op: number }).op === Op.SET_AXIS_STYLE);
    expect(axis?.msg).toMatchObject(darkTheme.axisStyle!);
    resetLifecycleScheduler();
  });

  it("an explicit axis prop still wins over the provider theme", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    render(
      <FluxionThemeProvider defaultMode="dark">
        <FluxionCanvas
          hostOptions={{ workerFactory: factory }}
          staggerMount={false}
          layers={[{ id: "axis", kind: "axis-grid" }]}
          axisColor="#ff00ff"
        />
      </FluxionThemeProvider>,
    );
    const axis = posts.find((p) => (p.msg as { op: number }).op === Op.SET_AXIS_STYLE);
    // Per-chart prop overrides the theme's color, but the theme's other axis
    // fields (bgColor) must still come through.
    expect(axis?.msg).toMatchObject({
      color: "#ff00ff",
      bgColor: darkTheme.axisStyle!.bgColor!,
    });
    resetLifecycleScheduler();
  });
});
