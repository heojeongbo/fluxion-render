import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetArityGuard } from "../../../shared/lib/arity-guard";
import { Op, WorkerOp } from "../../../shared/protocol";
import { FluxionHost } from "./fluxion-host";

interface RecordedPost {
  msg: unknown;
  transfer?: Transferable[];
}

function makeFakeWorker() {
  const posts: RecordedPost[] = [];
  const terminate = vi.fn();
  const worker = {
    postMessage: vi.fn((msg: unknown, transfer?: Transferable[]) => {
      posts.push({ msg, transfer });
    }),
    terminate,
    onmessage: null,
    onerror: null,
  };
  return { worker: worker as unknown as Worker, posts, terminate };
}

function makeCanvas(width = 400, height = 300) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

describe("FluxionHost", () => {
  it("sends INIT with OffscreenCanvas in the transfer list on construction", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(400, 300), {
      workerFactory: () => worker,
    });
    expect(posts).toHaveLength(1);
    const [first] = posts;
    expect((first.msg as { op: number }).op).toBe(Op.INIT);
    expect(first.transfer).toHaveLength(1);
    host.dispose();
  });

  it("addLayer / configLayer / removeLayer post the right opcodes", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    posts.length = 0;
    host.addLayer("chart", "line", { color: "#0ff" });
    host.configLayer("chart", { lineWidth: 3 });
    host.removeLayer("chart");
    expect(posts.map((p) => (p.msg as { op: number }).op)).toEqual([
      Op.ADD_LAYER,
      Op.CONFIG,
      Op.REMOVE_LAYER,
    ]);
    host.dispose();
  });

  it("pushData transfers the underlying ArrayBuffer", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    posts.length = 0;
    const data = new Float32Array([1, 2, 3, 4]);
    const buffer = data.buffer;
    host.pushData("chart", data);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    const msg = post.msg as {
      op: number;
      dtype: string;
      length: number;
      buffer: ArrayBuffer;
    };
    expect(msg.op).toBe(Op.DATA);
    expect(msg.dtype).toBe("f32");
    expect(msg.length).toBe(4);
    expect(msg.buffer).toBe(buffer);
    expect(post.transfer).toEqual([buffer]);
    host.dispose();
  });

  it("infers dtype from TypedArray kind", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    posts.length = 0;
    host.pushData("a", new Uint8Array([1, 2]));
    host.pushData("b", new Int16Array([1, 2]));
    host.pushData("c", new Uint16Array([1, 2]));
    host.pushData("d", new Int32Array([1, 2]));
    const dtypes = posts.map((p) => (p.msg as { dtype: string }).dtype);
    expect(dtypes).toEqual(["u8", "i16", "u16", "i32"]);
    host.dispose();
  });

  it("rejects TypedArray subviews with non-zero byteOffset", () => {
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    const underlying = new ArrayBuffer(64);
    const subview = new Float32Array(underlying, 8, 4); // byteOffset = 8
    expect(() => host.pushData("chart", subview)).toThrow(/byteOffset 0/);
    host.dispose();
  });

  it("dispose terminates the worker and becomes a no-op afterwards", () => {
    const { worker, posts, terminate } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    host.dispose();
    expect(terminate).toHaveBeenCalledTimes(1);
    posts.length = 0;
    host.addLayer("x", "line");
    host.pushData("x", new Float32Array([1]));
    expect(posts).toHaveLength(0);
  });

  it("dispose is idempotent (second call no-ops, worker terminated once)", () => {
    const { worker, terminate } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    host.dispose();
    expect(() => host.dispose()).not.toThrow(); // second dispose is a safe no-op
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("dispose completes even when the final flush throws (teardown not aborted)", () => {
    let throwOnPost = false;
    const terminate = vi.fn();
    const worker = {
      postMessage: vi.fn(() => {
        if (throwOnPost) throw new Error("worker gone");
      }),
      terminate,
      onmessage: null,
      onerror: null,
    } as unknown as Worker;
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("line");
    line.push({ t: 1, y: 2 }); // stage a sample → pending non-empty (coalesced)

    throwOnPost = true; // the final flush's DATA post will now throw
    expect(() => host.dispose()).not.toThrow(); // resilient — teardown still runs
    expect(terminate).toHaveBeenCalledTimes(1); // worker still terminated

    // Disposed: subsequent ops are no-ops (post is guarded), so no further posts.
    throwOnPost = false;
    const post = worker.postMessage as ReturnType<typeof vi.fn>;
    const before = post.mock.calls.length;
    host.addLayer("x", "line");
    host.pushData("x", new Float32Array([1]));
    expect(post.mock.calls.length).toBe(before);
  });

  it("addLineLayer creates the layer and returns a typed handle", () => {
    const { worker, posts } = makeFakeWorker();
    // coalesce:false so the single push posts its DATA synchronously here.
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      coalesce: false,
    });
    posts.length = 0;
    const line = host.addLineLayer("chart", { color: "#0ff" });
    expect(line.id).toBe("chart");
    // ADD_LAYER with kind "line" was posted
    const addMsg = posts[0].msg as { op: number; kind: string };
    expect(addMsg.op).toBe(Op.ADD_LAYER);
    expect(addMsg.kind).toBe("line");

    line.push({ t: 100, y: 0.5 });
    // ADD_LAYER + DATA were posted. DATA encodes [100, 0.5].
    const dataMsg = posts.find((p) => (p.msg as { op: number }).op === Op.DATA);
    expect(dataMsg).toBeDefined();
    const ms = dataMsg!.msg as { buffer: ArrayBuffer; length: number };
    expect(ms.length).toBe(2);
    expect(Array.from(new Float32Array(ms.buffer, 0, 2))).toEqual([100, 0.5]);
    host.dispose();
  });

  it("addLineLayer handle pushBatch transfers a single encoded buffer", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.pushBatch([
      { t: 1, y: 10 },
      { t: 2, y: 20 },
      { t: 3, y: 30 },
    ]);
    expect(posts).toHaveLength(1);
    const ms = posts[0].msg as { buffer: ArrayBuffer; length: number };
    expect(ms.length).toBe(6);
    expect(Array.from(new Float32Array(ms.buffer, 0, 6))).toEqual([1, 10, 2, 20, 3, 30]);
    // Buffer must be in the transfer list.
    expect(posts[0].transfer).toEqual([ms.buffer]);
    host.dispose();
  });

  it("addLidarLayer handle encodes x,y,z,intensity with default stride 4", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const cloud = host.addLidarLayer("cloud", { pointSize: 2 });
    posts.length = 0;
    cloud.push([
      { x: 1, y: 2, intensity: 0.5 },
      { x: 3, y: 4, z: 1, intensity: 0.9 },
    ]);
    const ms = posts[0].msg as { buffer: ArrayBuffer; length: number };
    expect(ms.length).toBe(8);
    const arr = new Float32Array(ms.buffer, 0, 8);
    const expected = [1, 2, 0, 0.5, 3, 4, 1, 0.9];
    for (let i = 0; i < 8; i++) expect(arr[i]).toBeCloseTo(expected[i], 5);
    host.dispose();
  });

  it("addLidarLayer respects stride override from config", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const cloud = host.addLidarLayer("cloud", { stride: 2, pointSize: 1 });
    expect(cloud.stride).toBe(2);
    posts.length = 0;
    cloud.push([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    const ms = posts[0].msg as { buffer: ArrayBuffer; length: number };
    expect(ms.length).toBe(4);
    expect(Array.from(new Float32Array(ms.buffer, 0, 4))).toEqual([1, 2, 3, 4]);
    host.dispose();
  });

  it("addLineStaticLayer handle setXY replaces with interleaved data", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const plot = host.addLineStaticLayer("plot", { layout: "xy" });
    posts.length = 0;
    plot.setXY([
      { x: 0, y: 1 },
      { x: 2, y: 3 },
    ]);
    const ms = posts[0].msg as { buffer: ArrayBuffer; length: number };
    expect(Array.from(new Float32Array(ms.buffer, 0, ms.length))).toEqual([0, 1, 2, 3]);
    host.dispose();
  });

  it("host.line(id) attaches a handle to a preexisting layer", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      coalesce: false,
    });
    // Simulate "layer added via useFluxionCanvas"
    host.addLayer("preexisting", "line", { color: "#fff" });
    const line = host.line("preexisting");
    posts.length = 0;
    line.push({ t: 50, y: 0.25 });
    const ms = posts[0].msg as {
      op: number;
      id: string;
      buffer: ArrayBuffer;
    };
    expect(ms.op).toBe(Op.DATA);
    expect(ms.id).toBe("preexisting");
    expect(Array.from(new Float32Array(ms.buffer, 0, 2))).toEqual([50, 0.25]);
    host.dispose();
  });

  it("constructor forwards bgColor into the INIT message", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      bgColor: "#ffffff",
    });
    const init = posts[0].msg as { op: number; bgColor?: string };
    expect(init.op).toBe(Op.INIT);
    expect(init.bgColor).toBe("#ffffff");
    host.dispose();
  });

  it("forwards maxFps / emitBounds / emitTicks into the INIT message", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      maxFps: 30,
      emitBounds: false,
      emitTicks: false,
    });
    const init = posts[0].msg as {
      op: number;
      maxFps?: number;
      emitBounds?: boolean;
      emitTicks?: boolean;
    };
    expect(init.op).toBe(Op.INIT);
    expect(init.maxFps).toBe(30);
    expect(init.emitBounds).toBe(false);
    expect(init.emitTicks).toBe(false);
    host.dispose();
  });

  it("omitting bgColor leaves the init field undefined (engine default applies)", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    const init = posts[0].msg as { op: number; bgColor?: string };
    expect(init.op).toBe(Op.INIT);
    expect(init.bgColor).toBeUndefined();
    host.dispose();
  });

  it("setBgColor posts a SET_BG_COLOR message", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    posts.length = 0;
    host.setBgColor("#ff00aa");
    expect(posts).toHaveLength(1);
    const msg = posts[0].msg as { op: number; color: string };
    expect(msg.op).toBe(Op.SET_BG_COLOR);
    expect(msg.color).toBe("#ff00aa");
    host.dispose();
  });

  it("resize posts a RESIZE message with dpr", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
    });
    posts.length = 0;
    host.resize(800, 600, 2);
    const msg = posts[0].msg as {
      op: number;
      width: number;
      height: number;
      dpr: number;
    };
    expect(msg.op).toBe(Op.RESIZE);
    expect(msg.width).toBe(800);
    expect(msg.height).toBe(600);
    expect(msg.dpr).toBe(2);
    host.dispose();
  });

  it("clearLayer posts CLEAR_DATA with optional latestT rewind", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;

    host.clearLayer("chart");
    host.clearLayer("chart", { latestT: 5000 });

    expect(posts.map((p) => (p.msg as { op: number }).op)).toEqual([
      Op.CLEAR_DATA,
      Op.CLEAR_DATA,
    ]);
    const first = posts[0].msg as { id: string; latestT?: number };
    expect(first.id).toBe("chart");
    expect(first.latestT).toBeUndefined();
    const second = posts[1].msg as { id: string; latestT?: number };
    expect(second.id).toBe("chart");
    expect(second.latestT).toBe(5000);
    host.dispose();
  });

  it("addAxisLayer posts ADD_LAYER with kind axis-grid", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.addAxisLayer("grid", { xRange: [0, 10], yRange: [0, 10] });
    expect(posts).toHaveLength(1);
    const msg = posts[0].msg as { op: number; kind: string };
    expect(msg.op).toBe(Op.ADD_LAYER);
    expect(msg.kind).toBe("axis-grid");
    host.dispose();
  });

  it("typed handle accessors return correct handle types with right ids", () => {
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    expect(host.line("a").id).toBe("a");
    expect(host.lineStatic("b").id).toBe("b");
    expect(host.lidar("c").id).toBe("c");
    expect(host.scatter("d").id).toBe("d");
    expect(host.area("e").id).toBe("e");
    expect(host.step("f").id).toBe("f");
    expect(host.bar("g").id).toBe("g");
    expect(host.candlestick("h").id).toBe("h");
    expect(host.heatmap("i").id).toBe("i");
    expect(host.eventMarker("j").id).toBe("j");
    expect(host.scatterColored("k").id).toBe("k");
    expect(host.heatmapStream("l").id).toBe("l");
    expect(host.referenceLine("m").id).toBe("m");
    expect(host.poseArrow("n").id).toBe("n");
    expect(host.trajectory("o").id).toBe("o");
    expect(host.occupancyGrid("p").id).toBe("p");
    expect(host.histogram("q").id).toBe("q");
    expect(host.stackedArea("r").id).toBe("r");
    expect(host.boxPlot("s").id).toBe("s");
    expect(host.polar("t").id).toBe("t");
    host.dispose();
  });

  it("lidar() accessor respects explicit stride", () => {
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    expect(host.lidar("pts", 2).stride).toBe(2);
    expect(host.lidar("pts", 3).stride).toBe(3);
    host.dispose();
  });

  it("dispose removes the worker message listener", () => {
    const listeners: { type: string; fn: EventListener }[] = [];
    const { worker, posts } = makeFakeWorker();
    const workerWithEvents = {
      ...worker,
      addEventListener: (type: string, fn: EventListener) => {
        listeners.push({ type, fn });
      },
      removeEventListener: (type: string, fn: EventListener) => {
        const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
    });
    expect(listeners).toHaveLength(1);
    host.dispose();
    expect(listeners).toHaveLength(0);
    posts.length = 0;
    host.dispose();
    expect(posts).toHaveLength(0);
  });

  describe("getMetrics", () => {
    it("starts at zero with null last-push and bounds", () => {
      const { worker } = makeFakeWorker();
      const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
      const m = host.getMetrics();
      expect(m.pushCount).toBe(0);
      expect(m.sampleCount).toBe(0);
      expect(m.bytesTransferred).toBe(0);
      expect(m.pushesByLayer).toEqual({});
      expect(m.lastPushAt).toBeNull();
      expect(m.bounds).toBeNull();
      host.dispose();
    });

    it("accumulates push/sample/byte counters and per-layer counts", () => {
      const { worker } = makeFakeWorker();
      const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
      host.pushData("a", new Float32Array([1, 2, 3, 4])); // 4 samples, 16 bytes
      host.pushData("a", new Float32Array([5, 6])); // 2 samples, 8 bytes
      host.pushData("b", new Float32Array([7])); // 1 sample, 4 bytes
      const m = host.getMetrics();
      expect(m.pushCount).toBe(3);
      expect(m.sampleCount).toBe(7);
      expect(m.bytesTransferred).toBe(28);
      expect(m.pushesByLayer).toEqual({ a: 2, b: 1 });
      expect(m.lastPushAt).not.toBeNull();
      host.dispose();
    });

    it("captures the latest worker bounds", () => {
      const { worker } = makeFakeWorker();
      let messageHandler: ((evt: Event) => void) | null = null;
      const workerWithEvents = {
        ...worker,
        addEventListener: (_t: string, fn: EventListener) => {
          messageHandler = fn as (evt: Event) => void;
        },
        removeEventListener: () => {},
      };
      const host = new FluxionHost(makeCanvas(), {
        workerFactory: () => workerWithEvents as unknown as Worker,
      });
      messageHandler!({
        data: {
          op: WorkerOp.BOUNDS_UPDATE,
          hostId: "x",
          yMin: -2,
          yMax: 8,
          latestT: 900,
        },
      } as unknown as Event);
      expect(host.getMetrics().bounds).toEqual({ yMin: -2, yMax: 8, latestT: 900 });
      host.dispose();
    });
  });

  describe("onMetricsUpdate", () => {
    it("fires a snapshot on the interval and stops on unsubscribe", () => {
      vi.useFakeTimers();
      try {
        const { worker } = makeFakeWorker();
        const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
        const cb = vi.fn();
        const unsub = host.onMetricsUpdate(cb, { intervalMs: 100 });

        host.pushData("a", new Float32Array([1, 2, 3, 4]));
        vi.advanceTimersByTime(100);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0]![0].sampleCount).toBe(4);

        unsub();
        vi.advanceTimersByTime(300);
        expect(cb).toHaveBeenCalledTimes(1); // no more fires after unsubscribe
        host.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("shares one interval across multiple subscribers (default rate)", () => {
      vi.useFakeTimers();
      try {
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
        const { worker } = makeFakeWorker();
        const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
        const a = vi.fn();
        const b = vi.fn();
        const unsubA = host.onMetricsUpdate(a);
        const unsubB = host.onMetricsUpdate(b);
        // Only the first subscriber starts the timer.
        const timerStarts = setIntervalSpy.mock.calls.length;
        expect(timerStarts).toBe(1);

        vi.advanceTimersByTime(250);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);

        unsubA();
        unsubB();
        host.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("dispose clears the metrics interval", () => {
      vi.useFakeTimers();
      try {
        const { worker } = makeFakeWorker();
        const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
        const cb = vi.fn();
        host.onMetricsUpdate(cb, { intervalMs: 100 });
        host.dispose();
        vi.advanceTimersByTime(300);
        expect(cb).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("onBoundsChange fires when worker sends BOUNDS_UPDATE", () => {
    const { worker } = makeFakeWorker();
    let messageHandler: ((evt: Event) => void) | null = null;
    const workerWithEvents = {
      ...worker,
      addEventListener: (_type: string, fn: EventListener) => {
        messageHandler = fn as (evt: Event) => void;
      },
      removeEventListener: () => {},
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
    });
    const received: { yMin: number; yMax: number; latestT: number }[] = [];
    host.onBoundsChange((yMin, yMax, latestT) => received.push({ yMin, yMax, latestT }));
    messageHandler!({
      data: { op: WorkerOp.BOUNDS_UPDATE, hostId: "x", yMin: -1, yMax: 1, latestT: 500 },
    } as unknown as Event);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ yMin: -1, yMax: 1, latestT: 500 });
    host.dispose();
  });

  it("onTickUpdate fires when worker sends TICK_UPDATE", () => {
    const { worker } = makeFakeWorker();
    let messageHandler: ((evt: Event) => void) | null = null;
    const workerWithEvents = {
      ...worker,
      addEventListener: (_type: string, fn: EventListener) => {
        messageHandler = fn as (evt: Event) => void;
      },
      removeEventListener: () => {},
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
    });
    const received: { xTicks: unknown; yTicks: unknown }[] = [];
    host.onTickUpdate((xTicks, yTicks) => received.push({ xTicks, yTicks }));
    const xTicks = [{ value: 0, label: "0", fraction: 0 }];
    const yTicks = [{ value: 1, label: "1", fraction: 0.5 }];
    messageHandler!({
      data: { op: WorkerOp.TICK_UPDATE, hostId: "x", xTicks, yTicks, xRawValues: [] },
    } as unknown as Event);
    expect(received).toHaveLength(1);
    expect(received[0].xTicks).toBe(xTicks);
    expect(received[0].yTicks).toBe(yTicks);
    host.dispose();
  });

  it("onRenderStats fires on RENDER_STATS and stops after unsubscribe", () => {
    const { worker } = makeFakeWorker();
    let messageHandler: ((evt: Event) => void) | null = null;
    const workerWithEvents = {
      ...worker,
      addEventListener: (_type: string, fn: EventListener) => {
        messageHandler = fn as (evt: Event) => void;
      },
      removeEventListener: () => {},
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
      emitRenderStats: true,
    });
    const received: { renders: number; busyMs: number; windowMs: number }[] = [];
    const unsub = host.onRenderStats((s) => received.push(s));
    const fire = () =>
      messageHandler!({
        data: {
          op: WorkerOp.RENDER_STATS,
          hostId: "x",
          renders: 30,
          busyMs: 12,
          windowMs: 1000,
        },
      } as unknown as Event);
    fire();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ renders: 30, busyMs: 12, windowMs: 1000 });
    unsub();
    fire();
    expect(received).toHaveLength(1); // unsubscribed → no further calls
    host.dispose();
  });

  it("emitRenderStats threads into the INIT message", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      emitRenderStats: true,
    });
    const init = posts.find((p) => (p.msg as { op: number }).op === Op.INIT)!.msg as {
      emitRenderStats?: boolean;
    };
    expect(init.emitRenderStats).toBe(true);
    host.dispose();
  });

  it("onBoundsChange unsubscribe removes listener", () => {
    const { worker } = makeFakeWorker();
    let messageHandler: ((evt: Event) => void) | null = null;
    const workerWithEvents = {
      ...worker,
      addEventListener: (_type: string, fn: EventListener) => {
        messageHandler = fn as (evt: Event) => void;
      },
      removeEventListener: () => {},
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
    });
    let count = 0;
    const unsub = host.onBoundsChange(() => {
      count++;
    });
    messageHandler!({
      data: { op: WorkerOp.BOUNDS_UPDATE, hostId: "x", yMin: 0, yMax: 1, latestT: 0 },
    } as unknown as Event);
    expect(count).toBe(1);
    unsub();
    messageHandler!({
      data: { op: WorkerOp.BOUNDS_UPDATE, hostId: "x", yMin: 0, yMax: 1, latestT: 0 },
    } as unknown as Event);
    expect(count).toBe(1);
    host.dispose();
  });

  it("onTickUpdate unsubscribe removes listener", () => {
    const { worker } = makeFakeWorker();
    let messageHandler: ((evt: Event) => void) | null = null;
    const workerWithEvents = {
      ...worker,
      addEventListener: (_type: string, fn: EventListener) => {
        messageHandler = fn as (evt: Event) => void;
      },
      removeEventListener: () => {},
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
    });
    let count = 0;
    const unsub = host.onTickUpdate(() => {
      count++;
    });
    messageHandler!({
      data: {
        op: WorkerOp.TICK_UPDATE,
        hostId: "x",
        xTicks: [],
        yTicks: [],
        xRawValues: [],
      },
    } as unknown as Event);
    expect(count).toBe(1);
    unsub();
    messageHandler!({
      data: {
        op: WorkerOp.TICK_UPDATE,
        hostId: "x",
        xTicks: [],
        yTicks: [],
        xRawValues: [],
      },
    } as unknown as Event);
    expect(count).toBe(1);
    host.dispose();
  });

  it("ignores unknown worker message op codes", () => {
    const { worker } = makeFakeWorker();
    let messageHandler: ((evt: Event) => void) | null = null;
    const workerWithEvents = {
      ...worker,
      addEventListener: (_type: string, fn: EventListener) => {
        messageHandler = fn as (evt: Event) => void;
      },
      removeEventListener: () => {},
    };
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => workerWithEvents as unknown as Worker,
    });
    expect(() => {
      messageHandler!({ data: { op: 999 } } as unknown as Event);
      messageHandler!({ data: null } as unknown as Event);
      messageHandler!({ data: "string" } as unknown as Event);
    }).not.toThrow();
    host.dispose();
  });

  it("emitStream transfers the ArrayBuffer with mode:stream and the given id/length", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    const buffer = new Float32Array([1, 2, 3, 4]).buffer;
    host.emitStream("sensor", buffer, 4);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    const msg = post.msg as {
      id: string;
      length: number;
      mode: string;
      buffer: ArrayBuffer;
    };
    expect(msg.id).toBe("sensor");
    expect(msg.length).toBe(4);
    expect(msg.mode).toBe("stream");
    expect(msg.buffer).toBe(buffer);
    expect(post.transfer).toEqual([buffer]);
    host.dispose();
  });

  it("emitStream is a no-op after dispose", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    host.dispose();
    posts.length = 0;
    host.emitStream("sensor", new ArrayBuffer(8), 2);
    expect(posts).toHaveLength(0);
  });

  it("pushData throws on an unsupported TypedArray with an actionable message", () => {
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    // Float64Array is not in the supported set → dtypeOf throws.
    expect(() => host.pushData("x", new Float64Array([1, 2]) as never)).toThrow(
      /unsupported TypedArray "Float64Array"/,
    );
    host.dispose();
  });

  it("strips function fields from layer config before postMessage", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.addLayer("axis", "axis-grid", {
      xMode: "time",
      // function formatter can't structuredClone → must be stripped.
      xTickFormat: (v: number) => `${v}!`,
      timeWindowMs: 1000,
    });
    const msg = posts[0].msg as { config: Record<string, unknown> };
    expect(msg.config.xTickFormat).toBeUndefined();
    expect(msg.config.timeWindowMs).toBe(1000);

    posts.length = 0;
    host.configLayer("axis", { yTickFormat: (v: number) => `${v}` });
    const cfg = posts[0].msg as { config: Record<string, unknown> };
    expect(cfg.config.yTickFormat).toBeUndefined();
    host.dispose();
  });

  it("configLayers posts a single CONFIG_BATCH with all entries", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.configLayers([
      { id: "a", config: { visible: false } },
      { id: "b", config: { lineWidth: 2 } },
    ]);
    expect(posts).toHaveLength(1);
    const msg = posts[0].msg as {
      op: number;
      entries: Array<{ id: string; config: unknown }>;
    };
    expect(msg.op).toBe(Op.CONFIG_BATCH);
    expect(msg.entries.map((e) => e.id)).toEqual(["a", "b"]);
    host.dispose();
  });

  it("configLayers with an empty array posts nothing", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.configLayers([]);
    expect(posts).toHaveLength(0);
    host.dispose();
  });

  it("configLayers strips function fields per entry", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.configLayers([
      { id: "axis", config: { yTickFormat: (v: number) => `${v}`, gridLineWidth: 2 } },
    ]);
    const msg = posts[0].msg as {
      entries: Array<{ config: Record<string, unknown> }>;
    };
    expect(msg.entries[0].config.yTickFormat).toBeUndefined();
    expect(msg.entries[0].config.gridLineWidth).toBe(2);
    host.dispose();
  });

  it("setLayerVisibility (single + map) delegates to one CONFIG_BATCH", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });

    posts.length = 0;
    host.setLayerVisibility("a", true);
    expect(posts).toHaveLength(1);
    const single = posts[0].msg as {
      op: number;
      entries: Array<{ id: string; config: { visible: boolean } }>;
    };
    expect(single.op).toBe(Op.CONFIG_BATCH);
    expect(single.entries).toEqual([{ id: "a", config: { visible: true } }]);

    posts.length = 0;
    host.setLayerVisibility({ a: false, b: true });
    expect(posts).toHaveLength(1);
    const map = posts[0].msg as {
      entries: Array<{ id: string; config: { visible: boolean } }>;
    };
    expect(map.entries).toEqual([
      { id: "a", config: { visible: false } },
      { id: "b", config: { visible: true } },
    ]);
    host.dispose();
  });

  it("hostId is __solo__ in solo (workerFactory) mode", () => {
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    expect(host.hostId).toBe("__solo__");
    host.dispose();
  });

  it("emitPoolStream posts a pool-stream message and is a no-op after dispose", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    const buf = new ArrayBuffer(8);
    host.emitPoolStream([{ hostId: "h", layerId: "l" }], buf, 2);
    expect((posts[0].msg as { mode: string }).mode).toBe("pool-stream");

    host.dispose();
    posts.length = 0;
    host.emitPoolStream([{ hostId: "h", layerId: "l" }], new ArrayBuffer(8), 2);
    expect(posts).toHaveLength(0);
  });

  it("forwards axis canvases and axisStyle into INIT-time messages", () => {
    const { worker, posts } = makeFakeWorker();
    const xAxisElement = makeCanvas(400, 30);
    const yAxisElement = makeCanvas(60, 300);
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      xAxisElement,
      yAxisElement,
      axisStyle: { color: "#abc", tickSize: 5 },
    });
    const ops = posts.map((p) => (p.msg as { op: number }).op);
    expect(ops).toContain(Op.SET_AXIS_CANVAS);
    expect(ops).toContain(Op.SET_AXIS_STYLE);
    host.dispose();
  });

  it("uses an explicitly provided pool instead of a custom workerFactory", () => {
    const { worker } = makeFakeWorker();
    const acquire = vi.fn(() => worker);
    const pool = { acquire } as unknown as import("../../worker-pool").FluxionWorkerPool;
    const host = new FluxionHost(makeCanvas(), { pool });
    expect(acquire).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("falls back to default INIT dimensions when the canvas has zero size", () => {
    const { worker, posts } = makeFakeWorker();
    const canvas = makeCanvas(0, 0); // width/height 0 → `|| 300` / `|| 150` fallbacks
    const host = new FluxionHost(canvas, { workerFactory: () => worker });
    const init = posts.find((p) => (p.msg as { op: number }).op === Op.INIT)!.msg as {
      width: number;
      height: number;
    };
    expect(init.width).toBe(300);
    expect(init.height).toBe(150);
    host.dispose();
  });

  it("registers a visibilitychange listener and forwards SET_VISIBLE; removes it on dispose", () => {
    const docListeners: Record<string, EventListener[]> = {};
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation((type: string, fn: EventListenerOrEventListenerObject) => {
        (docListeners[type] ??= []).push(fn as EventListener);
      });
    const removeSpy = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation((type: string, fn: EventListenerOrEventListenerObject) => {
        const arr = docListeners[type] ?? [];
        const idx = arr.indexOf(fn as EventListener);
        if (idx >= 0) arr.splice(idx, 1);
      });

    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    expect(docListeners.visibilitychange).toHaveLength(1);

    posts.length = 0;
    // Fire the handler → posts a SET_VISIBLE message reflecting visibilityState.
    docListeners.visibilitychange![0]!(new Event("visibilitychange"));
    expect((posts[0].msg as { op: number }).op).toBe(Op.SET_VISIBLE);

    host.dispose();
    expect(docListeners.visibilitychange).toHaveLength(0);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("setVisible(true) forwards a SET_VISIBLE message", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.setVisible(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].msg).toMatchObject({ op: Op.SET_VISIBLE, visible: true });
    host.dispose();
  });

  it("setVisible(false) drains staged data before SET_VISIBLE", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 }); // staged (coalesced), not yet posted
    host.setVisible(false);
    const ops = posts.map((p) => (p.msg as { op: number }).op);
    expect(ops.indexOf(Op.DATA)).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf(Op.DATA)).toBeLessThan(ops.indexOf(Op.SET_VISIBLE));
    expect(posts.at(-1)!.msg).toMatchObject({ op: Op.SET_VISIBLE, visible: false });
    host.dispose();
  });

  it("setVisible is a no-op after dispose", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    host.dispose();
    posts.length = 0;
    host.setVisible(true);
    expect(posts).toHaveLength(0);
  });

  it("reset() posts RESET and drops staged data without posting it", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 }); // staged → scheduled flush
    host.reset();
    // Only RESET — the staged sample is dropped, never posted as Op.DATA.
    expect(posts.map((p) => (p.msg as { op: number }).op)).toEqual([Op.RESET]);
    host.dispose();
  });

  it("reset is a no-op after dispose", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    host.dispose();
    posts.length = 0;
    host.reset();
    expect(posts).toHaveLength(0);
  });

  it("releaseBackings() posts RELEASE_BACKING", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.releaseBackings();
    expect(posts.map((p) => (p.msg as { op: number }).op)).toEqual([Op.RELEASE_BACKING]);
    host.dispose();
  });

  it("releaseBackings is a no-op after dispose", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    host.dispose();
    posts.length = 0;
    host.releaseBackings();
    expect(posts).toHaveLength(0);
  });
});

describe("FluxionHost push coalescing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Capture rAF callbacks so the frame flush can be driven deterministically.
  function captureRaf() {
    const cbs: FrameRequestCallback[] = [];
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cbs.push(cb);
      return cbs.length;
    });
    const caf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);
    return { raf, caf, runFrame: () => cbs.splice(0).forEach((f) => f(0)) };
  }

  const opsOf = (posts: RecordedPost[]) => posts.map((p) => (p.msg as { op: number }).op);
  const dataPosts = (posts: RecordedPost[]) =>
    posts.filter((p) => (p.msg as { op: number }).op === Op.DATA);
  const f32 = (post: RecordedPost) => {
    const ms = post.msg as { buffer: ArrayBuffer; length: number };
    return Array.from(new Float32Array(ms.buffer, 0, ms.length));
  };

  it("coalesces multiple pushes into one DATA per layer per frame", () => {
    const { worker, posts } = makeFakeWorker();
    const { runFrame } = captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 10 });
    line.push({ t: 2, y: 20 });
    line.push({ t: 3, y: 30 });
    expect(dataPosts(posts)).toHaveLength(0); // deferred to the frame
    runFrame();
    const data = dataPosts(posts);
    expect(data).toHaveLength(1);
    expect((data[0]!.msg as { id: string }).id).toBe("chart");
    expect(f32(data[0]!)).toEqual([1, 10, 2, 20, 3, 30]);
    const ms = data[0]!.msg as { buffer: ArrayBuffer };
    expect(data[0]!.transfer).toEqual([ms.buffer]);
    host.dispose();
  });

  it("flushes one DATA message per layer", () => {
    const { worker, posts } = makeFakeWorker();
    const { runFrame } = captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const a = host.addLineLayer("a");
    const b = host.addLineLayer("b");
    posts.length = 0;
    a.push({ t: 1, y: 1 });
    b.push({ t: 2, y: 2 });
    a.push({ t: 3, y: 3 });
    runFrame();
    const data = dataPosts(posts);
    expect(data).toHaveLength(2);
    const byId = new Map(data.map((d) => [(d.msg as { id: string }).id, f32(d)]));
    expect(byId.get("a")).toEqual([1, 1, 3, 3]);
    expect(byId.get("b")).toEqual([2, 2]);
    host.dispose();
  });

  it.each([
    [
      "configLayer",
      (h: FluxionHost) => h.configLayer("chart", { lineWidth: 2 }),
      Op.CONFIG,
    ],
    ["clearLayer", (h: FluxionHost) => h.clearLayer("chart"), Op.CLEAR_DATA],
    ["removeLayer", (h: FluxionHost) => h.removeLayer("chart"), Op.REMOVE_LAYER],
  ])("pre-flushes staged data before %s (preserves order)", (_n, act, ctrlOp) => {
    const { worker, posts } = makeFakeWorker();
    captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 1 });
    act(host); // synchronous pre-flush — no frame needed
    const ops = opsOf(posts);
    expect(ops).toContain(Op.DATA);
    expect(ops.indexOf(Op.DATA)).toBeLessThan(ops.indexOf(ctrlOp));
    host.dispose();
  });

  it("pre-flushes all layers before resize", () => {
    const { worker, posts } = makeFakeWorker();
    captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    host.addLineLayer("a").push({ t: 1, y: 1 });
    posts.length = 0;
    host.resize(200, 100, 1);
    const ops = opsOf(posts);
    expect(ops.indexOf(Op.DATA)).toBeLessThan(ops.indexOf(Op.RESIZE));
    host.dispose();
  });

  it("pre-flushes staged data before an immediate pushData for the same layer", () => {
    const { worker, posts } = makeFakeWorker();
    captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 1 }); // staged
    line.pushBatch([{ t: 2, y: 2 }]); // immediate pushData → drains staged first
    const data = dataPosts(posts);
    expect(data).toHaveLength(2);
    expect(f32(data[0]!)).toEqual([1, 1]);
    expect(f32(data[1]!)).toEqual([2, 2]);
    host.dispose();
  });

  it("flushes immediately when a layer exceeds coalesceMaxFloats (backpressure)", () => {
    const { worker, posts } = makeFakeWorker();
    captureRaf();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      coalesceMaxFloats: 4,
    });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 1 }); // 2 floats
    line.push({ t: 2, y: 2 }); // 4 floats (== cap, not over)
    expect(dataPosts(posts)).toHaveLength(0);
    line.push({ t: 3, y: 3 }); // 6 > 4 → immediate flush
    const data = dataPosts(posts);
    expect(data).toHaveLength(1);
    expect(f32(data[0]!)).toEqual([1, 1, 2, 2, 3, 3]);
    host.dispose();
  });

  it("posts non-f32 pushData immediately (coalescing is f32-only)", () => {
    const { worker, posts } = makeFakeWorker();
    captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    posts.length = 0;
    host.pushData("x", new Uint8Array([1, 2, 3, 4]));
    const data = dataPosts(posts);
    expect(data).toHaveLength(1);
    expect((data[0]!.msg as { dtype: string }).dtype).toBe("u8");
    host.dispose();
  });

  it("coalesce:false posts each push immediately and transfers the buffer", () => {
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), {
      workerFactory: () => worker,
      coalesce: false,
    });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 });
    const data = dataPosts(posts);
    expect(data).toHaveLength(1);
    expect(f32(data[0]!)).toEqual([1, 2]);
    const ms = data[0]!.msg as { buffer: ArrayBuffer };
    expect(data[0]!.transfer).toEqual([ms.buffer]);
    host.dispose();
  });

  it("dispose flushes pending data, cancels the frame, and ignores later pushes", () => {
    const { worker, posts } = makeFakeWorker();
    const { caf, runFrame } = captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 });
    host.dispose();
    expect(dataPosts(posts)).toHaveLength(1); // last frame drained on dispose
    expect(caf).toHaveBeenCalled();
    line.push({ t: 9, y: 9 }); // stage() after dispose is a no-op
    runFrame(); // the captured callback after dispose posts nothing
    expect(dataPosts(posts)).toHaveLength(1);
  });

  it("flushes staged data when the page becomes hidden, before SET_VISIBLE", () => {
    const docListeners: Record<string, EventListener[]> = {};
    vi.spyOn(document, "addEventListener").mockImplementation((type, fn) => {
      (docListeners[type] ??= []).push(fn as EventListener);
    });
    const { worker, posts } = makeFakeWorker();
    captureRaf();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 });
    const original = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    docListeners.visibilitychange![0]!(new Event("visibilitychange"));
    const ops = opsOf(posts);
    expect(ops.indexOf(Op.DATA)).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf(Op.DATA)).toBeLessThan(ops.indexOf(Op.SET_VISIBLE));
    Object.defineProperty(document, "visibilityState", {
      value: original,
      configurable: true,
    });
    host.dispose();
  });

  it("falls back to setTimeout when requestAnimationFrame is unavailable", () => {
    // Fake only timers (not rAF), then hide rAF so scheduleFlush takes the
    // setTimeout branch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 });
    expect(dataPosts(posts)).toHaveLength(0); // deferred to the macrotask
    vi.advanceTimersByTime(1);
    expect(dataPosts(posts)).toHaveLength(1);
    host.dispose();
  });

  it("setTimeout fallback: dispose clears a pending timeout", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { worker, posts } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });
    const line = host.addLineLayer("chart");
    posts.length = 0;
    line.push({ t: 1, y: 2 });
    host.dispose(); // flushAll drains, then clearTimeout(handle)
    expect(dataPosts(posts)).toHaveLength(1);
    expect(clearSpy).toHaveBeenCalled();
    vi.advanceTimersByTime(5); // the cleared timeout never fires again
    expect(dataPosts(posts)).toHaveLength(1);
  });
});

describe("FluxionHost arity tracking", () => {
  afterEach(() => {
    _resetArityGuard();
    vi.restoreAllMocks();
  });

  it("records declared arity from add/config and clears it on remove", () => {
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });

    host.addLayer("sa", "stacked-area", { seriesCount: 3 });
    host.addLayer("hs", "heatmap-stream", { yBins: 32 });
    host.addLayer("ld", "lidar", { stride: 3 });
    host.addLayer("ln", "line", { color: "#0ff" }); // carries no arity field
    host.addLayer("ax", "axis-grid"); // no config at all

    expect(host.expectedArity("sa")).toBe(3);
    expect(host.expectedArity("hs")).toBe(32);
    expect(host.expectedArity("ld")).toBe(3);
    expect(host.expectedArity("ln")).toBeUndefined();
    expect(host.expectedArity("ax")).toBeUndefined();
    expect(host.expectedArity("missing")).toBeUndefined();

    host.configLayer("sa", { seriesCount: 4 }); // reconfig updates the arity
    expect(host.expectedArity("sa")).toBe(4);

    host.configLayers([{ id: "hs", config: { yBins: 16 } }]);
    expect(host.expectedArity("hs")).toBe(16);

    host.removeLayer("sa");
    expect(host.expectedArity("sa")).toBeUndefined();

    host.dispose();
  });

  it("host.lidar(id) auto-resolves stride from the layer config (no arg)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });

    host.addLayer("ld", "lidar", { stride: 3 });
    expect(host.lidar("ld").stride).toBe(3); // resolved from config → no re-passing
    expect(host.lidar("untracked").stride).toBe(4); // unknown layer → default 4
    expect(warn).not.toHaveBeenCalled();

    host.dispose();
  });

  it("host.lidar(id, stride) honors an explicit stride and warns only on a config mismatch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { worker } = makeFakeWorker();
    const host = new FluxionHost(makeCanvas(), { workerFactory: () => worker });

    host.addLayer("ld", "lidar", { stride: 2 });
    expect(host.lidar("ld", 2).stride).toBe(2); // matches config → silent
    expect(warn).not.toHaveBeenCalled();

    expect(host.lidar("ld", 4).stride).toBe(4); // explicit 4 vs config 2 → honored, warned
    expect(warn).toHaveBeenCalledTimes(1);

    expect(host.lidar("fresh", 3).stride).toBe(3); // explicit on untracked → honored, silent
    expect(warn).toHaveBeenCalledTimes(1);

    host.dispose();
  });
});
