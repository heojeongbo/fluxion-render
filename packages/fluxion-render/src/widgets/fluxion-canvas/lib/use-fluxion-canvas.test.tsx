import { act, render } from "@testing-library/react";
import { StrictMode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureFluxionDefaults,
  createHostRecyclePool,
  resetFluxionDefaults,
} from "../../../features/host";
import {
  configureLifecycleScheduler,
  flushLifecycleScheduler,
  resetLifecycleScheduler,
} from "../../../shared/lib/lifecycle-scheduler";
import { Op } from "../../../shared/protocol";
import { liveIntersectionObservers, triggerIntersection } from "../../../test/setup";
import { type FluxionLayerSpec, useFluxionCanvas } from "./use-fluxion-canvas";

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

function Harness({
  workerFactory,
  onHost,
  staggerMount = false,
}: {
  workerFactory: () => Worker;
  onHost?: (host: unknown) => void;
  staggerMount?: boolean;
}) {
  // Default `staggerMount: false` here so the mechanics tests below observe
  // synchronous host creation; the deferred default-on path is exercised in its
  // own describe block ("default staggered mount + dispose safety").
  const { containerRef, host } = useFluxionCanvas({
    layers: [
      { id: "axis", kind: "axis-grid" },
      { id: "line", kind: "line", config: { color: "#fff" } },
    ],
    hostOptions: { workerFactory },
    staggerMount,
  });
  useEffect(() => {
    if (host && onHost) onHost(host);
  }, [host, onHost]);
  return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
}

describe("useFluxionCanvas", () => {
  it("creates a host and posts INIT + 2 ADD_LAYER on mount", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    render(<Harness workerFactory={factory} />);
    const ops = posts.map((p) => (p.msg as { op: number }).op);
    expect(ops).toContain(Op.INIT);
    expect(ops.filter((o) => o === Op.ADD_LAYER)).toHaveLength(2);
  });

  it("exposes the live host via useState once mounted", () => {
    const { factory } = makeFakeWorkerFactory();
    const onHost = vi.fn();
    render(<Harness workerFactory={factory} onHost={onHost} />);
    expect(onHost).toHaveBeenCalled();
    // host arg must not be null once delivered
    expect(onHost.mock.calls[0][0]).not.toBeNull();
  });

  it("terminates the worker on unmount", () => {
    const { factory, terminate } = makeFakeWorkerFactory();
    const { unmount } = render(<Harness workerFactory={factory} />);
    unmount();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("survives StrictMode double-invoke with a fresh canvas each mount", () => {
    const { factory, terminate } = makeFakeWorkerFactory();
    expect(() =>
      render(
        <StrictMode>
          <Harness workerFactory={factory} />
        </StrictMode>,
      ),
    ).not.toThrow();
    // StrictMode disposes the first host; the second (live) host is still mounted.
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  describe("layer-config reconciliation", () => {
    function ConfigHarness({
      workerFactory,
      layers,
    }: {
      workerFactory: () => Worker;
      layers: FluxionLayerSpec[];
    }) {
      const { containerRef } = useFluxionCanvas({
        layers,
        hostOptions: { workerFactory },
        staggerMount: false, // exercise reconciliation against a synchronously-created host
      });
      return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
    }

    const configPosts = (posts: RecordedPost[]) =>
      posts.filter((p) => (p.msg as { op: number }).op === Op.CONFIG);

    it("mount does not re-send configs already applied via addLayer", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      render(
        <ConfigHarness
          workerFactory={factory}
          layers={[
            { id: "axis", kind: "axis-grid" },
            { id: "line", kind: "line", config: { color: "#fff" } },
          ]}
        />,
      );
      expect(configPosts(posts)).toHaveLength(0);
    });

    it("changing a layer's config in a new layers array posts CONFIG for only that layer", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { rerender } = render(
        <ConfigHarness
          workerFactory={factory}
          layers={[
            { id: "axis", kind: "axis-grid", config: { xMode: "fixed" } },
            { id: "line", kind: "line", config: { color: "#fff" } },
          ]}
        />,
      );
      rerender(
        <ConfigHarness
          workerFactory={factory}
          layers={[
            { id: "axis", kind: "axis-grid", config: { xMode: "fixed" } },
            { id: "line", kind: "line", config: { color: "#f00" } },
          ]}
        />,
      );
      const configs = configPosts(posts);
      expect(configs).toHaveLength(1);
      expect(configs[0]!.msg).toMatchObject({
        op: Op.CONFIG,
        id: "line",
        config: { color: "#f00" },
      });
    });

    it("identical config content in a new array reference is not re-sent", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { rerender } = render(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "line", kind: "line", config: { color: "#fff" } }]}
        />,
      );
      // Fresh array + fresh config objects, structurally identical.
      rerender(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "line", kind: "line", config: { color: "#fff" } }]}
        />,
      );
      expect(configPosts(posts)).toHaveLength(0);
    });
  });

  describe("structural reconciliation", () => {
    function ConfigHarness({
      workerFactory,
      layers,
    }: {
      workerFactory: () => Worker;
      layers: FluxionLayerSpec[];
    }) {
      const { containerRef } = useFluxionCanvas({
        layers,
        hostOptions: { workerFactory },
        staggerMount: false, // exercise reconciliation against a synchronously-created host
      });
      return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
    }

    const opsOf = (posts: RecordedPost[], op: number) =>
      posts.filter((p) => (p.msg as { op: number }).op === op);

    it("posts ADD_LAYER when a layer is added without a remount", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { rerender } = render(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "axis", kind: "axis-grid" }]}
        />,
      );
      const before = opsOf(posts, Op.ADD_LAYER).length;
      rerender(
        <ConfigHarness
          workerFactory={factory}
          layers={[
            { id: "axis", kind: "axis-grid" },
            { id: "line", kind: "line", config: { color: "#fff" } },
          ]}
        />,
      );
      const added = opsOf(posts, Op.ADD_LAYER);
      expect(added.length).toBe(before + 1);
      expect(added.at(-1)!.msg).toMatchObject({
        op: Op.ADD_LAYER,
        id: "line",
        kind: "line",
      });
    });

    it("posts REMOVE_LAYER when a layer is dropped", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { rerender } = render(
        <ConfigHarness
          workerFactory={factory}
          layers={[
            { id: "axis", kind: "axis-grid" },
            { id: "line", kind: "line", config: { color: "#fff" } },
          ]}
        />,
      );
      rerender(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "axis", kind: "axis-grid" }]}
        />,
      );
      const removed = opsOf(posts, Op.REMOVE_LAYER);
      expect(removed).toHaveLength(1);
      expect(removed[0]!.msg).toMatchObject({ op: Op.REMOVE_LAYER, id: "line" });
    });

    it("swaps a layer (REMOVE + ADD) when its kind changes", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { rerender } = render(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "chart", kind: "line", config: { color: "#fff" } }]}
        />,
      );
      const addBefore = opsOf(posts, Op.ADD_LAYER).length;
      rerender(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "chart", kind: "area", config: { color: "#fff" } }]}
        />,
      );
      expect(opsOf(posts, Op.REMOVE_LAYER).at(-1)!.msg).toMatchObject({ id: "chart" });
      const lastAdd = opsOf(posts, Op.ADD_LAYER).at(-1)!.msg;
      expect(opsOf(posts, Op.ADD_LAYER).length).toBe(addBefore + 1);
      expect(lastAdd).toMatchObject({ op: Op.ADD_LAYER, id: "chart", kind: "area" });
    });

    it("does not touch structure when only configs change", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { rerender } = render(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "line", kind: "line", config: { color: "#fff" } }]}
        />,
      );
      const adds = opsOf(posts, Op.ADD_LAYER).length;
      rerender(
        <ConfigHarness
          workerFactory={factory}
          layers={[{ id: "line", kind: "line", config: { color: "#f00" } }]}
        />,
      );
      expect(opsOf(posts, Op.ADD_LAYER).length).toBe(adds);
      expect(opsOf(posts, Op.REMOVE_LAYER)).toHaveLength(0);
    });
  });

  it("defers when the pool is disposed, then mounts once it is replaced (mountKey bump)", () => {
    // StrictMode race: the first mount effect sees a disposed pool, bumps
    // mountKey and bails; the mountKey-driven re-run sees a live pool and mounts.
    // Flip isDisposed false after the first read so the retry settles (otherwise
    // setMountKey would loop forever).
    const { factory } = makeFakeWorkerFactory();
    let disposed = true;
    const pool = {
      get isDisposed() {
        const v = disposed;
        disposed = false;
        return v;
      },
      acquire: () => factory(),
    } as never;
    function PoolHarness() {
      const { containerRef } = useFluxionCanvas({
        layers: [{ id: "axis", kind: "axis-grid" }],
        hostOptions: { pool },
        staggerMount: false,
      });
      return <div ref={containerRef} />;
    }
    expect(() => render(<PoolHarness />)).not.toThrow();
  });

  describe("staggerMount", () => {
    function StaggerHarness({
      workerFactory,
      onHost,
    }: {
      workerFactory: () => Worker;
      onHost?: (host: unknown) => void;
    }) {
      const { containerRef, host } = useFluxionCanvas({
        layers: [
          { id: "axis", kind: "axis-grid" },
          { id: "line", kind: "line", config: { color: "#fff" } },
        ],
        hostOptions: { workerFactory },
        staggerMount: true,
      });
      useEffect(() => {
        if (host && onHost) onHost(host);
      }, [host, onHost]);
      return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
    }

    beforeEach(() => {
      resetLifecycleScheduler(); // isolate from any task another test left queued
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      resetLifecycleScheduler();
    });

    it("defers host creation to a later frame", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const onHost = vi.fn();
      render(<StaggerHarness workerFactory={factory} onHost={onHost} />);
      // Host creation is queued — nothing posted, no host yet.
      expect(posts).toHaveLength(0);
      expect(onHost).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(20); // drain one frame
      });
      const ops = posts.map((p) => (p.msg as { op: number }).op);
      expect(ops).toContain(Op.INIT);
      expect(onHost).toHaveBeenCalled();
    });

    it("cancels the queued creation if unmounted before its frame", () => {
      const { factory, posts, terminate } = makeFakeWorkerFactory();
      const { unmount } = render(<StaggerHarness workerFactory={factory} />);
      expect(posts).toHaveLength(0); // not created yet
      unmount(); // before the drain frame
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(posts).toHaveLength(0); // host never created
      expect(terminate).not.toHaveBeenCalled(); // nothing to tear down
    });
  });

  describe("default staggered mount + dispose safety", () => {
    // No `staggerMount` here → exercises the library DEFAULT (deferred).
    function DefaultHarness({
      workerFactory,
      onHost,
    }: {
      workerFactory: () => Worker;
      onHost?: (host: unknown) => void;
    }) {
      const { containerRef, host } = useFluxionCanvas({
        layers: [
          { id: "axis", kind: "axis-grid" },
          { id: "line", kind: "line", config: { color: "#fff" } },
        ],
        hostOptions: { workerFactory },
      });
      useEffect(() => {
        if (host && onHost) onHost(host);
      }, [host, onHost]);
      return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
    }

    beforeEach(() => {
      resetLifecycleScheduler();
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      resetLifecycleScheduler();
      configureLifecycleScheduler({ perFrame: 4 }); // restore default for other suites
    });

    it("defers host creation by default (no staggerMount prop)", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const onHost = vi.fn();
      render(<DefaultHarness workerFactory={factory} onHost={onHost} />);
      // Queued — nothing created until the frame drains.
      expect(posts).toHaveLength(0);
      expect(onHost).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(20));
      const ops = posts.map((p) => (p.msg as { op: number }).op);
      expect(ops).toContain(Op.INIT);
      expect(ops.filter((o) => o === Op.ADD_LAYER)).toHaveLength(2);
      expect(onHost).toHaveBeenCalled();
    });

    it("defers the host teardown on unmount, then disposes on a later frame", () => {
      const { factory, terminate } = makeFakeWorkerFactory();
      const { unmount } = render(<DefaultHarness workerFactory={factory} />);
      act(() => vi.advanceTimersByTime(20)); // host created
      unmount();
      // Teardown is staggered too — not run synchronously in the unmount commit.
      expect(terminate).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(20)); // drain the deferred dispose
      expect(terminate).toHaveBeenCalledTimes(1);
    });

    it("creates no host (leaks nothing) when unmounted before its frame", () => {
      const { factory, posts, terminate } = makeFakeWorkerFactory();
      const { unmount } = render(<DefaultHarness workerFactory={factory} />);
      unmount(); // before the drain frame
      act(() => vi.advanceTimersByTime(20));
      expect(posts).toHaveLength(0);
      expect(terminate).not.toHaveBeenCalled();
    });

    it("rapid mount/unmount churn before the frame creates no hosts", () => {
      const { factory, posts, terminate } = makeFakeWorkerFactory();
      for (let i = 0; i < 5; i++) {
        const { unmount } = render(<DefaultHarness workerFactory={factory} />);
        unmount();
      }
      act(() => vi.advanceTimersByTime(20));
      expect(posts).toHaveLength(0);
      expect(terminate).not.toHaveBeenCalled();
    });

    it("does not run a bulk unmount's teardown synchronously (the accordion-collapse fix)", () => {
      const fs = Array.from({ length: 6 }, () => makeFakeWorkerFactory());
      const Grid = () => (
        <>
          {fs.map((f, i) => (
            <DefaultHarness key={i} workerFactory={f.factory} />
          ))}
        </>
      );
      const { unmount } = render(<Grid />);
      act(() => vi.advanceTimersByTime(200)); // drain all staggered mounts
      expect(fs.every((f) => f.posts.length > 0)).toBe(true); // all created

      const teardownCount = () =>
        fs.filter((f) => f.terminate.mock.calls.length > 0).length;

      unmount(); // 6 charts unmount in one commit
      expect(teardownCount()).toBe(0); // KEY: no synchronous teardown burst
      act(() => vi.advanceTimersByTime(200)); // drain the deferred disposes
      expect(teardownCount()).toBe(6); // all eventually torn down
    });
  });
});

describe("useFluxionCanvas host recycling", () => {
  function RecycleHarness({
    workerFactory,
    recyclePool,
    onHost,
    bgColor,
  }: {
    workerFactory: () => Worker;
    recyclePool: ReturnType<typeof createHostRecyclePool>;
    onHost?: (host: unknown) => void;
    bgColor?: string;
  }) {
    const { containerRef, host } = useFluxionCanvas({
      layers: [
        { id: "axis", kind: "axis-grid" },
        { id: "line", kind: "line", config: { color: "#fff" } },
      ],
      hostOptions: { workerFactory, bgColor },
      recyclePool,
      staggerMount: false,
    });
    useEffect(() => {
      if (host && onHost) onHost(host);
    }, [host, onHost]);
    return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
  }

  // Variant with external axis canvases, to exercise the axis re-parent path.
  function AxisRecycleHarness({
    workerFactory,
    recyclePool,
    onHost,
  }: {
    workerFactory: () => Worker;
    recyclePool: ReturnType<typeof createHostRecyclePool>;
    onHost?: (host: unknown) => void;
  }) {
    const xRef = useRef<HTMLDivElement>(null);
    const yRef = useRef<HTMLDivElement>(null);
    const { containerRef, host } = useFluxionCanvas({
      layers: [
        { id: "axis", kind: "axis-grid" },
        { id: "line", kind: "line", config: { color: "#fff" } },
      ],
      hostOptions: { workerFactory },
      recyclePool,
      staggerMount: false,
      xAxisContainerRef: xRef,
      yAxisContainerRef: yRef,
    });
    useEffect(() => {
      if (host && onHost) onHost(host);
    }, [host, onHost]);
    return (
      <div>
        <div ref={yRef} />
        <div ref={containerRef} style={{ width: 200, height: 100 }} />
        <div ref={xRef} />
      </div>
    );
  }

  const opsOf = (posts: RecordedPost[]) => posts.map((p) => (p.msg as { op: number }).op);
  const initCount = (posts: RecordedPost[]) =>
    opsOf(posts).filter((o) => o === Op.INIT).length;

  afterEach(() => {
    // Pool teardowns are deferred through the module-global lifecycle queue.
    resetLifecycleScheduler();
  });

  it("reuses a warm host on remount instead of creating a new one", () => {
    const { factory, posts, terminate } = makeFakeWorkerFactory();
    const pool = createHostRecyclePool();
    const hosts: unknown[] = [];
    const onHost = (h: unknown) => hosts.push(h);

    const first = render(
      <RecycleHarness
        workerFactory={factory}
        recyclePool={pool}
        onHost={onHost}
        bgColor="#101010"
      />,
    );
    expect(initCount(posts)).toBe(1);
    const firstHost = hosts[0];

    first.unmount();
    expect(terminate).not.toHaveBeenCalled(); // parked, not disposed
    expect(pool.size).toBe(1);

    posts.length = 0;
    const second = render(
      <RecycleHarness
        workerFactory={factory}
        recyclePool={pool}
        onHost={onHost}
        bgColor="#202020"
      />,
    );
    // Same host reused — no new worker INIT; layers re-hydrated, bg re-applied, resumed.
    expect(hosts[hosts.length - 1]).toBe(firstHost);
    expect(initCount(posts)).toBe(0);
    const ops = opsOf(posts);
    expect(ops.filter((o) => o === Op.ADD_LAYER)).toHaveLength(2);
    expect(ops).toContain(Op.SET_BG_COLOR);
    expect(ops).toContain(Op.RESIZE);
    expect(ops).toContain(Op.SET_VISIBLE);
    expect(pool.stats).toEqual({
      created: 1,
      recycled: 1,
      overflowDisposed: 0,
      highWater: 1,
      shrunk: 0,
    });

    second.unmount();
    pool.dispose();
  });

  it("re-parents axis canvases when recycling a host with external axes", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const pool = createHostRecyclePool();
    const hosts: unknown[] = [];
    const onHost = (h: unknown) => hosts.push(h);

    const first = render(
      <AxisRecycleHarness workerFactory={factory} recyclePool={pool} onHost={onHost} />,
    );
    expect(opsOf(posts)).toContain(Op.SET_AXIS_CANVAS); // axis transferred on cold create
    first.unmount();

    posts.length = 0;
    const second = render(
      <AxisRecycleHarness workerFactory={factory} recyclePool={pool} onHost={onHost} />,
    );
    expect(hosts[hosts.length - 1]).toBe(hosts[0]); // reused
    expect(initCount(posts)).toBe(0);
    // Axis canvases stay bound to the reused host — never re-transferred.
    expect(opsOf(posts)).not.toContain(Op.SET_AXIS_CANVAS);

    second.unmount();
    pool.dispose();
  });

  it("disposing the recycle pool tears down a parked host (deferred)", () => {
    const { factory, terminate } = makeFakeWorkerFactory();
    const pool = createHostRecyclePool();
    const { unmount } = render(
      <RecycleHarness workerFactory={factory} recyclePool={pool} />,
    );
    unmount();
    expect(terminate).not.toHaveBeenCalled(); // parked
    pool.dispose();
    expect(terminate).not.toHaveBeenCalled(); // teardown queued, not synchronous
    flushLifecycleScheduler();
    expect(terminate).toHaveBeenCalledTimes(1); // torn down with the pool
  });

  it("disposes the host (deferred) when the recycle pool is already disposed", () => {
    const { factory, terminate } = makeFakeWorkerFactory();
    const pool = createHostRecyclePool();
    const { unmount } = render(
      <RecycleHarness workerFactory={factory} recyclePool={pool} />,
    );
    pool.dispose(); // pool dies while the chart is still mounted
    unmount(); // cleanup sees a disposed pool → disposes the host instead of parking
    flushLifecycleScheduler();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("StrictMode double-invoke reuses the same host (one worker, none terminated)", () => {
    const { factory, posts, terminate } = makeFakeWorkerFactory();
    const pool = createHostRecyclePool();
    let result: ReturnType<typeof render> | undefined;
    expect(() => {
      result = render(
        <StrictMode>
          <RecycleHarness workerFactory={factory} recyclePool={pool} />
        </StrictMode>,
      );
    }).not.toThrow();
    // mount→unmount→mount: the first host is parked then reused.
    expect(initCount(posts)).toBe(1);
    expect(terminate).not.toHaveBeenCalled();
    result!.unmount(); // park the in-use host back
    pool.dispose();
    flushLifecycleScheduler(); // teardown is deferred through the frame queue
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

describe("useFluxionCanvas resize forwarding", () => {
  let roCb: ((entries: unknown[]) => void) | null;
  const realRO = globalThis.ResizeObserver;

  beforeEach(() => {
    roCb = null;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(cb: (entries: unknown[]) => void) {
        roCb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  afterEach(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
    resetLifecycleScheduler(); // drop any resize a test left pending
  });

  const deliver = (w: number, h: number) =>
    act(() => {
      roCb?.([{ contentRect: { width: w, height: h } }]);
    });

  const ops = (posts: RecordedPost[]) => posts.map((p) => (p.msg as { op: number }).op);

  it("defers a non-zero observer size through the resize lane (no sync RESIZE)", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    // staggerMount defaults to false in Harness → host created synchronously.
    render(<Harness workerFactory={factory} />);
    posts.length = 0;
    deliver(200, 100);
    // Not applied in the observer tick — a grid-wide layout change must not
    // reallocate every chart's backing in one frame.
    expect(ops(posts)).not.toContain(Op.RESIZE);
    flushLifecycleScheduler();
    expect(ops(posts)).toContain(Op.RESIZE);
  });

  it("a second delivery inside the debounce window adds no extra RESIZE", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    render(<Harness workerFactory={factory} />);
    posts.length = 0;
    deliver(200, 100); // first measurement emits immediately → one lane entry
    deliver(300, 150); // within the observer's 100ms debounce → no emit yet
    flushLifecycleScheduler();
    const resizes = posts.filter((p) => (p.msg as { op: number }).op === Op.RESIZE);
    expect(resizes).toHaveLength(1); // per-chart debounce + lane compose: one apply
    expect(resizes[0]!.msg).toMatchObject({ width: 200, height: 100 });
  });

  it("unmounting before the frame drops the pending resize", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { unmount } = render(<Harness workerFactory={factory} />);
    posts.length = 0;
    deliver(200, 100);
    unmount(); // cleanup cancels the scheduled resize for this host
    flushLifecycleScheduler();
    expect(ops(posts)).not.toContain(Op.RESIZE);
  });

  it("ignores a zero-sized observer entry", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    render(<Harness workerFactory={factory} />);
    posts.length = 0;
    deliver(0, 0);
    flushLifecycleScheduler();
    expect(ops(posts)).not.toContain(Op.RESIZE);
  });

  it("parking (recycle) also drops the pending resize — no stale RESIZE reaches a parked host", () => {
    function RecycleResizeHarness({
      workerFactory,
      recyclePool,
    }: {
      workerFactory: () => Worker;
      recyclePool: ReturnType<typeof createHostRecyclePool>;
    }) {
      const { containerRef } = useFluxionCanvas({
        layers: [{ id: "line", kind: "line" }],
        hostOptions: { workerFactory },
        recyclePool,
        staggerMount: false,
      });
      return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
    }
    const { factory, posts } = makeFakeWorkerFactory();
    const pool = createHostRecyclePool();
    const { unmount } = render(
      <RecycleResizeHarness workerFactory={factory} recyclePool={pool} />,
    );
    posts.length = 0;
    deliver(200, 100);
    // Unmount PARKS the host (alive, not disposed) — unlike the dispose path,
    // a stale resize here would really post and reallocate a parked backing.
    unmount();
    flushLifecycleScheduler();
    expect(ops(posts)).not.toContain(Op.RESIZE);
    pool.dispose();
  });

  it("N charts' simultaneous resize applies at most resizePerFrame per frame", () => {
    vi.useFakeTimers();
    try {
      configureLifecycleScheduler({ resizePerFrame: 1 });
      // Local RO stub that collects EVERY chart's callback (the describe-level
      // stub keeps only the last), so one layout change can hit all charts.
      const cbs: Array<(entries: unknown[]) => void> = [];
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        constructor(cb: (entries: unknown[]) => void) {
          cbs.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      const charts = Array.from({ length: 3 }, () => makeFakeWorkerFactory());
      render(
        <>
          {charts.map((c, i) => (
            <Harness key={i} workerFactory={c.factory} />
          ))}
        </>,
      );
      for (const c of charts) c.posts.length = 0;
      // One layout change fires every chart's observer in the same tick. Use a
      // size that DIFFERS from the INIT size (happy-dom getBoundingClientRect is
      // 0 → INIT falls back to 300×150), else the host's resize dedup correctly
      // skips a no-op resize and nothing would forward.
      act(() => {
        for (const cb of cbs) cb([{ contentRect: { width: 320, height: 160 } }]);
      });
      const resizeCount = () =>
        charts.reduce(
          (n, c) =>
            n + c.posts.filter((p) => (p.msg as { op: number }).op === Op.RESIZE).length,
          0,
        );
      expect(resizeCount()).toBe(0); // nothing in the observer tick
      act(() => vi.advanceTimersByTime(20));
      expect(resizeCount()).toBe(1); // budget: one chart per frame
      act(() => vi.advanceTimersByTime(20));
      expect(resizeCount()).toBe(2);
      act(() => vi.advanceTimersByTime(20));
      expect(resizeCount()).toBe(3); // all settle, none dropped
    } finally {
      vi.useRealTimers();
      configureLifecycleScheduler({ resizePerFrame: 8 });
    }
  });
});

describe("useFluxionCanvas theme reconcile (bgColor / axisStyle)", () => {
  function ThemeHarness({
    workerFactory,
    bgColor,
    axisStyle,
  }: {
    workerFactory: () => Worker;
    bgColor?: string;
    axisStyle?: { color?: string; tickSize?: number };
  }) {
    const { containerRef } = useFluxionCanvas({
      layers: [{ id: "line", kind: "line" }],
      hostOptions: { workerFactory, bgColor, axisStyle },
      staggerMount: false, // synchronous host so a rerender observes the reconcile
    });
    return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
  }

  const ops = (posts: RecordedPost[]) => posts.map((p) => (p.msg as { op: number }).op);

  it("re-sends SET_BG_COLOR on a bgColor change without a remount", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { rerender } = render(
      <ThemeHarness workerFactory={factory} bgColor="#ffffff" />,
    );
    expect(ops(posts)).toContain(Op.INIT); // initial bg went out with INIT
    posts.length = 0;
    rerender(<ThemeHarness workerFactory={factory} bgColor="#0b0d12" />);
    expect(ops(posts)).toContain(Op.SET_BG_COLOR); // theme flip applied live
    expect(ops(posts)).not.toContain(Op.INIT); // no remount
    const bg = posts.find((p) => (p.msg as { op: number }).op === Op.SET_BG_COLOR);
    expect((bg!.msg as { color: string }).color).toBe("#0b0d12");
  });

  it("does NOT re-send SET_BG_COLOR when bgColor is unchanged across a rerender", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { rerender } = render(
      <ThemeHarness workerFactory={factory} bgColor="#ffffff" />,
    );
    posts.length = 0;
    rerender(<ThemeHarness workerFactory={factory} bgColor="#ffffff" />);
    expect(ops(posts)).not.toContain(Op.SET_BG_COLOR); // seeded → no spam
  });

  it("re-sends SET_AXIS_STYLE on an axisStyle change without a remount", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { rerender } = render(
      <ThemeHarness workerFactory={factory} axisStyle={{ color: "#666666" }} />,
    );
    posts.length = 0;
    rerender(<ThemeHarness workerFactory={factory} axisStyle={{ color: "#e6e6e6" }} />);
    const axis = posts.find((p) => (p.msg as { op: number }).op === Op.SET_AXIS_STYLE);
    expect(axis).toBeDefined();
    expect((axis!.msg as { color: string }).color).toBe("#e6e6e6");
    expect(ops(posts)).not.toContain(Op.INIT); // no remount
  });

  it("does NOT re-send SET_AXIS_STYLE when the style is unchanged", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { rerender } = render(
      <ThemeHarness workerFactory={factory} axisStyle={{ color: "#666666" }} />,
    );
    posts.length = 0;
    rerender(<ThemeHarness workerFactory={factory} axisStyle={{ color: "#666666" }} />);
    expect(ops(posts)).not.toContain(Op.SET_AXIS_STYLE);
  });

  it("dropping axisStyle entirely posts nothing (there's no style to re-apply)", () => {
    const { factory, posts } = makeFakeWorkerFactory();
    const { rerender } = render(
      <ThemeHarness workerFactory={factory} axisStyle={{ color: "#666666" }} />,
    );
    posts.length = 0;
    // key changes ("{…}" → "null") but there is no style object to send.
    rerender(<ThemeHarness workerFactory={factory} axisStyle={undefined} />);
    expect(ops(posts)).not.toContain(Op.SET_AXIS_STYLE);
  });

  describe("pauseWhenOffscreen", () => {
    function PauseHarness({
      workerFactory,
      pauseWhenOffscreen = true,
      staggerMount = false,
      recyclePool,
    }: {
      workerFactory: () => Worker;
      pauseWhenOffscreen?: boolean;
      staggerMount?: boolean;
      recyclePool?: ReturnType<typeof createHostRecyclePool>;
    }) {
      const { containerRef } = useFluxionCanvas({
        layers: [{ id: "line", kind: "line", config: { color: "#fff" } }],
        hostOptions: { workerFactory },
        staggerMount,
        pauseWhenOffscreen,
        recyclePool,
      });
      return (
        <div ref={containerRef} data-testid="chart" style={{ width: 200, height: 100 }} />
      );
    }
    const onScreenPosts = (posts: RecordedPost[]) =>
      posts
        .filter((p) => (p.msg as { op: number }).op === Op.SET_ON_SCREEN)
        .map((p) => (p.msg as { onScreen: boolean }).onScreen);

    afterEach(() => {
      resetLifecycleScheduler();
    });

    it("forwards container intersection changes to host.setOnScreen", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { container, unmount } = render(<PauseHarness workerFactory={factory} />);
      const el = container.querySelector('[data-testid="chart"]')!;
      // Seed on create is optimistic (true); scrolling then drives the flag.
      act(() => triggerIntersection(el, false));
      act(() => triggerIntersection(el, true));
      expect(onScreenPosts(posts)).toEqual([true, false, true]);
      unmount();
    });

    it("registers no observer when the option is off", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { unmount } = render(
        <PauseHarness workerFactory={factory} pauseWhenOffscreen={false} />,
      );
      expect(liveIntersectionObservers()).toHaveLength(0);
      expect(onScreenPosts(posts)).toEqual([]);
      unmount();
    });

    it("unobserves on unmount", () => {
      const { factory } = makeFakeWorkerFactory();
      const { unmount } = render(<PauseHarness workerFactory={factory} />);
      expect(liveIntersectionObservers()).toHaveLength(1);
      unmount();
      expect(liveIntersectionObservers()).toHaveLength(0);
    });

    it("seeds a deferred (staggered) host with the state observed before it existed", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const { container, unmount } = render(
        <PauseHarness workerFactory={factory} staggerMount />,
      );
      const el = container.querySelector('[data-testid="chart"]')!;
      // Observer reports off-screen BEFORE the deferred host is created.
      act(() => triggerIntersection(el, false));
      expect(posts.some((p) => (p.msg as { op: number }).op === Op.INIT)).toBe(false);
      // Flush the mount queue → host created → seed applies the latched state.
      act(() => flushLifecycleScheduler());
      expect(onScreenPosts(posts).at(-1)).toBe(false);
      unmount();
    });

    it("re-seeds on-screen state when a warm host is recycled", () => {
      const { factory, posts } = makeFakeWorkerFactory();
      const pool = createHostRecyclePool();
      const first = render(<PauseHarness workerFactory={factory} recyclePool={pool} />);
      first.unmount(); // parks the warm host
      expect(pool.size).toBe(1);

      posts.length = 0;
      const second = render(<PauseHarness workerFactory={factory} recyclePool={pool} />);
      // Warm reactivation re-drives on-screen state (no re-INIT).
      const reinit = posts.filter((p) => (p.msg as { op: number }).op === Op.INIT);
      expect(reinit).toHaveLength(0);
      expect(onScreenPosts(posts)).toContain(true);
      second.unmount();
      pool.dispose();
    });
  });

  describe("configureFluxionDefaults (app-wide defaults)", () => {
    function DefaultsHarness({
      workerFactory,
      hostOptions,
      recyclePool,
    }: {
      workerFactory: () => Worker;
      hostOptions?: Parameters<typeof useFluxionCanvas>[0]["hostOptions"];
      recyclePool?: ReturnType<typeof createHostRecyclePool>;
    }) {
      const { containerRef } = useFluxionCanvas({
        layers: [{ id: "line", kind: "line", config: { color: "#fff" } }],
        hostOptions: { workerFactory, ...hostOptions },
        staggerMount: false,
        recyclePool,
      });
      return <div ref={containerRef} style={{ width: 200, height: 100 }} />;
    }
    const initOf = (posts: RecordedPost[]) =>
      posts.find((p) => (p.msg as { op: number }).op === Op.INIT)?.msg as
        | { bgColor?: string; renderer?: string }
        | undefined;

    afterEach(() => {
      resetFluxionDefaults();
      resetLifecycleScheduler();
    });

    it("a default bgColor reaches a chart that sets none", () => {
      configureFluxionDefaults({ bgColor: "#ffffff" });
      const { factory, posts } = makeFakeWorkerFactory();
      const { unmount } = render(<DefaultsHarness workerFactory={factory} />);
      expect(initOf(posts)?.bgColor).toBe("#ffffff");
      unmount();
    });

    it("a per-chart bgColor overrides the default", () => {
      configureFluxionDefaults({ bgColor: "#ffffff" });
      const { factory, posts } = makeFakeWorkerFactory();
      const { unmount } = render(
        <DefaultsHarness workerFactory={factory} hostOptions={{ bgColor: "#101010" }} />,
      );
      expect(initOf(posts)?.bgColor).toBe("#101010");
      unmount();
    });

    it("a default renderer participates in the recycle key", () => {
      configureFluxionDefaults({ renderer: "webgl" });
      const { factory, posts } = makeFakeWorkerFactory();
      const pool = createHostRecyclePool();
      // Park a host that inherited the default renderer:'webgl'.
      const a = render(<DefaultsHarness workerFactory={factory} recyclePool={pool} />);
      a.unmount();
      expect(pool.size).toBe(1);

      // A chart with an EXPLICIT renderer:'2d' is a different bucket → cold create
      // (must NOT reuse the parked webgl host), proving the default is in the key.
      posts.length = 0;
      const b = render(
        <DefaultsHarness
          workerFactory={factory}
          recyclePool={pool}
          hostOptions={{ renderer: "2d" }}
        />,
      );
      expect(posts.filter((p) => (p.msg as { op: number }).op === Op.INIT)).toHaveLength(
        1,
      );
      b.unmount();
      pool.dispose();
    });
  });
});
