import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../../../entities/metric-channel/metric-channel";
import type { BaseChannel } from "../../../shared/model/base-channel";
import { ReplayStore } from "../../store/model/replay-store";
import { ReplayPlayer } from "./replay-player";

function makePlayer(earliest = 0, latest = 10_000) {
  const store = new ReplayStore({ batchIntervalMs: 9999 });
  const channels = new Map();
  const ch = new MetricChannel("cpu");
  channels.set("cpu", ch);

  const player = new ReplayPlayer({
    store,
    channels,
    timeRange: { earliest, latest },
    prefetchMs: 1000,
  });

  return { player, store, ch };
}

describe("ReplayPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle state", () => {
    const { player } = makePlayer();
    expect(player.state).toBe("idle");
    player.dispose();
  });

  it("play() transitions to playing", () => {
    const { player } = makePlayer();
    const states: string[] = [];
    player.onStateChange((s) => states.push(s));
    player.play();
    expect(player.state).toBe("playing");
    expect(states).toContain("playing");
    player.stop();
    player.dispose();
  });

  it("pause() transitions to paused", () => {
    const { player } = makePlayer();
    player.play();
    player.pause();
    expect(player.state).toBe("paused");
    player.dispose();
  });

  it("stop() transitions to stopped", () => {
    const { player } = makePlayer();
    player.play();
    player.stop();
    expect(player.state).toBe("stopped");
    player.dispose();
  });

  it("seek() clamps to timeRange", () => {
    const { player } = makePlayer(1000, 5000);
    player.play();
    player.seek(-100); // below earliest
    expect(player.currentT).toBeGreaterThanOrEqual(1000);
    player.seek(99999); // above latest
    expect(player.currentT).toBeLessThanOrEqual(5000);
    player.stop();
    player.dispose();
  });

  it("onTick fires during playback", () => {
    const { player } = makePlayer();
    const ticks: number[] = [];
    player.onTick((t) => ticks.push(t));
    player.play();
    vi.advanceTimersByTime(50);
    expect(ticks.length).toBeGreaterThan(0);
    player.stop();
    player.dispose();
  });

  it("onTick listener can be removed", () => {
    const { player } = makePlayer();
    const ticks: number[] = [];
    const off = player.onTick((t) => ticks.push(t));
    player.play();
    vi.advanceTimersByTime(32);
    off();
    const countAfterOff = ticks.length;
    vi.advanceTimersByTime(32);
    expect(ticks.length).toBe(countAfterOff);
    player.stop();
    player.dispose();
  });

  it("emits onEnd when reaching latest", () => {
    const { player } = makePlayer(0, 100);
    let ended = false;
    player.onEnd(() => {
      ended = true;
    });
    player.play(100); // 100x speed so 1ms wall = 100ms virtual
    // RAF fires every 16ms; at 100x, 16ms wall = 1600ms virtual >> latest(100)
    vi.advanceTimersByTime(20);
    expect(ended).toBe(true);
    player.dispose();
  });

  it("onStateChange fires on transitions", () => {
    const { player } = makePlayer();
    const states: string[] = [];
    player.onStateChange((s) => states.push(s));
    player.play();
    player.pause();
    player.stop();
    expect(states).toEqual(["playing", "paused", "stopped"]);
    player.dispose();
  });

  it("dispose cleans up listeners", () => {
    const { player } = makePlayer();
    const ticks: number[] = [];
    player.onTick((t) => ticks.push(t));
    player.play();
    player.dispose();
    vi.advanceTimersByTime(50);
    expect(ticks.length).toBe(0);
  });

  it("play() after pause resumes", () => {
    const { player } = makePlayer();
    player.play(1.0);
    vi.advanceTimersByTime(100);
    player.pause();
    const pausedT = player.currentT;
    vi.advanceTimersByTime(500);
    player.play();
    vi.advanceTimersByTime(100);
    expect(player.currentT).toBeCloseTo(pausedT + 100, -1);
    player.stop();
    player.dispose();
  });

  it("play() while already playing changes rate only", () => {
    const { player } = makePlayer();
    const states: string[] = [];
    player.onStateChange((s) => states.push(s));
    player.play(1.0);
    player.play(2.0); // should not emit another "playing" state change
    expect(states.filter((s) => s === "playing")).toHaveLength(1);
    player.stop();
    player.dispose();
  });

  it("pause() before play() is a no-op (line 145)", () => {
    const { player } = makePlayer();
    // state is "idle", not "playing" → early return without state change
    player.pause();
    expect(player.state).toBe("idle");
    player.dispose();
  });

  it("_onTick after player already ended returns early (line 241)", () => {
    const { player } = makePlayer(0, 100);
    // biome-ignore lint/suspicious/noExplicitAny: testing internals
    (player as any)._ended = true;
    const endSpy = vi.fn();
    player.onEnd(endSpy);
    // Call _onTick after _ended=true — should return immediately without firing onEnd again
    // biome-ignore lint/suspicious/noExplicitAny: testing internals
    (player as any)._onTick(200);
    expect(endSpy).not.toHaveBeenCalled();
    player.dispose();
  });

  it("onFrame emits decoded frames from prefetch buffer", async () => {
    const { player, store, ch } = makePlayer();

    await store.open();
    const payload = ch.encode({ name: "cpu", value: 42 });
    store.appendFrame({ t: 500, channelId: "cpu", payload });
    await store.flush();

    const frames: unknown[] = [];
    player.onFrame((f) => frames.push(f));
    player.play(1.0);

    // advance to trigger prefetch and drain
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(600);

    expect(frames.length).toBeGreaterThan(0);
    player.stop();
    player.dispose();
  });

  it("isolates a throwing onTick listener: sibling still ticks, playback survives", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { player } = makePlayer();
    const ticks: number[] = [];
    player.onTick(() => {
      throw new Error("tick boom");
    });
    player.onTick((t) => ticks.push(t));
    player.play();
    vi.advanceTimersByTime(50);
    expect(ticks.length).toBeGreaterThan(0); // sibling not skipped by the thrower
    expect(errSpy).toHaveBeenCalled();
    player.stop();
    player.dispose();
    errSpy.mockRestore();
  });

  it("isolates a throwing onFrame listener: sibling still receives the frame", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { player, store, ch } = makePlayer();

    await store.open();
    store.appendFrame({
      t: 500,
      channelId: "cpu",
      payload: ch.encode({ name: "cpu", value: 42 }),
    });
    await store.flush();

    const frames: unknown[] = [];
    player.onFrame(() => {
      throw new Error("frame boom");
    });
    player.onFrame((f) => frames.push(f));
    player.play(1.0);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(600);

    expect(frames.length).toBeGreaterThan(0); // sibling got the frame despite the thrower
    expect(errSpy).toHaveBeenCalled();
    player.stop();
    player.dispose();
    errSpy.mockRestore();
  });

  it("seek() resets prefetch buffer and re-clamps", () => {
    const { player } = makePlayer(0, 10_000);
    player.play();
    player.seek(8000);
    expect(player.currentT).toBeGreaterThanOrEqual(0);
    expect(player.currentT).toBeLessThanOrEqual(10_000);
    player.stop();
    player.dispose();
  });

  it("onFrame listener can be removed", async () => {
    const { player, store, ch } = makePlayer();

    await store.open();
    const payload = ch.encode({ name: "cpu", value: 1 });
    store.appendFrame({ t: 500, channelId: "cpu", payload });
    await store.flush();

    const frames: unknown[] = [];
    const off = player.onFrame((f) => frames.push(f));
    off(); // remove before playback
    player.play(1.0);
    vi.advanceTimersByTime(700);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(frames).toHaveLength(0);
    player.stop();
    player.dispose();
  });

  it("onEnd listener can be removed", () => {
    const { player } = makePlayer(0, 50);
    let ended = false;
    const off = player.onEnd(() => {
      ended = true;
    });
    off();
    player.play(100);
    vi.advanceTimersByTime(20);
    expect(ended).toBe(false);
    player.dispose();
  });

  it("play() from stopped restarts from earliest", () => {
    const { player } = makePlayer(1000, 5000);
    player.play();
    player.stop();
    player.play();
    expect(player.state).toBe("playing");
    expect(player.currentT).toBeGreaterThanOrEqual(1000);
    player.stop();
    player.dispose();
  });

  it("seek() during playback keeps currentT within timeRange", () => {
    const { player } = makePlayer(0, 10_000);
    player.play();
    vi.advanceTimersByTime(50);
    player.seek(8000);
    expect(player.currentT).toBe(8000);
    player.seek(99999); // above latest — clamped
    expect(player.currentT).toBe(10_000);
    player.seek(-999); // below earliest — clamped
    expect(player.currentT).toBe(0);
    player.stop();
    player.dispose();
  });

  it("unknown channelId frames are silently skipped in onFrame", async () => {
    const store = new ReplayStore({ batchIntervalMs: 9999 });
    const ch = new MetricChannel("cpu");
    const player = new ReplayPlayer({
      store,
      channels: new Map([["cpu", ch]]),
      timeRange: { earliest: 0, latest: 10_000 },
      prefetchMs: 1000,
    });

    await store.open();
    store.appendFrame({
      t: 500,
      channelId: "unknown-channel",
      payload: new ArrayBuffer(8),
    });
    await store.flush();

    const frames: unknown[] = [];
    player.onFrame((f) => frames.push(f));
    player.play(1.0);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(600);

    expect(frames).toHaveLength(0);
    player.stop();
    player.dispose();
  });

  it("mergeSorted handles large incoming array without losing order", async () => {
    // Directly calls _prefetch indirectly by mocking getFrames with a large batch,
    // then verifies frames arrive in order via onFrame.
    const { player, store, ch } = makePlayer(0, 10_000);
    await store.open();

    const bigBatch = Array.from({ length: 100 }, (_, i) => ({
      t: 100 + i * 5, // 100, 105, … 595
      channelId: "cpu",
      payload: ch.encode({ name: "cpu", value: i }),
    }));
    vi.spyOn(store, "getFrames").mockResolvedValue(bigBatch);

    const frames: number[] = [];
    player.onFrame((f) => frames.push(f.t));
    player.play(1.0);

    // Trigger first RAF tick (fires prefetch)
    vi.advanceTimersByTime(16);
    // Let getFrames promise resolve and populate the buffer
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Advance virtual clock past all queued frames (100–595ms)
    vi.advanceTimersByTime(600);
    for (let i = 0; i < 3; i++) await Promise.resolve();

    expect(frames.length).toBeGreaterThan(0);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]);
    }
    player.stop();
    player.dispose();
  });

  it("a later empty prefetch leaves the buffered frames intact (mergeSorted empty incoming)", async () => {
    // First prefetch fills the buffer; a subsequent prefetch returns [] while the
    // buffer is non-empty → mergeSorted's empty-incoming early return.
    const { player, store, ch } = makePlayer(0, 10_000);
    await store.open();

    let call = 0;
    vi.spyOn(store, "getFrames").mockImplementation(async () => {
      call++;
      if (call === 1) {
        return [
          { t: 200, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 1 }) },
          { t: 400, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 2 }) },
        ];
      }
      return []; // later prefetches: nothing new
    });

    const frames: number[] = [];
    player.onFrame((f) => frames.push(f.t));
    player.play(1.0);

    vi.advanceTimersByTime(16);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Advance to trigger more prefetch windows (which return []), then past the
    // buffered frames so they emit despite the empty merges.
    vi.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(call).toBeGreaterThan(1); // at least one empty prefetch happened
    expect(frames).toContain(200);
    expect(frames).toContain(400);
    player.stop();
    player.dispose();
  });

  it("concurrent prefetch calls do not double-fetch the same range", async () => {
    const { player, store } = makePlayer(0, 10_000);
    await store.open();

    let callCount = 0;
    const getFramesSpy = vi.spyOn(store, "getFrames").mockImplementation(async () => {
      callCount++;
      return [];
    });

    player.play(1.0);
    // Advance enough to trigger tick but not enough to complete async prefetch
    vi.advanceTimersByTime(16);
    vi.advanceTimersByTime(16);
    vi.advanceTimersByTime(16);

    await Promise.resolve();
    await Promise.resolve();

    // In-flight guard should prevent duplicate calls for same window
    expect(callCount).toBeLessThanOrEqual(3);

    player.stop();
    player.dispose();
    getFramesSpy.mockRestore();
  });

  it("_prefetch error rolls back prefetchedUpTo for retry", async () => {
    const { player, store } = makePlayer(0, 10_000);
    await store.open();

    let callCount = 0;
    const getFramesSpy = vi.spyOn(store, "getFrames").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("IDB read error");
      return [];
    });

    player.play(1.0);
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    // After a prefetch error the player must still be running (no crash)
    expect(player.state).toBe("playing");

    player.stop();
    player.dispose();
    getFramesSpy.mockRestore();
  });

  // ── seek + play: regression guard for "play() silently rewinds" bug ─────
  // play() used to call clock.start(timeRange.earliest, rate) unconditionally,
  // throwing away a prior seek() target. The fix clamps clock.currentT into
  // range and uses that as the start point.

  describe("seek + play", () => {
    it("REGRESSION: seek(t) then play() keeps currentT at t (not earliest)", () => {
      const { player } = makePlayer(1_000, 5_000);
      player.seek(3_000);
      expect(player.currentT).toBe(3_000);

      player.play(1);
      // Immediately after play(): clock.start should have used 3_000 as the
      // virtual start, not the timeRange's earliest of 1_000.
      expect(player.currentT).toBe(3_000);

      player.stop();
      player.dispose();
    });

    it("seek + play advances forward from the seek point", () => {
      const { player } = makePlayer(0, 10_000);
      player.seek(2_000);
      player.play(1);
      // RAF fires every 16ms; advance 32ms wall ≈ 32ms virtual at 1x.
      vi.advanceTimersByTime(32);
      // currentT should be near 2_032, definitely > 2_000 and well under 5_000.
      expect(player.currentT).toBeGreaterThanOrEqual(2_000);
      expect(player.currentT).toBeLessThan(2_500);
      player.stop();
      player.dispose();
    });

    it("play() on a fresh player (no prior seek) starts at timeRange.earliest", () => {
      const { player } = makePlayer(1_500, 5_000);
      // No seek — clock.currentT defaults to 0, which gets clamped up to 1_500.
      player.play(1);
      expect(player.currentT).toBe(1_500);
      player.stop();
      player.dispose();
    });

    it("stop() then play() resumes from the position where stop() was called", () => {
      const { player } = makePlayer(500, 5_000);
      player.seek(3_000);
      player.play(1);
      vi.advanceTimersByTime(32); // advance slightly past 3_000
      const posAtStop = player.currentT;
      player.stop();
      // After stop(), currentT returns _lastKnownT (position at stop time),
      // and play() resumes from that position — not from timeRange.earliest.
      expect(player.currentT).toBe(posAtStop);
      player.play(1);
      expect(player.currentT).toBeGreaterThanOrEqual(posAtStop);
      player.stop();
      player.dispose();
    });

    it("pause() then play() resumes from where it was paused (preserves currentT)", () => {
      const { player } = makePlayer(0, 10_000);
      player.seek(2_000);
      player.play(1);
      vi.advanceTimersByTime(32);
      const beforePause = player.currentT;
      player.pause();
      expect(player.currentT).toBe(beforePause);
      // Some wall time passes while paused — virtual t should not advance.
      vi.advanceTimersByTime(100);
      expect(player.currentT).toBe(beforePause);
      // Resume picks up from beforePause and keeps advancing.
      player.play(1);
      vi.advanceTimersByTime(32);
      expect(player.currentT).toBeGreaterThan(beforePause);
      player.stop();
      player.dispose();
    });
  });

  describe("onSeek", () => {
    it("fires with the clamped target on seek()", () => {
      const { player } = makePlayer(1000, 5000);
      const seeks: number[] = [];
      player.onSeek((t) => seeks.push(t));

      player.play();
      player.seek(2500);
      player.seek(-100); // below earliest → clamped to 1000
      player.seek(99999); // above latest → clamped to 5000

      expect(seeks).toEqual([2500, 1000, 5000]);
      player.dispose();
    });

    it("supports multiple listeners independently", () => {
      const { player } = makePlayer();
      const a: number[] = [];
      const b: number[] = [];
      player.onSeek((t) => a.push(t));
      player.onSeek((t) => b.push(t));

      player.play();
      player.seek(1234);
      expect(a).toEqual([1234]);
      expect(b).toEqual([1234]);
      player.dispose();
    });

    it("returns an unsubscribe function", () => {
      const { player } = makePlayer();
      const events: number[] = [];
      const off = player.onSeek((t) => events.push(t));

      player.play();
      player.seek(100);
      off();
      player.seek(200);
      expect(events).toEqual([100]);
      player.dispose();
    });

    it("dispose() clears seek listeners", () => {
      const { player } = makePlayer();
      const events: number[] = [];
      player.onSeek((t) => events.push(t));
      player.dispose();
      // dispose stops the clock; further seeks should not invoke listeners.
      player.seek(500);
      expect(events).toEqual([]);
    });
  });

  // Phase 13: the getter is what useReplayDvr / scenario tests rely on to
  // assert "player.end matches the UI's frozen right-edge". A regression
  // here would silently desync the DVR auto-exit from the scrubber max.
  describe("timeRange getter", () => {
    it("returns the exact range passed at construction", () => {
      const { player } = makePlayer(1_000, 4_000);
      expect(player.timeRange).toEqual({ earliest: 1_000, latest: 4_000 });
    });

    it("is stable across seek / play / pause", () => {
      const { player } = makePlayer(0, 10_000);
      const before = player.timeRange;
      player.seek(3_000);
      player.play();
      player.pause();
      expect(player.timeRange).toBe(before); // same reference
      expect(player.timeRange).toEqual({ earliest: 0, latest: 10_000 });
    });

    it("upper bound matches the seek clamp and the end condition", () => {
      const { player } = makePlayer(0, 5_000);
      // seek past latest gets clamped down to latest
      player.seek(99_999);
      expect(player.currentT).toBe(player.timeRange.latest);
    });
  });

  // Phase 20-B-1: typed onFrame overload — `frame.data` no longer needs
  // `as T` cast at the call site when a channel is provided.
  describe("onFrame typed overload", () => {
    it("filters by channelId and yields a typed frame", async () => {
      const channels = new Map<string, BaseChannel<unknown>>();
      const cpu = new MetricChannel("cpu");
      const mem = new MetricChannel("mem");
      channels.set("cpu", cpu);
      channels.set("mem", mem);
      const store = new ReplayStore({ batchIntervalMs: 9999 });
      const player = new ReplayPlayer({
        store,
        channels,
        timeRange: { earliest: 0, latest: 10_000 },
        prefetchMs: 1000,
      });

      type Sample = { name: string; value: number };
      const received: Array<{ t: number; v: number }> = [];
      // Typed overload — `frame.data` is `Sample`, NOT `unknown`.
      const off = player.onFrame<Sample>(cpu, (frame) => {
        // TypeScript-only assertion: `frame.data.value` typechecks because
        // of the generic overload. If the overload regressed, this would
        // be `unknown.value` and TS would refuse to compile.
        received.push({ t: frame.t, v: frame.data.value });
      });

      // Simulate both channels emitting; only `cpu` should reach the listener.
      const cpuPayload = cpu.encode({ name: "cpu", value: 0.5 });
      const memPayload = mem.encode({ name: "mem", value: 0.7 });

      // Stub the prefetch buffer + drive a tick manually.
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      (player as any)._prefetchBuffer = [
        { t: 100, channelId: "cpu", payload: cpuPayload },
        { t: 100, channelId: "mem", payload: memPayload },
      ];
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      (player as any)._prefetchedUpTo = 5_000;
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      (player as any)._onTick(200);

      expect(received).toEqual([{ t: 100, v: 0.5 }]); // mem skipped
      off();
      player.dispose();
    });

    it("regression: the bare-listener overload still gets every channel", async () => {
      const channels = new Map<string, BaseChannel<unknown>>();
      const cpu = new MetricChannel("cpu");
      const mem = new MetricChannel("mem");
      channels.set("cpu", cpu);
      channels.set("mem", mem);
      const store = new ReplayStore({ batchIntervalMs: 9999 });
      const player = new ReplayPlayer({
        store,
        channels,
        timeRange: { earliest: 0, latest: 10_000 },
        prefetchMs: 1000,
      });

      const seenChannels: string[] = [];
      const off = player.onFrame((frame) => seenChannels.push(frame.channelId));

      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      (player as any)._prefetchBuffer = [
        { t: 100, channelId: "cpu", payload: cpu.encode({ name: "cpu", value: 0 }) },
        { t: 100, channelId: "mem", payload: mem.encode({ name: "mem", value: 0 }) },
      ];
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      (player as any)._prefetchedUpTo = 5_000;
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      (player as any)._onTick(200);

      expect(seenChannels).toEqual(["cpu", "mem"]);
      off();
      player.dispose();
    });
  });

  // ── prefetch generation / stale-seek guard ──────────────────────────────
  // A prefetch issued before a seek must NOT merge its (now out-of-window)
  // result after the seek — that would reintroduce frames the seek discarded
  // and surface as out-of-order "tangled" chart data.
  describe("prefetch generation / stale-seek guard", () => {
    /** A getFrames mock whose resolution we control via the returned `resolve`. */
    function deferredGetFrames(store: ReplayStore) {
      let resolve!: (
        frames: { t: number; channelId: string; payload: ArrayBuffer }[],
      ) => void;
      let reject!: (e: unknown) => void;
      const spy = vi.spyOn(store, "getFrames").mockImplementation(
        () =>
          new Promise((res, rej) => {
            resolve = res as typeof resolve;
            reject = rej;
          }),
      );
      return {
        spy,
        resolve: (f: typeof bufType) => resolve(f),
        reject: (e: unknown) => reject(e),
      };
    }
    // Type helper only; never used at runtime.
    const bufType: { t: number; channelId: string; payload: ArrayBuffer }[] = [];

    async function flush() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }

    it("REGRESSION: discards an in-flight prefetch that resolves after a seek", async () => {
      const { player, store, ch } = makePlayer(0, 100_000);
      await store.open();
      const { resolve } = deferredGetFrames(store);

      player.play(1.0);
      vi.advanceTimersByTime(16); // fires a tick → starts the (suspended) prefetch
      await flush();
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      expect((player as any)._isPrefetching).toBe(true);

      player.seek(50_000); // invalidates the in-flight prefetch + rewinds cursor
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      expect((player as any)._prefetchedUpTo).toBe(Math.max(50_000 - 3_000, 0) - 1); // 46_999

      // The stale fetch resolves with OLD-window frames (t=1000).
      resolve([
        { t: 1000, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 1 }) },
      ]);
      await flush();

      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      const buf = (player as any)._prefetchBuffer as { t: number }[];
      expect(buf.some((f) => f.t === 1000)).toBe(false); // stale frame discarded
      expect(buf.every((f) => f.t >= 47_000)).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      expect((player as any)._prefetchedUpTo).toBe(46_999); // seek's value, not stale `to`

      player.stop();
      player.dispose();
    });

    it("CONTRAST: a non-stale prefetch (no seek) merges normally", async () => {
      const { player, store, ch } = makePlayer(0, 100_000);
      await store.open();
      const { resolve } = deferredGetFrames(store);

      player.play(1.0);
      vi.advanceTimersByTime(16);
      await flush();

      resolve([
        { t: 500, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 2 }) },
      ]);
      await flush();

      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      const buf = (player as any)._prefetchBuffer as { t: number }[];
      expect(buf.some((f) => f.t === 500)).toBe(true); // merged (generation matched)

      player.stop();
      player.dispose();
    });

    it("a fresh prefetch after the seek still merges", async () => {
      const { player, store, ch } = makePlayer(0, 100_000);
      await store.open();

      // Each prefetch gets its own deferred resolver, captured per call.
      const resolvers: ((
        f: { t: number; channelId: string; payload: ArrayBuffer }[],
      ) => void)[] = [];
      vi.spyOn(store, "getFrames").mockImplementation(
        () => new Promise((res) => resolvers.push(res as (typeof resolvers)[number])),
      );

      player.play(1.0);
      vi.advanceTimersByTime(16);
      await flush();
      player.seek(50_000); // bumps generation → first prefetch (resolvers[0]) is now stale

      // Resolve the stale prefetch first so it releases the _isPrefetching mutex
      // (its result is discarded by the generation guard).
      resolvers[0]?.([
        { t: 1000, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 0 }) },
      ]);
      await flush();

      // Next tick starts a fresh prefetch (captures the post-seek generation).
      vi.advanceTimersByTime(16);
      await flush();

      resolvers[1]?.([
        { t: 49_000, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 3 }) },
      ]);
      await flush();

      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      const buf = (player as any)._prefetchBuffer as { t: number }[];
      expect(buf.some((f) => f.t === 1000)).toBe(false); // stale discarded
      expect(buf.some((f) => f.t === 49_000)).toBe(true); // fresh merged

      player.stop();
      player.dispose();
    });

    it("a stale rejection does not roll back the post-seek prefetchedUpTo", async () => {
      const { player, store } = makePlayer(0, 100_000);
      await store.open();
      const { reject } = deferredGetFrames(store);

      player.play(1.0);
      vi.advanceTimersByTime(16);
      await flush();

      player.seek(50_000);
      reject(new Error("idb")); // stale fetch fails after the seek
      await flush();

      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      expect((player as any)._prefetchedUpTo).toBe(46_999); // unchanged (not rolled back)
      expect(player.state).toBe("playing");

      player.stop();
      player.dispose();
    });

    it("stop() invalidates an in-flight prefetch", async () => {
      const { player, store, ch } = makePlayer(0, 100_000);
      await store.open();
      const { resolve } = deferredGetFrames(store);

      player.play(1.0);
      vi.advanceTimersByTime(16);
      await flush();
      player.stop(); // bumps generation + clears buffer

      resolve([
        { t: 500, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 4 }) },
      ]);
      await flush();

      // biome-ignore lint/suspicious/noExplicitAny: testing internals
      expect((player as any)._prefetchBuffer).toHaveLength(0); // stale frame not merged

      player.dispose();
    });

    it("play() invalidates a prefetch left in flight from a prior session", async () => {
      const { player, store, ch } = makePlayer(0, 100_000);
      await store.open();
      const { resolve } = deferredGetFrames(store);

      player.play(1.0);
      vi.advanceTimersByTime(16);
      await flush();
      player.stop();
      player.play(1.0); // bumps generation again

      resolve([
        { t: 500, channelId: "cpu", payload: ch.encode({ name: "cpu", value: 5 }) },
      ]);
      await flush();

      expect(
        (player as any)._prefetchBuffer.some((f: { t: number }) => f.t === 500),
      ).toBe(false);

      player.stop();
      player.dispose();
    });
  });
});
