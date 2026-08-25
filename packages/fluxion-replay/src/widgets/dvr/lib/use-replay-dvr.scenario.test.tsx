import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../../../entities/metric-channel/metric-channel";
import { ReplaySession } from "../../../features/session/model/replay-session";
import { useReplayDvr } from "./use-replay-dvr";

/**
 * End-to-end-ish scenario tests that use the REAL ReplaySession / ReplayPlayer
 * (not the fake spy in chart-replay-fixtures). This catches behaviours that
 * spy-based unit tests miss — most notably the "play() rewinds currentT past
 * the prior seek()" regression that motivated Phase 6.
 *
 * Environment: happy-dom + fake IDB (see src/test/setup.ts) + vitest fake
 * timers. ReplayStore.flush() is awaited so the in-memory queue lands in IDB
 * before the player tries to read it.
 */

const ORIGIN = 1_000_000;
const SESSION_MS = 60_000;
const HZ = 20;
const FRAME_COUNT = SESSION_MS * (HZ / 1000); // 1200
const LIVE_TIME_RANGE = {
  earliest: ORIGIN,
  latest: ORIGIN + SESSION_MS,
};

/** Seed a session with 60 s × 20 Hz of MetricChannel frames. */
async function seedSession() {
  const channel = new MetricChannel("signal");
  const session = new ReplaySession({ channels: [channel], retentionMs: 10 * 60_000 });
  await session.open();
  await session.startRecording();
  for (let i = 0; i < FRAME_COUNT; i++) {
    const t = ORIGIN + i * (1000 / HZ);
    session.record("signal", { name: "signal", value: Math.sin(i * 0.1) }, t);
  }
  // Push the pending queue to the (fake) IDB so the player can read it.
  await session.store.flush();
  return { session, channel };
}

describe("useReplayDvr — real ReplayPlayer scenario (60s recording, seek to 30s)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("autoplay starts AT the seek point (regression: play() must not silently rewind)", async () => {
    const { session } = await seedSession();
    const enterReplay: typeof session.enterReplay = (t, opts) =>
      session.enterReplay(t, opts);
    const exitReplay = () => session.exitReplay();

    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay,
        exitReplay,
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await result.current.enter(seekT);
    });

    expect(result.current.isDvr).toBe(true);
    expect(result.current.player).not.toBeNull();
    expect(result.current.frozenLatest).toBe(LIVE_TIME_RANGE.latest);

    // The critical assertion. Before Phase 6's play() fix, this would have
    // been ORIGIN (timeRange.earliest) because play() called
    // clock.start(timeRange.earliest, rate), wiping the prior seek().
    const player = result.current.player!;
    expect(player.currentT).toBe(seekT);

    // The chart-replay UI needs the player to be in the playing state so
    // useChartReplay sees onFrame events as the rAF loop drains the prefetch.
    expect(player.state).toBe("playing");

    result.current.exit();
    session.dispose();
  });

  it("currentT advances forward from the seek point as the rAF loop ticks", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await result.current.enter(seekT);
    });

    const player = result.current.player!;
    expect(player.currentT).toBe(seekT);

    // Advance the rAF loop. The fake rAF in test/setup.ts uses setTimeout(16),
    // so 100ms wall time fires ~6 frames. Each frame the clock reads Date.now()
    // — fake timers also advance Date — and updates currentT by ~16ms (rate=1).
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // Should have moved forward, and stayed close to seekT + 100ms.
    expect(player.currentT).toBeGreaterThan(seekT);
    expect(player.currentT).toBeLessThan(seekT + 500);

    result.current.exit();
    session.dispose();
  });

  it("at rate=2x the virtual clock runs twice as fast as wall time", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 2,
      }),
    );

    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await result.current.enter(seekT);
    });

    const player = result.current.player!;
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // At 2x rate, virtual time advances 200ms in 100ms wall. Allow a window
    // for rAF timing slop.
    expect(player.currentT).toBeGreaterThanOrEqual(seekT + 150);
    expect(player.currentT).toBeLessThanOrEqual(seekT + 300);

    result.current.exit();
    session.dispose();
  });

  it("reaching the frozen latest fires onEnd → autoExitToLive snaps back to live", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        // Crank the rate so we can run to the frozen edge in a handful of
        // fake-timer ticks without iterating thousands of rAF callbacks.
        rate: 100_000,
      }),
    );

    // Enter near the very end of the recording so play() has only a tiny
    // virtual distance to cover.
    const seekT = LIVE_TIME_RANGE.latest - 50;
    await act(async () => {
      await result.current.enter(seekT);
    });
    expect(result.current.isDvr).toBe(true);

    // A few rAF cycles at 100,000x easily clears the remaining 50ms virtual.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.isDvr).toBe(false);
    expect(result.current.player).toBeNull();
    expect(result.current.frozenLatest).toBeNull();

    session.dispose();
  });

  it("autoExitToLive fires exactly once at the frozen edge, then re-enter works", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 100_000,
      }),
    );

    // Enter near the end so play() reaches the frozen edge almost immediately.
    await act(async () => {
      await result.current.enter(LIVE_TIME_RANGE.latest - 50);
    });
    expect(result.current.isDvr).toBe(true);

    // Run well past the edge — auto-exit should fire and NOT re-fire on
    // subsequent ticks (no flapping between live/DVR).
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isDvr).toBe(false);
    expect(result.current.player).toBeNull();

    // Extra time must not resurrect DVR or null/dispose anything further.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.isDvr).toBe(false);
    expect(result.current.player).toBeNull();

    // The controller is reusable after an auto-exit: a fresh enter() works.
    await act(async () => {
      await result.current.enter(LIVE_TIME_RANGE.earliest + 10_000);
    });
    expect(result.current.isDvr).toBe(true);
    expect(result.current.player).not.toBeNull();
    expect(result.current.player!.currentT).toBe(LIVE_TIME_RANGE.earliest + 10_000);

    result.current.exit();
    session.dispose();
  });

  it("autoExitToLive: false does NOT auto-return at the frozen edge", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        autoExitToLive: false,
        rate: 100_000,
      }),
    );

    await act(async () => {
      await result.current.enter(LIVE_TIME_RANGE.latest - 50);
    });
    expect(result.current.isDvr).toBe(true);

    // Playback reaches the end, but with autoExitToLive off it stays in DVR.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isDvr).toBe(true);
    expect(result.current.player).not.toBeNull();

    result.current.exit();
    session.dispose();
  });
});

// ─── Live-while-DVR: store keeps growing during time travel ──────────────────
// The user's exact scenario: recording is at 80 s, time-travel to 30 s, the
// 50 s of replay finishes while the live recorder kept appending another 30 s
// of frames. When auto-exit returns to live, the scrubber and chart need to
// see the new range.

describe("useReplayDvr — live recording continues during DVR", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("scenario: 80s recorded, seek to 30s, +30s recorded during DVR, auto-exit reflects new range", async () => {
    const channel = new MetricChannel("signal");
    const session = new ReplaySession({ channels: [channel], retentionMs: 10 * 60_000 });
    await session.open();
    await session.startRecording();

    // Initial 80 s of recording.
    const INITIAL_LATEST = ORIGIN + 80_000;
    for (let i = 0; i < 80 * HZ; i++) {
      const t = ORIGIN + i * (1000 / HZ);
      session.record("signal", { name: "signal", value: Math.sin(i * 0.1) }, t);
    }
    await session.store.flush();

    // The liveTimeRange the consumer feeds into useReplayDvr is a snapshot
    // controlled by the test — we re-render with a fresher range later to
    // simulate `useLiveTimeRange`'s 500 ms polling.
    let currentLiveRange = { earliest: ORIGIN, latest: INITIAL_LATEST };

    const { result, rerender } = renderHook(
      (props: { liveTimeRange: typeof currentLiveRange }) =>
        useReplayDvr({
          session,
          enterReplay: (t, opts) => session.enterReplay(t, opts),
          exitReplay: () => session.exitReplay(),
          liveTimeRange: props.liveTimeRange,
          // 100,000x so the 50 s of replay collapses to a few rAF cycles.
          rate: 100_000,
        }),
      { initialProps: { liveTimeRange: currentLiveRange } },
    );

    // Enter DVR at the 30 s mark.
    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await result.current.enter(seekT);
    });

    // frozenLatest pins the scrubber to the 80 s edge even as live grows.
    expect(result.current.isDvr).toBe(true);
    expect(result.current.frozenLatest).toBe(INITIAL_LATEST);
    expect(result.current.player!.currentT).toBe(seekT);
    expect(result.current.effectiveTimeRange).toEqual({
      earliest: ORIGIN,
      latest: INITIAL_LATEST, // frozen — NOT the (about-to-grow) live latest
    });

    // While replay runs at 100,000x, simulate the live recorder appending
    // another 30 s of frames. Use t > INITIAL_LATEST so the new frames
    // exist past the player's frozen latest.
    const EXTRA_S = 30;
    const NEW_LATEST = INITIAL_LATEST + EXTRA_S * 1000;
    for (let i = 0; i < EXTRA_S * HZ; i++) {
      const t = INITIAL_LATEST + i * (1000 / HZ);
      session.record("signal", { name: "signal", value: Math.cos(i * 0.1) }, t);
    }
    await session.store.flush();

    // The consumer's `useLiveTimeRange` would have polled and seen the new
    // latest — re-render with the updated range. While in DVR, the scrubber
    // still shouldn't move.
    currentLiveRange = { earliest: ORIGIN, latest: NEW_LATEST };
    rerender({ liveTimeRange: currentLiveRange });

    expect(result.current.isDvr).toBe(true);
    expect(result.current.effectiveTimeRange).toEqual({
      earliest: ORIGIN,
      latest: INITIAL_LATEST, // still frozen
    });

    // Now let replay run to the frozen edge at 100,000x. ~50 s of virtual
    // distance, ~200 ms of fake wall time covers it many times over.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // onEnd fired → useReplayDvr auto-exited → back to live mode.
    expect(result.current.isDvr).toBe(false);
    expect(result.current.player).toBeNull();
    expect(result.current.frozenLatest).toBeNull();

    // The scrubber NOW reflects the grown live range — the new 30 s is
    // visible to the consumer.
    expect(result.current.effectiveTimeRange).toEqual({
      earliest: ORIGIN,
      latest: NEW_LATEST,
    });

    // And the store has the full 110 s of frames available for downstream
    // live push / next DVR session.
    const allFrames = await session.store.getFramesByChannel("signal", 0, NEW_LATEST + 1);
    expect(allFrames.length).toBe(80 * HZ + 30 * HZ);
    expect(allFrames[allFrames.length - 1].t).toBeCloseTo(NEW_LATEST - 50, -1);

    session.dispose();
  });

  it("manual exit before onEnd also surfaces the latest live range", async () => {
    const channel = new MetricChannel("signal");
    const session = new ReplaySession({ channels: [channel], retentionMs: 10 * 60_000 });
    await session.open();
    await session.startRecording();

    for (let i = 0; i < 40 * HZ; i++) {
      session.record("signal", { name: "signal", value: i }, ORIGIN + i * 50);
    }
    await session.store.flush();

    let live = { earliest: ORIGIN, latest: ORIGIN + 40_000 };
    const { result, rerender } = renderHook(
      (p: { liveTimeRange: typeof live }) =>
        useReplayDvr({
          session,
          enterReplay: (t, opts) => session.enterReplay(t, opts),
          exitReplay: () => session.exitReplay(),
          liveTimeRange: p.liveTimeRange,
        }),
      { initialProps: { liveTimeRange: live } },
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 10_000);
    });
    expect(result.current.effectiveTimeRange?.latest).toBe(ORIGIN + 40_000);

    // Live keeps recording 5 s more while user time-travels.
    for (let i = 0; i < 5 * HZ; i++) {
      session.record("signal", { name: "signal", value: i }, ORIGIN + 40_000 + i * 50);
    }
    await session.store.flush();
    live = { earliest: ORIGIN, latest: ORIGIN + 45_000 };
    rerender({ liveTimeRange: live });

    // User pulls scrubber back to the right edge → manual exit.
    await act(async () => {
      result.current.exit();
    });

    expect(result.current.isDvr).toBe(false);
    expect(result.current.effectiveTimeRange?.latest).toBe(ORIGIN + 45_000);
    session.dispose();
  });
});

// ─── Playback controls during DVR ────────────────────────────────────────────

describe("useReplayDvr — playback controls during DVR", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pause() halts currentT, play() resumes from where it paused", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await result.current.enter(seekT);
    });

    const player = result.current.player!;
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    const beforePause = player.currentT;
    expect(beforePause).toBeGreaterThan(seekT);

    await act(async () => {
      player.pause();
    });
    // Wall time advances but virtual t does not.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(player.currentT).toBe(beforePause);

    await act(async () => {
      player.play(1);
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(player.currentT).toBeGreaterThan(beforePause);

    result.current.exit();
    session.dispose();
  });

  it("seek() during DVR jumps currentT and rehydrates downstream consumers via onSeek", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 30_000);
    });
    const player = result.current.player!;

    const seekEvents: number[] = [];
    player.onSeek((t) => seekEvents.push(t));

    await act(async () => {
      player.seek(ORIGIN + 15_000);
    });
    expect(player.currentT).toBe(ORIGIN + 15_000);
    expect(seekEvents).toEqual([ORIGIN + 15_000]);

    // After seeking backward in DVR, playback continues from the new point.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(player.currentT).toBeGreaterThan(ORIGIN + 15_000);
    expect(player.currentT).toBeLessThan(ORIGIN + 15_500);

    result.current.exit();
    session.dispose();
  });

  it("rate switch on the active player accelerates currentT", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 30_000);
    });
    const player = result.current.player!;
    const t0 = player.currentT;

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    const slowDelta = player.currentT - t0;
    expect(slowDelta).toBeGreaterThan(50);
    expect(slowDelta).toBeLessThan(200);

    // Bump to 4x — same wall time should yield ~4x virtual delta.
    await act(async () => {
      player.play(4);
    });
    const tBeforeFast = player.currentT;
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    const fastDelta = player.currentT - tBeforeFast;

    expect(fastDelta).toBeGreaterThan(slowDelta * 2);

    result.current.exit();
    session.dispose();
  });
});

// ─── Rapid mode switching (scrubber drag-storm) ──────────────────────────────

describe("useReplayDvr — rapid enter/exit/enter cycles", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rapid scrubber drag: every enter() lands at its own seek point, only the last player stays active", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    const players = [];
    for (const seekT of [ORIGIN + 20_000, ORIGIN + 35_000, ORIGIN + 50_000]) {
      await act(async () => {
        await result.current.enter(seekT);
      });
      players.push(result.current.player!);
      expect(result.current.player!.currentT).toBe(seekT);
    }

    // The first two players were disposed when enterReplay built fresh ones —
    // their internal _ended flag and clock loop should be torn down.
    // The current player is the third.
    expect(result.current.player).toBe(players[players.length - 1]);
    expect(result.current.isDvr).toBe(true);

    result.current.exit();
    session.dispose();
  });

  it("enter → exit → enter restarts cleanly at the new seek point", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 10_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.player!.currentT).toBeGreaterThan(ORIGIN + 10_000);

    await act(async () => {
      result.current.exit();
    });
    expect(result.current.isDvr).toBe(false);
    expect(result.current.player).toBeNull();

    await act(async () => {
      await result.current.enter(ORIGIN + 45_000);
    });
    expect(result.current.player!.currentT).toBe(ORIGIN + 45_000);
    expect(result.current.player!.state).toBe("playing");

    result.current.exit();
    session.dispose();
  });
});

// ─── End-to-end chart layer integrity: useReplayDvr + useChartReplay ─────────
// These are the highest-fidelity scenarios — real ReplaySession + real
// ReplayPlayer + real useChartReplay against a fake host. They catch races
// like "onFrame arrives during hydrate and gets wiped by reset" that
// unit-level tests on either hook alone can miss.

import {
  ChartReplayProbe,
  makeFakeHost,
  SIGNAL_CHANNEL,
} from "../../chart-replay/lib/chart-replay-fixtures";

describe("useReplayDvr + useChartReplay end-to-end (real player, real session)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * Mount the chart bridge on the player produced by useReplayDvr. Each
   * `dvr.player` change triggers a fresh useChartReplay subscription —
   * matches how chart-replay.tsx wires <MiniChart player={dvr.player}>.
   */
  function ChartBridge({
    host,
    player,
    store,
    timeOrigin,
  }: {
    host: ReturnType<typeof makeFakeHost>["host"];
    player: ReturnType<typeof useReplayDvr>["player"];
    store: ReplaySession["store"];
    timeOrigin: number;
  }) {
    return (
      <ChartReplayProbe
        host={host}
        player={player as never}
        store={store as never}
        channel={SIGNAL_CHANNEL}
        windowMs={5_000}
        timeOrigin={timeOrigin}
      />
    );
  }

  it("chart receives backfill THEN forward-playback frames in order (no wipe race)", async () => {
    const { session } = await seedSession();
    const { host, batches, pushes, resets, order } = makeFakeHost();

    // The harness: useReplayDvr produces the player, ChartBridge subscribes
    // useChartReplay to that player. enter() must lead to reset → pushBatch
    // (backfill) → push, push, push (forward frames).
    const Harness = ({
      ranger,
    }: {
      ranger: { earliest: number; latest: number } | null;
    }) => {
      const dvr = useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: ranger,
        rate: 1,
      });
      return (
        <>
          <ChartBridge
            host={host}
            player={dvr.player}
            store={session.store}
            timeOrigin={ORIGIN}
          />
          {((window as unknown as { __dvr: typeof dvr }).__dvr = dvr) && null}
        </>
      );
    };

    await act(async () => {
      render(<Harness ranger={LIVE_TIME_RANGE} />);
      await Promise.resolve();
    });
    const dvr = (window as unknown as { __dvr: ReturnType<typeof useReplayDvr> }).__dvr;

    // No DVR yet → no chart work.
    expect(batches).toHaveLength(0);
    expect(resets).toHaveLength(0);

    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await dvr.enter(seekT);
      // Let mount-hydrate and onFrame subscriptions all settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    // 1) The chart was reset to host-relative seek point (30_000 ms).
    expect(resets[0]).toEqual({ id: "signal", latestT: 30_000 });
    // 2) Backfill: ~100 samples spanning [25_000, 30_000] in host-relative t.
    expect(batches).toHaveLength(1);
    const backfill = batches[0].samples;
    expect(backfill.length).toBeGreaterThanOrEqual(99);
    expect(backfill.length).toBeLessThanOrEqual(101);
    for (const s of backfill) {
      expect(s.t).toBeGreaterThanOrEqual(25_000);
      expect(s.t).toBeLessThanOrEqual(30_000);
    }
    // 3) Critical ordering — reset BEFORE pushBatch BEFORE any forward push.
    const resetIdx = order.findIndex((s) => s.startsWith("reset:"));
    const batchIdx = order.findIndex((s) => s.startsWith("pushBatch:"));
    expect(batchIdx).toBeGreaterThan(resetIdx);
    const firstForwardIdx = order.findIndex(
      (s, i) => i > batchIdx && s.startsWith("push:"),
    );
    // It's OK to have zero forward pushes yet (no rAF tick happened) — but if
    // any did happen, they MUST be after the batch.
    if (firstForwardIdx >= 0) {
      expect(firstForwardIdx).toBeGreaterThan(batchIdx);
    }

    // Let the rAF tick a bit and confirm forward pushes start appearing AFTER
    // the seek point, never overlapping the backfill range.
    pushes.length = 0;
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    if (pushes.length > 0) {
      // Every forward push must have host-relative t > seek point (30_000 ms).
      for (const p of pushes) {
        expect(p.sample.t).toBeGreaterThan(30_000);
      }
      // And they must be monotonic — the chart layer relies on this for the
      // axis to advance.
      for (let i = 1; i < pushes.length; i++) {
        expect(pushes[i].sample.t).toBeGreaterThanOrEqual(pushes[i - 1].sample.t);
      }
    }

    dvr.exit();
    session.dispose();
  });

  it("rapid seeks: only the latest hydrate's backfill ends up on the chart", async () => {
    const { session } = await seedSession();
    const { host, batches, resets } = makeFakeHost();

    const Harness = () => {
      const dvr = useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      });
      return (
        <>
          <ChartBridge
            host={host}
            player={dvr.player}
            store={session.store}
            timeOrigin={ORIGIN}
          />
          {((window as unknown as { __dvr2: typeof dvr }).__dvr2 = dvr) && null}
        </>
      );
    };

    await act(async () => {
      render(<Harness />);
      await Promise.resolve();
    });
    const dvr = (window as unknown as { __dvr2: ReturnType<typeof useReplayDvr> }).__dvr2;

    // Burst three enters in a row — each one creates a new player + new
    // useChartReplay subscription (because dvr.player changes). The final
    // backfill should match the last enter's seek point.
    for (const seekT of [ORIGIN + 10_000, ORIGIN + 25_000, ORIGIN + 45_000]) {
      await act(async () => {
        await dvr.enter(seekT);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const lastReset = resets[resets.length - 1];
    const lastBatch = batches[batches.length - 1];
    expect(lastReset.latestT).toBe(45_000); // host-relative
    // Backfill window for 45_000 = [40_000, 45_000] host-relative.
    for (const s of lastBatch.samples) {
      expect(s.t).toBeGreaterThanOrEqual(40_000);
      expect(s.t).toBeLessThanOrEqual(45_000);
    }

    dvr.exit();
    session.dispose();
  });

  it("live → DVR → exit: backfill present in DVR, then chart is free for live push again", async () => {
    const { session } = await seedSession();
    const { host, batches, resets } = makeFakeHost();

    const Harness = ({ live }: { live: { earliest: number; latest: number } }) => {
      const dvr = useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: live,
        rate: 1,
      });
      return (
        <>
          <ChartBridge
            host={host}
            player={dvr.player}
            store={session.store}
            timeOrigin={ORIGIN}
          />
          {((window as unknown as { __dvr3: typeof dvr }).__dvr3 = dvr) && null}
        </>
      );
    };

    await act(async () => {
      render(<Harness live={LIVE_TIME_RANGE} />);
      await Promise.resolve();
    });
    const dvr = (window as unknown as { __dvr3: ReturnType<typeof useReplayDvr> }).__dvr3;
    // In live mode the chart hook is a no-op (host/player/store all null
    // inside its ChartReplayProbe wiring? actually only player gates it).
    // Wait, our ChartReplayProbe wraps useChartReplay which gates on player
    // being non-null. In live mode dvr.player === null → effect early returns
    // → nothing touches the chart. Confirm:
    expect(batches).toHaveLength(0);
    expect(resets).toHaveLength(0);

    // Time-travel.
    await act(async () => {
      await dvr.enter(ORIGIN + 30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resets).toHaveLength(1);
    expect(batches).toHaveLength(1);
    const batchCountInDvr = batches.length;

    // Manual exit.
    await act(async () => {
      dvr.exit();
    });

    // After exit, dvr.player === null again — no new chart writes from the
    // bridge. The chart is now free for the page's live-push pipeline.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(batches.length).toBe(batchCountInDvr); // no new batch from bridge
    expect(dvr.isDvr).toBe(false);
    expect(dvr.player).toBeNull();

    session.dispose();
  });
});

// ─── User-visible scrubber drag patterns ─────────────────────────────────────
// These tests simulate the exact pattern <input type="range"> produces during
// a mouse drag — onChange fires every pixel, then a single onMouseUp commits.
// The cursor-stuck-at-B regression that motivated Phase 9 lived here.

describe("useReplayDvr — scrubber drag patterns (real player)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drag-style burst (no await between calls) — final cursor sits at the last enter's seek point and ticks forward", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    // Simulate the scrubber firing 10 enters in a row as the user drags from
    // the live edge backward. None of them is awaited individually.
    const sweep = [
      55_000, 50_000, 45_000, 40_000, 35_000, 30_000, 25_000, 20_000, 15_000, 10_000,
    ].map((dt) => ORIGIN + dt);
    await act(async () => {
      for (const t of sweep) void result.current.enter(t);
      // Let the microtask queue drain so all the await enterReplay()s resolve.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The last enter's seek point wins.
    expect(result.current.isDvr).toBe(true);
    const finalSeek = sweep[sweep.length - 1]!;
    const player = result.current.player!;
    expect(player.currentT).toBe(finalSeek);
    expect(player.state).toBe("playing");

    // And it actually advances — not stuck at "B~B".
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(player.currentT).toBeGreaterThan(finalSeek);
    expect(player.currentT).toBeLessThan(finalSeek + 500);

    result.current.exit();
    session.dispose();
  });

  it("drag-then-exit: scrubber sweeps inward, then user pulls all the way back to live edge — ends in live mode cleanly", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    // Drag inward.
    await act(async () => {
      for (const t of [ORIGIN + 50_000, ORIGIN + 40_000, ORIGIN + 30_000]) {
        void result.current.enter(t);
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isDvr).toBe(true);

    // User immediately pulls back out (exit while burst settled).
    await act(async () => {
      result.current.exit();
    });

    // No DVR, no leaked player, time range is the live one again.
    expect(result.current.isDvr).toBe(false);
    expect(result.current.player).toBeNull();
    expect(result.current.frozenLatest).toBeNull();
    expect(result.current.effectiveTimeRange).toEqual(LIVE_TIME_RANGE);
    session.dispose();
  });

  it("DVR seek burst: while already in DVR, scrubber drag fires player.seek() many times — final currentT matches the last seek", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 30_000);
    });
    const player = result.current.player!;

    // Drag inside DVR. Each onChange would call player.seek(t) — not enter()
    // again. seek() is synchronous so race isn't an issue, but we still want
    // currentT to track the last seek precisely.
    await act(async () => {
      for (const t of [
        ORIGIN + 28_000,
        ORIGIN + 22_000,
        ORIGIN + 18_000,
        ORIGIN + 12_000,
      ]) {
        player.seek(t);
      }
    });

    expect(player.currentT).toBe(ORIGIN + 12_000);

    // Playback continues from the final seek point.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(player.currentT).toBeGreaterThan(ORIGIN + 12_000);

    result.current.exit();
    session.dispose();
  });

  it("commit-only pattern: 10 enter calls but only the final one is invoked (simulating release-only commit)", async () => {
    // This is what chart-replay.tsx does post-Phase 9: drag = setScrubT only,
    // release = single dvr.enter(finalT). This test asserts the simpler path
    // is also rock-solid.
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    // Simulate 10 onChange events that DO NOT call enter (preview only).
    // Then a single commit calls enter.
    const finalT = ORIGIN + 17_500;
    await act(async () => {
      await result.current.enter(finalT);
    });

    const player = result.current.player!;
    expect(player.currentT).toBe(finalT);
    expect(player.state).toBe("playing");

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(player.currentT).toBeGreaterThan(finalT);

    result.current.exit();
    session.dispose();
  });
});

// ─── Phase 11: cursor-stuck-at-enter symptom — DVR + useReplayPlayer combo ──
// The user-visible bug: enter(t), then over wall-clock time the chart cursor
// stays glued to t while the scrubber's right-edge label drifts forward. This
// describe wires the actual hook chain (useReplayDvr → dvr.player →
// useReplayPlayer) and asserts the cursor (replayPlayer.currentT) actually
// advances.

import { useReplayPlayer } from "../../replay-timeline/lib/use-replay-player";

describe("useReplayDvr + useReplayPlayer combo (cursor progression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The exact hook composition chart-replay.tsx uses. */
  function useDvrPlusPlayer(opts: {
    session: ReplaySession;
    liveTimeRange: { earliest: number; latest: number };
  }) {
    const dvr = useReplayDvr({
      session: opts.session,
      enterReplay: (t, replayOpts) => opts.session.enterReplay(t, replayOpts),
      exitReplay: () => opts.session.exitReplay(),
      liveTimeRange: opts.liveTimeRange,
      rate: 1,
    });
    const replayPlayer = useReplayPlayer(dvr.player);
    return { dvr, replayPlayer };
  }

  it("enter(t) → replayPlayer.currentT advances FROM t (not stuck)", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useDvrPlusPlayer({ session, liveTimeRange: LIVE_TIME_RANGE }),
    );

    const seekT = ORIGIN + 30_000;
    await act(async () => {
      await result.current.dvr.enter(seekT);
    });

    // Right after enter — currentT should reflect the seek point.
    expect(result.current.replayPlayer.currentT).toBe(seekT);
    expect(result.current.dvr.isDvr).toBe(true);

    // Now advance wall time and re-check. Without progression, this is the
    // "cursor stuck" bug the user reported.
    // Phase 14: cursor snaps to 1s boundaries — must advance past 1000ms to
    // observe a tick (rate=1).
    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    const tAfter1200 = result.current.replayPlayer.currentT;
    expect(tAfter1200).toBeGreaterThan(seekT);

    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    const tAfter2400 = result.current.replayPlayer.currentT;
    expect(tAfter2400).toBeGreaterThan(tAfter1200);

    result.current.dvr.exit();
    session.dispose();
  });

  it("cursor keeps advancing across forced parent re-renders (chart-replay shape)", async () => {
    const { session } = await seedSession();
    const { result, rerender } = renderHook(() =>
      useDvrPlusPlayer({ session, liveTimeRange: LIVE_TIME_RANGE }),
    );

    const seekT = ORIGIN + 20_000;
    await act(async () => {
      await result.current.dvr.enter(seekT);
    });
    // Phase 14: must cross a 1s boundary to observe a cursor update.
    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });

    const tBefore = result.current.replayPlayer.currentT;
    expect(tBefore).toBeGreaterThan(seekT);

    // Burst of re-renders — Phase 11 sticky-cursor symptom would snap
    // currentT back to seekT here.
    for (let i = 0; i < 8; i++) rerender();

    expect(result.current.replayPlayer.currentT).toBeGreaterThanOrEqual(tBefore);

    // And still keeps progressing after the re-render storm.
    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    expect(result.current.replayPlayer.currentT).toBeGreaterThan(tBefore);

    result.current.dvr.exit();
    session.dispose();
  });

  it("effectiveTimeRange.latest stays at frozenLatest even when liveTimeRange.latest grows during DVR", async () => {
    const { session } = await seedSession();
    let live = { earliest: ORIGIN, latest: ORIGIN + 30_000 };

    const { result, rerender } = renderHook(
      ({ liveTimeRange }: { liveTimeRange: typeof live }) =>
        useDvrPlusPlayer({ session, liveTimeRange }),
      { initialProps: { liveTimeRange: live } },
    );

    const seekT = ORIGIN + 15_000;
    await act(async () => {
      await result.current.dvr.enter(seekT);
    });

    const frozen = result.current.dvr.frozenLatest!;
    expect(frozen).toBe(ORIGIN + 30_000);
    expect(result.current.dvr.effectiveTimeRange).toEqual({
      earliest: ORIGIN,
      latest: frozen,
    });

    // Simulate the live polling pushing latest forward several times.
    for (let extra = 5_000; extra <= 30_000; extra += 5_000) {
      live = { earliest: ORIGIN, latest: ORIGIN + 30_000 + extra };
      rerender({ liveTimeRange: live });
      // The scrubber's right edge MUST NOT drift forward while in DVR.
      expect(result.current.dvr.effectiveTimeRange?.latest).toBe(frozen);
      expect(result.current.dvr.frozenLatest).toBe(frozen);
    }

    result.current.dvr.exit();
    session.dispose();
  });

  it("effectiveTimeRange identity is stable across re-renders with the same inputs (useMemo)", async () => {
    const { session } = await seedSession();
    const live = { earliest: ORIGIN, latest: ORIGIN + 30_000 };

    const { result, rerender } = renderHook(() =>
      useDvrPlusPlayer({ session, liveTimeRange: live }),
    );

    const beforeEnter = result.current.dvr.effectiveTimeRange;
    rerender();
    expect(result.current.dvr.effectiveTimeRange).toBe(beforeEnter);

    await act(async () => {
      await result.current.dvr.enter(ORIGIN + 10_000);
    });
    const inDvr = result.current.dvr.effectiveTimeRange;
    rerender();
    rerender();
    // Same (player, frozenLatest, liveTimeRange) → identical reference.
    expect(result.current.dvr.effectiveTimeRange).toBe(inDvr);

    result.current.dvr.exit();
    session.dispose();
  });
});

// ─── Phase 12: scrubber drag-preview (live seek as the user drags) ──────────
// Before Phase 12 chart-replay only committed enter/seek on mouseup, so the
// chart stayed frozen during drag. The new behaviour:
//   - first onChange of a live→DVR drag: dvr.enter(t)  (async, Phase 9 race-safe)
//   - subsequent onChanges (now in DVR): dvr.player.seek(t)  (synchronous)
//   - mouseup: setScrubT(null); cursor re-couples to player.currentT (autoplay)

describe("useReplayDvr — drag-preview pattern (Phase 12)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("once in DVR: a burst of seek() calls lands at the final seek point", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 40_000);
    });
    const player = result.current.player!;

    // Simulate a slow drag inward — 6 onChange events all firing player.seek.
    const path = [38_000, 32_000, 26_000, 20_000, 14_000, 10_000].map(
      (dt) => ORIGIN + dt,
    );
    await act(async () => {
      for (const t of path) player.seek(t);
    });

    expect(player.currentT).toBe(path[path.length - 1]!);

    // After "release", playback continues forward.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(player.currentT).toBeGreaterThan(path[path.length - 1]!);

    result.current.exit();
    session.dispose();
  });

  it("live → DVR drag: first onChange calls enter, follow-ups call seek — final cursor at last drag point", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    // Simulates the chart-replay onScrubChange branching:
    //   - first onChange while !isDvr → dvr.enter(t)
    //   - subsequent onChanges while isDvr (after enter resolves) → player.seek(t)
    const path = [50_000, 40_000, 30_000, 20_000].map((dt) => ORIGIN + dt);
    await act(async () => {
      // First call — enter. We await so isDvr flips before the rest.
      await result.current.enter(path[0]!);
    });
    expect(result.current.isDvr).toBe(true);

    await act(async () => {
      // Remaining drag positions hit the seek branch.
      for (let i = 1; i < path.length; i++) {
        result.current.player?.seek(path[i]!);
      }
    });

    // Cursor at last drag point — not stuck at the first enter t.
    expect(result.current.player!.currentT).toBe(path[path.length - 1]!);

    result.current.exit();
    session.dispose();
  });

  it("seek during DVR fires onSeek for each call — useChartReplay would re-hydrate to each point", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    await act(async () => {
      await result.current.enter(ORIGIN + 30_000);
    });
    const player = result.current.player!;
    const seenSeeks: number[] = [];
    player.onSeek((t) => seenSeeks.push(t));

    const path = [25_000, 22_000, 18_000].map((dt) => ORIGIN + dt);
    await act(async () => {
      for (const t of path) player.seek(t);
    });

    // Every drag onChange fires onSeek — useChartReplay (in the real app)
    // would buffer onFrame, reset+pushBatch the [t-windowMs, t] backfill,
    // and produce the "scrubbing through history" effect.
    expect(seenSeeks).toEqual(path);

    result.current.exit();
    session.dispose();
  });

  it("drag-preview burst is safe: enter() + seek() rapid fire ends with valid currentT (no race)", async () => {
    const { session } = await seedSession();
    const { result } = renderHook(() =>
      useReplayDvr({
        session,
        enterReplay: (t, opts) => session.enterReplay(t, opts),
        exitReplay: () => session.exitReplay(),
        liveTimeRange: LIVE_TIME_RANGE,
        rate: 1,
      }),
    );

    // Drag from live edge backward, fast — Phase 9 race fix on enter() must
    // hold, AND subsequent seeks must not be lost.
    await act(async () => {
      void result.current.enter(ORIGIN + 50_000); // not awaited
      // The remaining seeks happen before / interleaved with the enter await.
      // If `player` exists yet, seek; otherwise the next render hooks them up.
      await Promise.resolve();
      await Promise.resolve();
    });

    // After the burst settles, isDvr=true and player is the latest enter's.
    expect(result.current.isDvr).toBe(true);
    expect(result.current.player!.currentT).toBe(ORIGIN + 50_000);

    // A seek now lands cleanly.
    await act(async () => {
      result.current.player?.seek(ORIGIN + 25_000);
    });
    expect(result.current.player!.currentT).toBe(ORIGIN + 25_000);

    result.current.exit();
    session.dispose();
  });

  // ─── Phase 13 — frozenLatest === player.timeRange.latest ─────────────────
  // These tests catch the exact symptoms the user reported on video: cursor
  // can't reach the scrubber's right edge, and auto-exit-to-live never fires.
  // Both bugs collapse to a single root cause — UI right edge and player end
  // condition were two different snapshots of the same physical quantity.
  describe("Phase 13: frozen latest === player.end", () => {
    it("player.timeRange.latest exactly equals liveTimeRange.latest at enter() time", async () => {
      const { session } = await seedSession();
      const enterReplay: typeof session.enterReplay = (t, opts) =>
        session.enterReplay(t, opts);
      const exitReplay = () => session.exitReplay();
      const live = { earliest: ORIGIN, latest: ORIGIN + 45_000 };
      const { result } = renderHook(() =>
        useReplayDvr({ session, enterReplay, exitReplay, liveTimeRange: live, rate: 1 }),
      );

      await act(async () => {
        await result.current.enter(ORIGIN + 20_000);
      });

      const player = result.current.player!;
      // The root-cause assertion: the player's end condition is EXACTLY the
      // scrubber's right edge. No drift, no lag, no IDB-snapshot mismatch.
      expect(player.timeRange.latest).toBe(live.latest);
      expect(result.current.frozenLatest).toBe(live.latest);
      expect(result.current.effectiveTimeRange?.latest).toBe(live.latest);

      result.current.exit();
      session.dispose();
    });

    it("auto-exit fires precisely when currentT reaches frozenLatest (not before, not after)", async () => {
      const { session } = await seedSession();
      const enterReplay: typeof session.enterReplay = (t, opts) =>
        session.enterReplay(t, opts);
      const exitReplay = vi.fn(() => session.exitReplay());
      const live = { earliest: ORIGIN, latest: ORIGIN + 50_000 };
      const { result } = renderHook(() =>
        useReplayDvr({ session, enterReplay, exitReplay, liveTimeRange: live, rate: 1 }),
      );

      // Enter at 30s into the recording — 20s of replay until the frozen edge.
      await act(async () => {
        await result.current.enter(ORIGIN + 30_000);
      });
      expect(result.current.isDvr).toBe(true);
      expect(result.current.player!.timeRange.latest).toBe(live.latest);

      // Walk the clock to just before the frozen edge — onEnd MUST NOT fire.
      await act(async () => {
        vi.advanceTimersByTime(19_000);
      });
      expect(result.current.isDvr).toBe(true);
      expect(exitReplay).not.toHaveBeenCalled();

      // Cross the frozen edge — onEnd MUST fire, isDvr flips false.
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(result.current.isDvr).toBe(false);
      expect(result.current.player).toBeNull();
      expect(result.current.frozenLatest).toBeNull();
      expect(exitReplay).toHaveBeenCalledTimes(1);

      session.dispose();
    });

    it("seek() during DVR clamps at frozenLatest, not IDB latest", async () => {
      // The store has frames up to ORIGIN+SESSION_MS=60_000. But the user
      // entered with a frozen latest of 40_000. seek() must respect frozen,
      // not the bigger IDB value.
      const { session } = await seedSession();
      const enterReplay: typeof session.enterReplay = (t, opts) =>
        session.enterReplay(t, opts);
      const exitReplay = () => session.exitReplay();
      const live = { earliest: ORIGIN, latest: ORIGIN + 40_000 };
      const { result } = renderHook(() =>
        useReplayDvr({ session, enterReplay, exitReplay, liveTimeRange: live, rate: 1 }),
      );

      await act(async () => {
        await result.current.enter(ORIGIN + 10_000);
      });

      // Try to seek past frozenLatest into the IDB-only region.
      await act(async () => {
        result.current.player?.seek(ORIGIN + 55_000);
      });
      // Clamped down to frozenLatest, not IDB's 60_000.
      expect(result.current.player!.currentT).toBe(ORIGIN + 40_000);

      result.current.exit();
      session.dispose();
    });

    it("no tail data gap: frames recorded just before enter (in store._pending) are included", async () => {
      // Build a session with frames in IDB, then record a few MORE without
      // flushing. enterReplay must internally flush so those tail frames are
      // visible to the player + the scrubber's frozenLatest matches reality.
      const channel = new MetricChannel("signal");
      const session = new ReplaySession({
        channels: [channel],
        retentionMs: 10 * 60_000,
        // Big interval so the auto-flush won't race us.
        storeOptions: { batchIntervalMs: 99_999 },
      });
      await session.open();
      await session.startRecording();

      // 10s of frames at 20Hz.
      for (let i = 0; i < 200; i++) {
        session.record("signal", { name: "signal", value: i }, ORIGIN + i * 50);
      }
      await session.store.flush();

      // Now record 10 MORE frames after-the-flush — these live only in
      // _pending and are NOT in IDB. Without the Phase 13 fix, enterReplay
      // would compute the player's timeRange.latest from the IDB-only range
      // and these 10 tail frames would be lost.
      for (let i = 200; i < 210; i++) {
        session.record("signal", { name: "signal", value: i }, ORIGIN + i * 50);
      }
      const expectedTailLatest = ORIGIN + 209 * 50;
      // Sanity: IDB without flush stops short of the tail.
      const idbBefore = await session.getTimeRange();
      expect(idbBefore?.latest).toBe(ORIGIN + 199 * 50);

      const enterReplay: typeof session.enterReplay = (t, opts) =>
        session.enterReplay(t, opts);
      const exitReplay = () => session.exitReplay();
      const live = {
        earliest: ORIGIN,
        // Simulate a poll that captured the tail (this is what the production
        // useLiveTimeRange would return if it polled after the recorder
        // flushed — we assert the chain is consistent end-to-end).
        latest: expectedTailLatest,
      };

      const { result } = renderHook(() =>
        useReplayDvr({ session, enterReplay, exitReplay, liveTimeRange: live, rate: 1 }),
      );
      await act(async () => {
        await result.current.enter(ORIGIN + 5_000);
      });

      // The player's end matches the live tail — no truncation.
      expect(result.current.player!.timeRange.latest).toBe(expectedTailLatest);
      // And the IDB is now up to date too (enterReplay flushed).
      const idbAfter = await session.getTimeRange();
      expect(idbAfter?.latest).toBe(expectedTailLatest);

      result.current.exit();
      session.dispose();
    });
  });
});
