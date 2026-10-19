import { createFluxionWorkerFactory } from "@heojeongbo/fluxion-render";
import { FluxionCanvas, useFluxionWorkerPool } from "@heojeongbo/fluxion-render/react";
import {
  MetricChannel,
  ReplayPlayer,
  ReplaySession,
  ReplayStore,
} from "@heojeongbo/fluxion-replay";
import { useDvrController, useRecordingSession } from "@heojeongbo/fluxion-replay/react";
import { WorkerHandle } from "@heojeongbo/fluxion-worker";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}
const root = createRoot(document.getElementById("root")!);
let liveWorkers = 0,
  mounted = false;
const createWorker = createFluxionWorkerFactory();
function Chart() {
  const pool = useFluxionWorkerPool({
    size: 1,
    workerFactory: () => {
      const worker = createWorker();
      liveWorkers++;
      const terminate = worker.terminate.bind(worker);
      let stopped = false;
      worker.terminate = () => {
        if (!stopped) {
          stopped = true;
          liveWorkers--;
        }
        terminate();
      };
      return worker;
    },
  });
  return (
    <FluxionCanvas
      style={{ width: 480, height: 240 }}
      hostOptions={{ pool }}
      layers={[
        {
          id: "axis",
          kind: "axis-grid",
          config: { xMode: "fixed", xRange: [0, 1000], yRange: [0, 10] },
        },
        { id: "line", kind: "line" },
        { id: "time", kind: "current-time", config: { currentTime: 500 } },
      ]}
      onReady={(host) => {
        host.line("line").push({ t: 0, y: 2 });
        host.line("line").push({ t: 1000, y: 8 });
        mounted = true;
      }}
    />
  );
}
const frame = (t: number) => ({
  t,
  channelId: "cam",
  payload: new Uint8Array([t % 256]).buffer,
});
let sequence = 0;
async function store(options: ConstructorParameters<typeof ReplayStore>[0] = {}) {
  const s = new ReplayStore({
    dbName: `e2e-${Date.now()}-${++sequence}`,
    evictThresholdPct: 100,
    ...options,
  });
  await s.open();
  return s;
}
let hookState: {
  recording: ReturnType<typeof useRecordingSession>;
  dvr: ReturnType<typeof useDvrController>;
} | null = null;
function RecordingDvr({
  session,
  enabled,
}: {
  session: ReplaySession;
  enabled: boolean;
}) {
  const recording = useRecordingSession({
    session,
    enabled,
    clearOnStart: false,
    channels: [
      { channelId: "m", intervalMs: 10, produce: () => ({ name: "m", value: 1 }) },
    ],
  });
  const dvr = useDvrController({
    session,
    enterReplay: (t, opts) => session.enterReplay(t, opts),
    exitReplay: () => session.exitReplay(),
    liveTimeRange: { earliest: 0, latest: Date.now() },
    autoPlay: false,
  });
  useEffect(() => {
    hookState = { recording, dvr };
  });
  return <div data-testid="recording">{String(recording.isRecording)}</div>;
}
const scenarios = {
  async "recording-and-dvr-hooks"() {
    const s = new ReplaySession({
      channels: [new MetricChannel("m")],
      storeOptions: { dbName: `hooks-${Date.now()}`, evictThresholdPct: 100 },
    });
    await s.open();
    const draw = (enabled: boolean) =>
      root.render(
        <StrictMode>
          <RecordingDvr session={s} enabled={enabled} />
        </StrictMode>,
      );
    try {
      hookState = null;
      draw(true);
      await until(
        () => Boolean(hookState?.recording.isRecording),
        "StrictMode recording did not start",
      );
      await delay(50);
      draw(false);
      await until(() => !s.recorder.isRecording, "disabled hook left recording active");
      await s.store.flush();
      const count = (await s.store.getStorageInfo()).idbFrameCount;
      check(count > 0, "recording produced no frames");
      draw(true);
      await until(
        () => Boolean(hookState?.recording.isRecording),
        "recording did not restart",
      );
      await delay(50);
      await s.store.flush();
      check(
        (await s.store.getStorageInfo()).idbFrameCount > count,
        "restart cleared history or produced no samples",
      );
      hookState!.dvr.setRate(2);
      await until(() => hookState?.dvr.rate === 2, "rate was not stored");
      await hookState!.dvr.dvr.enter();
      await until(() => Boolean(hookState?.dvr.isDvr), "DVR entry did not complete");
      check(s.mode === "replay", "session mode diverged");
      root.render(null);
      await until(() => !s.recorder.isRecording, "unmount left recording active");
    } finally {
      root.render(null);
      await delay(20);
      await s.store.clearAll();
      s.dispose();
    }
  },
  async "persisted-v1-schema-compatibility"() {
    const name = `legacy-schema-${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const frames = open.result.createObjectStore("frames", { autoIncrement: true });
        frames.createIndex("by_t", "t");
        frames.createIndex("by_channel_t", ["channelId", "t"]);
        frames.add(frame(42));
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const s = await store({ dbName: name });
    try {
      check((await s.getFrames(0, 100))[0]?.t === 42, "legacy schema lost its recording");
      await new Promise<void>((resolve, reject) => {
        const legacy = indexedDB.open(name, 1);
        legacy.onsuccess = () => {
          legacy.result.close();
          resolve();
        };
        legacy.onerror = () => reject(legacy.error);
      });
    } finally {
      await s.clearAll();
      s.dispose();
    }
  },
  async "video-retention-matches-metadata"() {
    const s = await store({ retentionMs: 100 });
    try {
      for (let t = 0; t <= 1000; t++) {
        await s.writeVideoChunk("cam", `${t}.chunk`, new Uint8Array([1]));
        s.appendFrame(frame(t));
      }
      await s.flush();
      for (const retained of await s.getFrames(0, 1000))
        check(
          await s.readVideoChunk("cam", `${retained.t}.chunk`),
          `missing retained video ${retained.t}`,
        );
      check(
        (await s.readVideoChunk("cam", "0.chunk")) === null,
        "old video not reclaimed",
      );
    } finally {
      await s.clearAll();
      s.dispose();
    }
  },
  async "worker-rpc-and-sliced-data"() {
    const handle = new WorkerHandle<{ job: string; delay?: number }>(
      () =>
        new Worker(new URL("./reliability-worker.ts", import.meta.url), {
          type: "module",
        }),
    );
    try {
      const results = await Promise.all([
        handle.request<{ job: string }>({ job: "a", delay: 50 }),
        handle.request<{ job: string }>({ job: "b" }),
      ]);
      check(results.map((r) => r.job).join() === "a,b", "reversed RPC responses");
      let failed = false;
      try {
        await handle.request({ job: "error" });
      } catch {
        failed = true;
      }
      check(failed, "RPC error missing");
      const ctrl = new AbortController();
      const old = handle
        .request({ job: "old", delay: 30 }, { signal: ctrl.signal })
        .catch(() => null);
      ctrl.abort();
      await old;
      const next = await handle.request<{ job: string }>({ job: "next", delay: 60 });
      check(next.job === "next", "late cancelled reply");
      const raw = await handle.request<{ values: number[] }>({ job: "raw" });
      check(raw.values.join() === "1,2", "TypedArray offset");
    } finally {
      handle.dispose();
    }
  },
  async "strictmode-worker-cleanup"() {
    for (let i = 0; i < 20; i++) {
      mounted = false;
      root.render(
        <StrictMode>
          <Chart />
        </StrictMode>,
      );
      await until(() => mounted, "chart never ready");
      check(liveWorkers === 1, "extra StrictMode worker");
      root.render(null);
      await until(() => liveWorkers === 0, "worker survived unmount");
    }
  },
  async "opfs-isolation-and-clear"() {
    const a = await store(),
      b = await store();
    const origin = await navigator.storage.getDirectory();
    const foreign = await origin.getFileHandle("fluxion-e2e-foreign", { create: true });
    const writer = await foreign.createWritable();
    await writer.write(new Uint8Array([9]));
    await writer.close();
    try {
      await a.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
      await b.writeVideoChunk("cam", "1.chunk", new Uint8Array([2]));
      a.appendFrame(frame(1));
      await a.clearAll();
      await a.flush();
      check((await a.getFrames(0, 2)).length === 0, "clear resurrected pending frames");
      check(
        (await a.readVideoChunk("cam", "1.chunk")) === null,
        "own video survived clear",
      );
      check(
        (await b.readVideoChunk("cam", "1.chunk"))?.[0] === 2,
        "another database was deleted",
      );
      check(
        new Uint8Array(await (await foreign.getFile()).arrayBuffer())[0] === 9,
        "foreign OPFS file deleted",
      );
    } finally {
      await a.clearAll();
      await b.clearAll();
      a.dispose();
      b.dispose();
      await origin.removeEntry("fluxion-e2e-foreign");
    }
  },
  async "legacy-video-read"() {
    const s = await store();
    const origin = await navigator.storage.getDirectory();
    const channelId = `legacy-${Date.now()}`;
    const dir = await origin.getDirectoryHandle(channelId, { create: true });
    const file = await dir.getFileHandle("42.chunk", { create: true });
    const writer = await file.createWritable();
    await writer.write(new Uint8Array([42]));
    await writer.close();
    try {
      s.appendFrame({ ...frame(42), channelId });
      await s.flush();
      check(
        (await s.readVideoChunk(channelId, "42.chunk"))?.[0] === 42,
        "legacy recording unreadable",
      );
      await s.clearAll();
      check(
        (await s.readVideoChunk(channelId, "42.chunk")) === null,
        "cleared legacy reference returned",
      );
      check((await file.getFile()).size === 1, "shared legacy file deleted");
    } finally {
      s.dispose();
      await origin.removeEntry(channelId, { recursive: true });
    }
  },
  async "batch-drain-and-retention"() {
    const s = await store({ batchIntervalMs: 25 });
    const bounded = await store({ retentionMs: 100 });
    try {
      for (let i = 0; i < 5000; i++) s.appendFrame(frame(i));
      await until(() => s.pendingFrameCount === 0, "automatic batch drain stalled");
      check((await s.getFrames(0, 5000)).length === 5000, "missing persisted frames");
      for (const t of [0, 900, 1000]) bounded.appendFrame(frame(t));
      await bounded.flush();
      check(
        (await bounded.getFrames(0, 1000)).map((f) => f.t).join() === "900,1000",
        "retention boundary",
      );
    } finally {
      await s.clearAll();
      await bounded.clearAll();
      s.dispose();
      bounded.dispose();
    }
  },
  async "replay-seek-pause-and-end"() {
    const s = await store();
    const channel = new MetricChannel("metric");
    for (const t of [0, 100, 200, 300])
      s.appendFrame({
        t,
        channelId: "metric",
        payload: channel.encode({ name: "n", value: t }),
      });
    await s.flush();
    const player = new ReplayPlayer({
      store: s,
      channels: new Map([["metric", channel]]),
      timeRange: { earliest: 0, latest: 300 },
    });
    const events: (number | string)[] = [];
    let ended = false;
    player.onFrame((f) => events.push(f.t));
    player.onEnd(() => {
      events.push("end");
      ended = true;
    });
    try {
      player.play();
      await delay(80);
      player.pause();
      const held = player.currentT;
      await delay(40);
      check(player.currentT === held, "pause advances");
      player.seek(100);
      events.length = 0;
      player.play();
      await until(() => ended, "playback never ended");
      check(
        events.join() === "0,100,200,300,end",
        `duplicate/missing endpoint: ${events}`,
      );
    } finally {
      player.dispose();
      await s.clearAll();
      s.dispose();
    }
  },
};
async function storagePerformance(durationMs = 60_000) {
  const s = await store();
  let input = 0,
    peakPending = 0;
  const start = performance.now();
  try {
    while (performance.now() - start < durationMs) {
      for (let i = 0; i < 100; i++) s.appendFrame(frame(input++));
      peakPending = Math.max(peakPending, s.pendingFrameCount);
      await delay(100);
    }
    const drainStart = performance.now();
    await s.flush();
    const drainMs = performance.now() - drainStart;
    const count = (await s.getStorageInfo()).idbFrameCount;
    check(count === input, "sustained recording lost frames");
    check(peakPending < 5000, "unbounded recording backlog");
    return { durationMs, input, count, peakPending, drainMs };
  } finally {
    await s.clearAll();
    s.dispose();
  }
}
Object.assign(window, { reliability: { scenarios, storagePerformance } });
