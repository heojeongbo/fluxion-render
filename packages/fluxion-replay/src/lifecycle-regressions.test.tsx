import type { FluxionHost } from "@heojeongbo/fluxion-render";
import { act, renderHook } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MetricChannel } from "./entities/metric-channel/metric-channel";
import type { ReplayPlayer } from "./features/player/model/replay-player";
import { ReplaySession } from "./features/session/model/replay-session";
import type { ReplayStore } from "./features/store/model/replay-store";
import { poll } from "./shared/lib/poll";
import {
  makeFakeHost,
  makeFakePlayer,
  makeFakeStore,
} from "./widgets/chart-replay/lib/chart-replay-fixtures";
import { useChartReplay } from "./widgets/chart-replay/lib/use-chart-replay";
import { useChartReplayFanOut } from "./widgets/chart-replay/lib/use-chart-replay-fan-out";
import { useDvrController } from "./widgets/dvr/lib/use-dvr-controller";
import { useRecordingSession } from "./widgets/recording/lib/use-recording-session";

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { resolve, reject, promise };
}
const sessions: ReplaySession[] = [];
function session() {
  const s = new ReplaySession({ channels: [new MetricChannel("m")] });
  sessions.push(s);
  return s;
}
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("does not overlap slow polling and ignores a result after cancellation", async () => {
  vi.useFakeTimers();
  const gate = deferred<number>();
  const read = vi.fn(() => gate.promise),
    commit = vi.fn();
  const stop = poll(read, commit, 10);
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledOnce();
  stop();
  gate.resolve(3);
  await settle();
  expect(commit).not.toHaveBeenCalled();
});
it("does not replace a newer session mode after an older entry fails", async () => {
  const s = session();
  await s.open();
  await s.startRecording();
  await s.startRecording();
  expect(s.getSegments()).toHaveLength(1);
  const gate = deferred<void>();
  vi.spyOn(s.store, "flush").mockImplementationOnce(() => gate.promise);
  const first = s.enterReplay().catch((e) => e);
  const newer = await s.enterReplay();
  gate.reject(new Error("old entry"));
  await first;
  expect(s.player).toBe(newer);
  expect(s.mode).toBe("replay");
});
it("applies a changed playback rate immediately to a playing DVR player", async () => {
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
  await act(async () => {
    await view.result.current.dvr.enter();
  });
  act(() => {
    p.emitState("playing");
    view.result.current.setRate(3);
  });
  expect(p.play).toHaveBeenLastCalledWith(3);
});
function usePendingCharts(store: ReplayStore, player: ReplayPlayer) {
  const { host, handle } = useMemo(makeFakeHost, []);
  const channel = useMemo(() => new MetricChannel("m"), []);
  useChartReplay({
    host: host as unknown as FluxionHost,
    player,
    store,
    channel,
    windowMs: 1000,
    pickValue: (d) => d.value,
  });
  useChartReplayFanOut({
    player,
    store,
    channel,
    windowMs: 1000,
    getSources: () => [
      {
        host: host as unknown as FluxionHost,
        lines: [{ layerId: "m", pick: (d) => d.value }],
      },
    ],
  });
  return handle;
}
it("does not commit either chart cache after its subscription was disposed", async () => {
  const gate = deferred<never[]>();
  const store = makeFakeStore({});
  store.getFramesByChannel.mockImplementation(() => gate.promise);
  const p = makeFakePlayer(5000);
  const view = renderHook(() =>
    usePendingCharts(store as unknown as ReplayStore, p as unknown as ReplayPlayer),
  );
  const handle = view.result.current;
  view.unmount();
  await act(async () => {
    gate.resolve([]);
    await settle();
  });
  expect(handle.reset).not.toHaveBeenCalled();
});
it("a stale start cannot stop the next recording cycle on the same session", async () => {
  const s = session();
  const gate = deferred<void>();
  vi.spyOn(s, "startRecording").mockImplementationOnce(() => gate.promise);
  const view = renderHook(
    ({ enabled }) => useRecordingSession({ session: s, enabled, clearOnStart: false }),
    { initialProps: { enabled: true } },
  );
  await act(settle);
  view.rerender({ enabled: false });
  view.rerender({ enabled: true });
  await act(settle);
  await act(async () => {
    gate.resolve();
    await settle();
  });
  expect(s.recorder.isRecording).toBe(true);
});
it("stops a pending start owned by the previous session", async () => {
  const old = session(),
    next = session();
  const gate = deferred<void>();
  vi.spyOn(old, "startRecording").mockImplementationOnce(() => gate.promise);
  const stop = vi.spyOn(old, "stopRecording");
  const view = renderHook(
    ({ s }) => useRecordingSession({ session: s, enabled: true, clearOnStart: false }),
    { initialProps: { s: old } },
  );
  await act(settle);
  view.rerender({ s: next });
  await act(settle);
  stop.mockClear();
  await act(async () => {
    gate.resolve();
    await settle();
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(next.recorder.isRecording).toBe(true);
});
it("uses the latest producer and stops emitting removed ticker channels", async () => {
  vi.useFakeTimers();
  const s = session();
  const first = vi.fn(() => ({ name: "m", value: 1 })),
    next = vi.fn(() => ({ name: "m", value: 2 }));
  const view = renderHook(
    ({ channels }) =>
      useRecordingSession({ session: s, enabled: true, clearOnStart: false, channels }),
    { initialProps: { channels: [{ channelId: "m", intervalMs: 10, produce: first }] } },
  );
  await act(settle);
  view.rerender({ channels: [{ channelId: "m", intervalMs: 10, produce: next }] });
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(next).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  view.rerender({ channels: [] });
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(next).toHaveBeenCalledOnce();
});

it("cancels a cache-hit hydrate before either chart is mutated", async () => {
  const store = makeFakeStore({});
  const p = makeFakePlayer(5000);
  const view = renderHook(() =>
    usePendingCharts(store as unknown as ReplayStore, p as unknown as ReplayPlayer),
  );
  await act(settle);
  const handle = view.result.current;
  handle.reset.mockClear();
  act(() => {
    p.emitSeek(5000);
    view.unmount();
  });
  await act(settle);
  expect(handle.reset).not.toHaveBeenCalled();
});
it("does not resume a recording stopped during asynchronous clear", async () => {
  const s = session();
  await s.open();
  await s.startRecording();
  const gate = deferred<void>();
  vi.spyOn(s.store, "clearAll").mockImplementationOnce(() => gate.promise);
  const clear = s.clearRecording();
  s.stopRecording();
  gate.resolve();
  await clear;
  expect(s.recorder.isRecording).toBe(false);
});
it("invalidates both chart caches when the same store replaces its recording", async () => {
  const store = makeFakeStore({});
  const mutable = Object.assign(store, { recordingGeneration: 0 });
  const p = makeFakePlayer(5000);
  const view = renderHook(() =>
    usePendingCharts(mutable as unknown as ReplayStore, p as unknown as ReplayPlayer),
  );
  await act(settle);
  store.getFramesByChannel.mockClear();
  mutable.recordingGeneration++;
  act(() => p.emitSeek(5000));
  await act(settle);
  expect(store.getFramesByChannel).toHaveBeenCalledTimes(2);
  const gate = deferred<never[]>();
  store.getFramesByChannel.mockImplementation(() => gate.promise);
  act(() => p.emitSeek(15000));
  mutable.recordingGeneration++;
  view.result.current.reset.mockClear();
  await act(async () => {
    gate.resolve([]);
    await settle();
  });
  expect(view.result.current.reset).not.toHaveBeenCalled();
});
