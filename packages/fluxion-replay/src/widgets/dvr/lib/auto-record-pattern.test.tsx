import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../../../entities/metric-channel/metric-channel";
import { ReplaySession } from "../../../features/session/model/replay-session";
import { useLiveTimeRange } from "../../live/lib/use-live-time-range";
import { useReplaySession } from "../../replay-timeline/lib/use-replay-session";

/**
 * Regression tests for the "every re-render wipes the store" bug.
 *
 * chart-replay.tsx wires the auto-recording effect like this:
 *
 *   const { timeRange, seed } = useLiveTimeRange(session);
 *   useEffect(() => {
 *     ...
 *     await session.clearRecording();
 *     await session.startRecording();
 *     seed({ earliest: now, latest: now });
 *   }, [session, isReady, seed]);   // ← `seed` in deps
 *
 * If `seed`'s identity is not stable, the effect re-fires on every
 * re-render — and clearRecording() runs every render, leaving the store
 * permanently empty. liveTimeRange then stays at the seed() snapshot,
 * scrubMin === scrubMax, and the user sees "양 끝 시간이 같다".
 *
 * The fix lives in two places:
 *   1. useLiveTimeRange.seed must use useCallback (root cause)
 *   2. The demo guards with a ref so re-fires would still be no-ops
 *      (belt-and-suspenders for any future shape of (1) regressing)
 *
 * These tests mount a miniature version of chart-replay's auto-record
 * effect and assert it fires exactly once even when the page re-renders.
 */

function makeChannel() {
  return new MetricChannel("signal");
}

/**
 * Minimal harness that reproduces chart-replay.tsx's auto-record pattern.
 * Trigger re-renders by changing the `tick` prop — simulates ChartReplayApp
 * re-rendering due to state updates (scrubT, replayPlayer.currentT, etc.).
 */
function AutoRecordHarness({ tick }: { tick: number }) {
  const { session, isReady } = useReplaySession({
    channels: [makeChannel()],
    retentionMs: 60_000,
  });
  const { seed: seedTimeRange } = useLiveTimeRange(session);

  useEffect(() => {
    if (!session || !isReady) return;
    let cancelled = false;
    void (async () => {
      try {
        await session.clearRecording();
        if (cancelled) return;
        await session.startRecording();
        if (cancelled) return;
        seedTimeRange({ earliest: Date.now(), latest: Date.now() });
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [session, isReady, seedTimeRange]);

  // The `tick` prop is just there to force re-renders without changing
  // anything else.
  return <div data-testid="harness">tick:{tick}</div>;
}

describe("chart-replay auto-record pattern (regression for clearRecording-per-render bug)", () => {
  it("re-renders do NOT cause repeated clearRecording / startRecording calls", async () => {
    const clearSpy = vi.spyOn(ReplaySession.prototype, "clearRecording");
    const startSpy = vi.spyOn(ReplaySession.prototype, "startRecording");

    const { rerender } = render(<AutoRecordHarness tick={0} />);

    // Let the open() Promise + the auto-record effect settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const clearCallsAfterInit = clearSpy.mock.calls.length;
    const startCallsAfterInit = startSpy.mock.calls.length;
    // Exactly one of each from the auto-record effect's first (and only) run.
    expect(clearCallsAfterInit).toBe(1);
    expect(startCallsAfterInit).toBe(1);

    // Force 5 re-renders by bumping the tick prop. None of them should
    // re-fire the auto-record effect.
    for (let i = 1; i <= 5; i++) {
      await act(async () => {
        rerender(<AutoRecordHarness tick={i} />);
        await Promise.resolve();
      });
    }

    expect(clearSpy.mock.calls.length).toBe(clearCallsAfterInit);
    expect(startSpy.mock.calls.length).toBe(startCallsAfterInit);

    clearSpy.mockRestore();
    startSpy.mockRestore();
  });

  it("user-visible side effect: after init, the store keeps frames; getTimeRange grows past the seed", async () => {
    // Same harness, but we also feed in frames and check that the store
    // accumulates them (i.e. nothing wipes them mid-render).
    const captured: { session: ReplaySession | null } = { session: null };

    function HarnessWithRecord({ tick }: { tick: number }) {
      const { session, isReady, record } = useReplaySession({
        channels: [makeChannel()],
        retentionMs: 60_000,
      });
      const { seed } = useLiveTimeRange(session);
      captured.session = session;

      useEffect(() => {
        if (!session || !isReady) return;
        let cancelled = false;
        void (async () => {
          await session.clearRecording();
          if (cancelled) return;
          await session.startRecording();
          if (cancelled) return;
          seed({ earliest: Date.now(), latest: Date.now() });
        })();
        return () => {
          cancelled = true;
        };
      }, [session, isReady, seed]);

      // Push a fake "live frame" each render so we have something to keep.
      useEffect(() => {
        if (!session || !isReady) return;
        record("signal", { name: "signal", value: tick }, Date.now() + tick);
      }, [session, isReady, record, tick]);

      return <div>{tick}</div>;
    }

    const { rerender } = render(<HarnessWithRecord tick={0} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Force more re-renders that each add a frame.
    for (let i = 1; i <= 5; i++) {
      await act(async () => {
        rerender(<HarnessWithRecord tick={i} />);
        await Promise.resolve();
      });
    }

    // Flush pending IDB writes so getTimeRange sees the frames.
    await act(async () => {
      await captured.session?.store.flush();
      await Promise.resolve();
    });

    const range = await captured.session?.getTimeRange();
    // Pre-fix: every re-render wiped the store → range === null OR
    // earliest === latest (only the last frame survives).
    // Post-fix: store accumulates → at least 2 distinct timestamps.
    expect(range).not.toBeNull();
    if (range) {
      expect(range.latest).toBeGreaterThan(range.earliest);
    }

    captured.session?.dispose();
  });
});
