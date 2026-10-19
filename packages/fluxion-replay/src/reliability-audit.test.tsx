import type { FluxionHost } from "@heojeongbo/fluxion-render";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MetricChannel } from "./entities/metric-channel/metric-channel";
import { VideoChannel } from "./entities/video-channel/video-channel";
import type { ReplayPlayer } from "./features/player/model/replay-player";
import { ReplayRecorder } from "./features/recorder/model/replay-recorder";
import { ReplaySession } from "./features/session/model/replay-session";
import { ReplayStore } from "./features/store/model/replay-store";
import { VideoRecorder } from "./features/video/model/video-recorder";
import {
  makeFakeHost,
  makeFakePlayer,
  makeFakeStore,
  metricFrame,
} from "./widgets/chart-replay/lib/chart-replay-fixtures";
import { useChartReplay } from "./widgets/chart-replay/lib/use-chart-replay";
import { useChartReplayFanOut } from "./widgets/chart-replay/lib/use-chart-replay-fan-out";
import { useReplayDvr } from "./widgets/dvr/lib/use-replay-dvr";
import { useDisplayMedia } from "./widgets/media/lib/use-display-media";
import { useRecordingSession } from "./widgets/recording/lib/use-recording-session";

const disposers: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function session() {
  const s = new ReplaySession({ channels: [new MetricChannel("m")] });
  disposers.push(() => s.dispose());
  return s;
}
it("AUDIT-R1: StrictMode must finish starting the recording", async () => {
  const s = session();
  await s.open();
  const view = renderHook(() => useRecordingSession({ session: s, enabled: true }), {
    wrapper: StrictMode,
  });
  await act(settle);
  expect(view.result.current.isRecording).toBe(true);
  expect(s.recorder.isRecording).toBe(true);
});
it("AUDIT-R2: disable and re-enable must stop then resume recording", async () => {
  const s = session();
  await s.open();
  const view = renderHook(
    ({ enabled }) => useRecordingSession({ session: s, enabled, clearOnStart: false }),
    { initialProps: { enabled: true } },
  );
  await act(settle);
  view.rerender({ enabled: false });
  const runningWhileDisabled = s.recorder.isRecording;
  view.rerender({ enabled: true });
  await act(settle);
  expect({ runningWhileDisabled, resumed: view.result.current.isRecording }).toEqual({
    runningWhileDisabled: false,
    resumed: true,
  });
});
it("AUDIT-R3: a display capture permission result after unmount must stop its tracks", async () => {
  let release!: (s: MediaStream) => void;
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const view = renderHook(() => useDisplayMedia());
  let pending!: Promise<MediaStream>;
  act(() => {
    pending = view.result.current.start();
  });
  view.unmount();
  await act(async () => {
    release(stream);
    await pending;
  });
  expect(stop).toHaveBeenCalledOnce();
});
it("AUDIT-R4: a pending DVR entry after unmount must not start an orphan player", async () => {
  const s = session();
  const p = makeFakePlayer(0);
  let release!: (p: ReplayPlayer | null) => void;
  const view = renderHook(() =>
    useReplayDvr({
      session: s,
      enterReplay: () =>
        new Promise((r) => {
          release = r;
        }),
      exitReplay: vi.fn(),
      liveTimeRange: { earliest: 0, latest: 100 },
    }),
  );
  let pending!: ReturnType<typeof view.result.current.enter>;
  act(() => {
    pending = view.result.current.enter();
  });
  view.unmount();
  await act(async () => {
    release(p as unknown as ReplayPlayer);
    await pending;
  });
  expect(p.play).not.toHaveBeenCalled();
  expect(p.dispose).toHaveBeenCalledOnce();
});
for (const fanOut of [false, true])
  it(`AUDIT-R5: ${fanOut ? "fan-out" : "single"} hydrate cache must be scoped to the channel`, async () => {
    const { host, handle } = makeFakeHost();
    const p = makeFakePlayer(5000);
    const a = new MetricChannel("a"),
      b = new MetricChannel("b");
    const store = makeFakeStore({
      a: [metricFrame("a", 4000, 1)],
      b: [metricFrame("b", 4000, 9)],
    });
    const view = renderHook(
      ({ channel }) => {
        useChartReplayFanOut({
          player: fanOut ? (p as unknown as ReplayPlayer) : null,
          store: store as unknown as ReplayStore,
          channel,
          windowMs: 2000,
          getSources: () => [
            {
              host: host as unknown as FluxionHost,
              lines: [{ layerId: "line", pick: (d) => d.value }],
            },
          ],
        });
        useChartReplay({
          host: host as unknown as FluxionHost,
          player: fanOut ? null : (p as unknown as ReplayPlayer),
          store: store as unknown as ReplayStore,
          channel,
          windowMs: 2000,
          pickValue: (d) => d.value,
          layerId: "line",
        });
      },
      { initialProps: { channel: a } },
    );
    await act(settle);
    handle.pushBatch.mockClear();
    view.rerender({ channel: b });
    await act(settle);
    expect(handle.pushBatch.mock.calls.at(-1)?.[0]).toEqual([{ t: 4000, y: 9 }]);
  });
it("AUDIT-R6: retention must not leave metadata pointing to deleted video chunks", async () => {
  const store = new ReplayStore({
    dbName: "audit-eviction",
    evictThresholdPct: 100,
    retentionMs: 100,
  });
  disposers.push(() => store.dispose());
  await store.open();
  for (let t = 0; t < 1001; t++) {
    await store.writeVideoChunk("cam", `${t}.chunk`, new Uint8Array([1]));
    store.appendFrame({ t, channelId: "cam", payload: new ArrayBuffer(0) });
  }
  await store.flush();
  const retained = await store.getFrames(0, 1001);
  const first = retained[0];
  expect(first.t).toBeGreaterThanOrEqual(500);
  expect(await store.readVideoChunk("cam", `${first.t}.chunk`)).not.toBeNull();
});
it("AUDIT-R7: entering replay failure must restore quota eviction", async () => {
  const s = session();
  await s.open();
  vi.spyOn(s.store, "flush").mockRejectedValueOnce(new Error("write failed"));
  const pause = vi.spyOn(s.store, "setEvictionPaused");
  await expect(s.enterReplay()).rejects.toThrow("write failed");
  expect(pause.mock.calls.at(-1)).toEqual([false]);
});
it("AUDIT-R8: an in-flight video write must retain frame dimensions after stop", async () => {
  const s = new ReplayStore({ dbName: "audit-video" });
  await s.open();
  disposers.push(() => s.dispose());
  const rec = new ReplayRecorder({ store: s, channels: [new VideoChannel("cam")] });
  rec.start();
  const record = vi.spyOn(rec, "record");
  let output!: VideoEncoderInit["output"];
  class Encoder {
    constructor(init: VideoEncoderInit) {
      output = init.output;
    }
    configure() {}
    encode() {}
    close() {}
  }
  vi.stubGlobal("VideoEncoder", Encoder);
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = new ReadableStream({
        start(c) {
          c.enqueue({
            timestamp: 1000,
            displayWidth: 640,
            displayHeight: 480,
            close() {},
          });
          c.close();
        },
      });
    },
  );
  let release!: () => void;
  const writer = {
    writeVideoChunk: () =>
      new Promise<void>((r) => {
        release = r;
      }),
  };
  const vr = new VideoRecorder({ store: writer, recorder: rec, channelId: "cam" });
  await vr.start({} as MediaStreamTrack);
  await settle();
  output(
    new EncodedVideoChunk({
      type: "key",
      timestamp: 1000,
      duration: 33333,
      data: new Uint8Array([1]),
    }),
    {},
  );
  vr.stop();
  release();
  await settle();
  expect(record.mock.calls[0][1]).toMatchObject({ codedWidth: 640, codedHeight: 480 });
});
it("AUDIT-R9: stored playback rate must apply when entering the next DVR cycle", async () => {
  const { useDvrController } = await import("./widgets/dvr/lib/use-dvr-controller");
  const s = session(),
    p = makeFakePlayer(0);
  const view = renderHook(() =>
    useDvrController({
      session: s,
      enterReplay: async () => p as unknown as ReplayPlayer,
      exitReplay: vi.fn(),
      liveTimeRange: { earliest: 0, latest: 100 },
    }),
  );
  act(() => view.result.current.setRate(2));
  await act(async () => {
    await view.result.current.dvr.enter();
  });
  expect(p.play).toHaveBeenLastCalledWith(2);
});
it("quota eviction catches up with sustained 1000 frames per second ingestion", async () => {
  vi.useFakeTimers();
  const store = new ReplayStore({
    dbName: "audit-quota-throughput",
    evictThresholdPct: 70,
  });
  vi.spyOn(navigator.storage, "estimate").mockResolvedValue({ usage: 80, quota: 100 });
  await store.open();
  try {
    for (let tick = 0; tick < 20; tick++) {
      for (let i = 0; i < 500; i++)
        store.appendFrame({
          t: tick * 500 + i,
          channelId: "m",
          payload: new ArrayBuffer(4),
        });
      await vi.advanceTimersByTimeAsync(500);
    }
    const count = (await store.getStorageInfo()).idbFrameCount;
    expect(count).toBeLessThan(5500);
  } finally {
    store.dispose();
    vi.useRealTimers();
  }
});
