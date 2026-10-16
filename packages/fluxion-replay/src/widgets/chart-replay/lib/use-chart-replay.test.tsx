import { act, render, renderHook } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MetricChannel } from "../../../entities/metric-channel/metric-channel";
import {
  buildRecording,
  ChartReplayProbe,
  makeFakeHost,
  makeFakePlayer,
  makeFakeStore,
  metricFrame,
  SIGNAL_CHANNEL,
} from "./chart-replay-fixtures";
import { useChartReplay } from "./use-chart-replay";

// Suppress console.error and console.warn at the file level so pending
// onUserConsoleLog RPCs don't race with environment teardown in vitest 4.x.
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

// ── Tests ───────────────────────────────────────────────────────────────────

describe("useChartReplay", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("hydrates from store on mount: reset(currentT) then pushBatch(decoded backfill)", async () => {
    const { host, handle, batches, resets, order } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({
      signal: [
        metricFrame("signal", 3500, 0.1),
        metricFrame("signal", 4000, 0.5),
        metricFrame("signal", 4800, 0.9),
      ],
    });

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      // Allow the async hydrate Promise chain to resolve.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fetches the visible window [3000,5000] widened by the ±3000ms prefetch margin.
    expect(store.getFramesByChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "signal" }),
      0,
      8000,
    );
    // Reset must fire BEFORE pushBatch so the worker axis rewinds first.
    expect(order[0]).toBe("reset:5000");
    expect(order[1]).toBe("pushBatch:3");

    // Backfill: ascending by t, with the right decoded values.
    expect(batches).toHaveLength(1);
    expect(batches[0].samples.map((s) => s.t)).toEqual([3500, 4000, 4800]);
    expect(batches[0].samples.map((s) => s.y)).toEqual([0.1, 0.5, 0.9]);

    // Sanity: handle was resolved via host.line("signal").
    expect(handle.reset).toHaveBeenCalledTimes(1);
    expect(resets[0]).toEqual({ id: "signal", latestT: 5000 });
  });

  it("surfaces a store/decode hydrate error via console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [] });
    // Force the async fetch to reject → hydrate catch block fires.
    store.getFramesByChannel.mockRejectedValueOnce(new Error("idb boom"));

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(errSpy).toHaveBeenCalledWith(
      "[useChartReplay] hydrate failed:",
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("re-hydrates on player.onSeek(t)", async () => {
    const { host, batches, resets } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({
      signal: [
        metricFrame("signal", 3500, 0.1),
        metricFrame("signal", 4000, 0.5),
        metricFrame("signal", 4800, 0.9),
        metricFrame("signal", 8500, 0.2),
        metricFrame("signal", 9000, 0.4),
      ],
    });

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    // Clear baseline counts for clarity in the assertion below.
    const initialBatches = batches.length;
    const initialResets = resets.length;

    // Seek forward to 9000 → fresh hydrate at [7000, 9000].
    await act(async () => {
      player.emitSeek(9000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.getFramesByChannel).toHaveBeenLastCalledWith(
      expect.objectContaining({ channelId: "signal" }),
      4000,
      12000,
    );
    expect(resets[initialResets]).toEqual({ id: "signal", latestT: 9000 });
    expect(batches[initialBatches].samples.map((s) => s.t)).toEqual([8500, 9000]);
  });

  it("forwards live frames via handle.push (no reset, no batch)", async () => {
    const { host, pushes, batches, resets } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [] });

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const baseResets = resets.length;
    const baseBatches = batches.length;

    const ch = new MetricChannel("signal");
    await act(async () => {
      player.emitFrame({
        channelId: "signal",
        data: ch.decode(ch.encode({ name: "signal", value: 0.7 })),
        t: 5050,
      });
      // Fix 3: frames are buffered in liveBuffer until the next onTick drains
      // them via pushBatch. Emit a tick to flush the buffer.
      player.emitTick(5050);
    });

    expect(pushes).toHaveLength(1);
    expect(pushes[0].sample).toEqual({ t: 5050, y: 0.7 });
    // Live path must not touch reset/batch.
    expect(resets.length).toBe(baseResets);
    expect(batches.length).toBe(baseBatches);
  });

  it("flushes 2+ buffered live frames as pushBatch on tick (buf.length > 1 branch)", async () => {
    const { host, batches } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [] });
    const ch = new MetricChannel("signal");

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const baseBatches = batches.length;

    await act(async () => {
      // Emit two frames before the tick — both should land as a single pushBatch
      player.emitFrame({
        channelId: "signal",
        data: ch.decode(ch.encode({ name: "signal", value: 0.3 })),
        t: 5010,
      });
      player.emitFrame({
        channelId: "signal",
        data: ch.decode(ch.encode({ name: "signal", value: 0.6 })),
        t: 5020,
      });
      player.emitTick(5020);
    });

    expect(batches.length).toBe(baseBatches + 1);
    expect(batches[baseBatches].samples).toEqual([
      { t: 5010, y: 0.3 },
      { t: 5020, y: 0.6 },
    ]);
  });

  it("ignores frames for other channels", async () => {
    const { host, pushes } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [] });

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      player.emitFrame({
        channelId: "other",
        data: { name: "other", value: 99 },
        t: 5050,
      });
    });
    expect(pushes).toHaveLength(0);
  });

  it("is a no-op when player is null", async () => {
    const { host, batches, resets, pushes } = makeFakeHost();
    const store = makeFakeStore({ signal: [metricFrame("signal", 100, 1)] });

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={null} store={store} windowMs={1000} />,
      );
      await Promise.resolve();
    });
    expect(store.getFramesByChannel).not.toHaveBeenCalled();
    expect(batches).toHaveLength(0);
    expect(resets).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it("is a no-op when host is null", async () => {
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [metricFrame("signal", 100, 1)] });

    await act(async () => {
      render(
        <ChartReplayProbe host={null} player={player} store={store} windowMs={1000} />,
      );
      await Promise.resolve();
    });
    expect(store.getFramesByChannel).not.toHaveBeenCalled();
    expect(player.frameListenerCount()).toBe(0);
    expect(player.seekListenerCount()).toBe(0);
  });

  it("unsubscribes player listeners on unmount", async () => {
    const { host, pushes, batches, resets } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [] });

    let unmount: () => void = () => {};
    await act(async () => {
      const r = render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      unmount = r.unmount;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(player.frameListenerCount()).toBe(1);
    expect(player.seekListenerCount()).toBe(1);
    expect(player.tickListenerCount()).toBe(1);
    const baseResets = resets.length;
    const basePushes = pushes.length;
    const baseBatches = batches.length;

    await act(async () => {
      unmount();
    });
    expect(player.frameListenerCount()).toBe(0);
    expect(player.seekListenerCount()).toBe(0);
    expect(player.tickListenerCount()).toBe(0);

    // Post-unmount emissions are ignored.
    await act(async () => {
      player.emitSeek(2000);
      player.emitFrame({
        channelId: "signal",
        data: { name: "signal", value: 1 },
        t: 100,
      });
      await Promise.resolve();
    });
    expect(resets.length).toBe(baseResets);
    expect(pushes.length).toBe(basePushes);
    expect(batches.length).toBe(baseBatches);
  });

  it("a hydrate cancelled mid-query writes nothing to the chart (cancelled guard)", async () => {
    const { host, resets, batches } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [metricFrame("signal", 4000, 0.5)] });
    store.hold(); // suspend the hydrate's getFramesByChannel

    let unmount: () => void = () => {};
    await act(async () => {
      const r = render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      unmount = r.unmount;
      await Promise.resolve(); // effect runs; hydrate parked at the await
    });
    expect(store.pendingCount()).toBe(1);

    // Unmount (sets cancelled) BEFORE releasing the query → the post-await
    // `if (cancelled) return` must skip reset/pushBatch.
    await act(async () => {
      unmount();
    });
    await act(async () => {
      await store.release();
      await Promise.resolve();
    });
    expect(resets).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it("hydrate with empty backfill still resets (so the axis rewinds even with no data)", async () => {
    const { host, batches, resets } = makeFakeHost();
    const player = makeFakePlayer(5000);
    const store = makeFakeStore({ signal: [] }); // nothing in range

    await act(async () => {
      render(
        <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resets).toEqual([{ id: "signal", latestT: 5000 }]);
    expect(batches).toHaveLength(0); // empty batch is skipped
  });

  // ── timeOrigin option ────────────────────────────────────────────────────

  describe("timeOrigin option", () => {
    it("subtracts timeOrigin from every backfill sample.t and from the reset latestT", async () => {
      const { host, batches, resets } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 5000); // 5s into the session
      const store = makeFakeStore({
        signal: [
          metricFrame("signal", ORIGIN + 3500, 0.1),
          metricFrame("signal", ORIGIN + 4000, 0.5),
          metricFrame("signal", ORIGIN + 4800, 0.9),
        ],
      });

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={2000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // Store query stays in absolute t.
      expect(store.getFramesByChannel).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "signal" }),
        ORIGIN + 0,
        ORIGIN + 8000,
      );
      // reset/push are host-relative (origin-subtracted).
      expect(resets[0]).toEqual({ id: "signal", latestT: 5000 });
      expect(batches[0].samples.map((s) => s.t)).toEqual([3500, 4000, 4800]);
      expect(batches[0].samples.map((s) => s.y)).toEqual([0.1, 0.5, 0.9]);
    });

    it("subtracts timeOrigin from live onFrame pushes", async () => {
      const { host, pushes } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 5000);
      const store = makeFakeStore({ signal: [] });

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={2000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
      });

      const ch = new MetricChannel("signal");
      await act(async () => {
        player.emitFrame({
          channelId: "signal",
          data: ch.decode(ch.encode({ name: "signal", value: 0.7 })),
          t: ORIGIN + 5050,
        });
        player.emitTick(ORIGIN + 5050);
      });

      expect(pushes).toHaveLength(1);
      expect(pushes[0].sample).toEqual({ t: 5050, y: 0.7 });
    });

    it("default (omitted) timeOrigin behaves like 0 — no regression", async () => {
      const { host, batches, resets } = makeFakeHost();
      const player = makeFakePlayer(5000);
      const store = makeFakeStore({
        signal: [metricFrame("signal", 4000, 0.5)],
      });

      await act(async () => {
        render(
          <ChartReplayProbe host={host} player={player} store={store} windowMs={2000} />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(resets[0]).toEqual({ id: "signal", latestT: 5000 });
      expect(batches[0].samples).toEqual([{ t: 4000, y: 0.5 }]);
    });
  });

  // ── Scenario: 60s recording, seek back to 30s ────────────────────────────
  // Reproduces the real-world flow that motivated the timeOrigin option: the
  // user records for 60s straight at 20Hz, then time-travels to t=30s and
  // expects the chart to refill with the prior 5s of samples.

  describe("scenario: 60s recording, seek back to 30s", () => {
    const ORIGIN = 1_000_000;
    const SESSION_MS = 60_000;
    const HZ = 20;
    const WINDOW_MS = 5_000;

    /** Build 1200 metric frames at 20Hz spanning [ORIGIN, ORIGIN + 60_000]. */
    const recording = () => ({
      signal: buildRecording({ origin: ORIGIN, hz: HZ, durationMs: SESSION_MS }),
    });

    it("backfills the chart with the prior 5s of samples on mount at t=30s", async () => {
      const { host, batches, resets } = makeFakeHost();
      const seekT = ORIGIN + 30_000;
      const player = makeFakePlayer(seekT);
      const store = makeFakeStore(recording());

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={WINDOW_MS}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // 1) Store queried with absolute t bounds [seekT - 5s, seekT].
      expect(store.getFramesByChannel).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "signal" }),
        seekT - WINDOW_MS - 3000,
        seekT + 3000,
      );

      // 2) Layer rewound to the host-relative seek point.
      expect(resets).toEqual([{ id: "signal", latestT: 30_000 }]);

      // 3) ~100 samples in the backfill batch (5s × 20Hz).
      expect(batches).toHaveLength(1);
      const samples = batches[0].samples;
      // IDBKeyRange.bound is inclusive on both ends, so [25_000, 30_000] yields
      // the 25_000ms sample plus 99 samples at 50ms intervals = 101 total.
      // The exact count is less important than the host-relative range.
      expect(samples.length).toBeGreaterThanOrEqual(100);
      expect(samples.length).toBeLessThanOrEqual(101);

      // 4) Every sample.t is host-relative — inside [25_000, 30_000]. None
      //    land on the absolute scale that would have collapsed to a single
      //    Float32 bucket.
      const ts = samples.map((s) => s.t);
      expect(Math.min(...ts)).toBeGreaterThanOrEqual(25_000);
      expect(Math.max(...ts)).toBeLessThanOrEqual(30_000);

      // 5) Sorted ascending — same order the store returned them.
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]).toBeGreaterThan(ts[i - 1]!);
      }

      // 6) Distinct timestamps — the bug fix's core guarantee. If timeOrigin
      //    weren't applied, all 100 samples would have collapsed onto the
      //    same Float32-quantised t.
      const distinct = new Set(ts);
      expect(distinct.size).toBe(ts.length);
    });

    it("re-hydrates on seek back another 10s — new window [15s, 20s]", async () => {
      const { host, batches, resets } = makeFakeHost();
      const initialT = ORIGIN + 30_000;
      const player = makeFakePlayer(initialT);
      const store = makeFakeStore(recording());

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={WINDOW_MS}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const baseBatches = batches.length;
      const baseResets = resets.length;

      // Scrub back another 10s — common DVR interaction.
      const newT = ORIGIN + 20_000;
      await act(async () => {
        player.emitSeek(newT);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Fresh query at the new bounds.
      expect(store.getFramesByChannel).toHaveBeenLastCalledWith(
        expect.objectContaining({ channelId: "signal" }),
        newT - WINDOW_MS - 3000,
        newT + 3000,
      );
      expect(resets[baseResets]).toEqual({ id: "signal", latestT: 20_000 });

      const samples = batches[baseBatches].samples;
      const ts = samples.map((s) => s.t);
      expect(Math.min(...ts)).toBeGreaterThanOrEqual(15_000);
      expect(Math.max(...ts)).toBeLessThanOrEqual(20_000);
      expect(new Set(ts).size).toBe(ts.length);
    });

    it("seek near the start clamps to the available recording window", async () => {
      const { host, batches, resets } = makeFakeHost();
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore(recording());

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={WINDOW_MS}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const baseBatches = batches.length;
      const baseResets = resets.length;

      // Seek 2s in — only the first 2s of samples are available.
      // The window [-3_000, 2_000] should still produce a non-degenerate batch.
      const seekT = ORIGIN + 2_000;
      await act(async () => {
        player.emitSeek(seekT);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Store is queried with the underflow bound — IDB returns what exists.
      expect(store.getFramesByChannel).toHaveBeenLastCalledWith(
        expect.objectContaining({ channelId: "signal" }),
        seekT - WINDOW_MS - 3000,
        seekT + 3000,
      );
      expect(resets[baseResets]).toEqual({ id: "signal", latestT: 2_000 });

      const samples = batches[baseBatches].samples;
      // 0..2_000ms at 20Hz = up to 41 samples.
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.length).toBeLessThanOrEqual(41);
      for (const s of samples) {
        expect(s.t).toBeGreaterThanOrEqual(0);
        expect(s.t).toBeLessThanOrEqual(2_000);
      }
    });

    it("live playback after seek: incoming onFrame pushes use host-relative t", async () => {
      const { host, pushes } = makeFakeHost();
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore(recording());

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={WINDOW_MS}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // Simulate the player ticking forward: emit a frame at t=30_050ms.
      const ch = new MetricChannel("signal");
      await act(async () => {
        player.emitFrame({
          channelId: "signal",
          data: ch.decode(ch.encode({ name: "signal", value: 0.123 })),
          t: ORIGIN + 30_050,
        });
        player.emitTick(ORIGIN + 30_050);
      });

      expect(pushes).toHaveLength(1);
      expect(pushes[0].sample).toEqual({ t: 30_050, y: 0.123 });
    });
  });

  // ── Race: onFrame fires while hydrate's getFramesByChannel is still pending
  // This is exactly what happens when useReplayDvr calls player.play() right
  // after enterReplay — the rAF loop starts immediately and onFrame callbacks
  // arrive during hydrate's await. Without protection, those frames are
  // pushed first, then wiped by handle.reset() inside hydrate.

  describe("race: onFrame during hydrate", () => {
    it("frame that arrives during hydrate await does NOT get wiped by the reset", async () => {
      const { host, pushes, batches, resets, order } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore({
        signal: [
          metricFrame("signal", ORIGIN + 28_000, 0.1),
          metricFrame("signal", ORIGIN + 29_500, 0.2),
        ],
      });

      // Block the first getFramesByChannel so we can fire an onFrame mid-await.
      store.hold();

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        // Let the effect register onFrame listener (synchronous part), but
        // keep hydrate suspended at the await.
        await Promise.resolve();
      });
      // Hydrate is pending.
      expect(store.pendingCount()).toBe(1);

      // Player emits a live frame WHILE hydrate is mid-await.
      const ch = new MetricChannel("signal");
      await act(async () => {
        player.emitFrame({
          channelId: "signal",
          data: ch.decode(ch.encode({ name: "signal", value: 0.7 })),
          t: ORIGIN + 30_050,
        });
      });

      // Now release the hydrate — backfill should land, AND the live frame
      // that arrived during the await must be preserved (not lost to reset).
      await act(async () => {
        await store.release();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Expected event order: reset(30_000) → pushBatch(backfill) → push(30_050)
      // No naked push BEFORE the reset (that'd be wiped).
      const resetIdx = order.findIndex((s) => s.startsWith("reset:"));
      const batchIdx = order.findIndex((s) => s.startsWith("pushBatch:"));
      const liveIdx = order.findIndex((s) => s.startsWith("push:30050:"));

      expect(resetIdx).toBeGreaterThanOrEqual(0);
      expect(batchIdx).toBeGreaterThan(resetIdx);
      expect(liveIdx).toBeGreaterThan(batchIdx);

      // Concrete values for each phase.
      expect(resets[0]).toEqual({ id: "signal", latestT: 30_000 });
      expect(batches[0].samples).toEqual([
        { t: 28_000, y: 0.1 },
        { t: 29_500, y: 0.2 },
      ]);
      expect(pushes).toEqual([{ id: "signal", sample: { t: 30_050, y: 0.7 } }]);
    });

    it("frame at or before the seek point during hydrate is dropped (backfill already covers it)", async () => {
      const { host, pushes, batches } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore({
        signal: [metricFrame("signal", ORIGIN + 29_000, 0.1)],
      });

      store.hold();

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
      });

      // A frame whose t falls inside the backfill range — backfill will
      // include it, so the live push would duplicate it. Hook should skip.
      const ch = new MetricChannel("signal");
      await act(async () => {
        player.emitFrame({
          channelId: "signal",
          data: ch.decode(ch.encode({ name: "signal", value: 0.5 })),
          t: ORIGIN + 29_000,
        });
      });

      await act(async () => {
        await store.release();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(batches[0].samples).toEqual([{ t: 29_000, y: 0.1 }]);
      // No push — the in-range frame was deduped against the backfill.
      expect(pushes).toEqual([]);
    });

    it("multiple frames during hydrate: all post-seek frames flush after backfill in order", async () => {
      const { host, pushes, order } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore({ signal: [] });
      store.hold();

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
      });

      const ch = new MetricChannel("signal");
      const enc = (v: number) => ch.decode(ch.encode({ name: "signal", value: v }));
      await act(async () => {
        // Three frames arrive while hydrate is suspended, out of order isn't
        // expected from a real player but the buffer must at least preserve
        // arrival order.
        player.emitFrame({ channelId: "signal", data: enc(0.1), t: ORIGIN + 30_050 });
        player.emitFrame({ channelId: "signal", data: enc(0.2), t: ORIGIN + 30_100 });
        player.emitFrame({ channelId: "signal", data: enc(0.3), t: ORIGIN + 30_150 });
      });

      await act(async () => {
        await store.release();
        await Promise.resolve();
        await Promise.resolve();
      });

      const resetIdx = order.findIndex((s) => s.startsWith("reset:"));
      const firstPushIdx = order.findIndex((s) => s.startsWith("push:"));
      expect(firstPushIdx).toBeGreaterThan(resetIdx);
      expect(pushes.map((p) => p.sample.t)).toEqual([30_050, 30_100, 30_150]);
    });

    it("onSeek triggers a fresh hydrate that supersedes the in-flight one", async () => {
      const { host, batches, resets } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore({
        signal: [
          metricFrame("signal", ORIGIN + 9_500, 0.9),
          metricFrame("signal", ORIGIN + 28_000, 0.1),
        ],
      });

      // Hold the FIRST hydrate from mount.
      store.hold();

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
      });
      expect(store.pendingCount()).toBe(1);

      // Phase 16: the sequential queue keeps only ONE IDB query in flight.
      // A seek while in-flight queues the new t (collapsing intermediates);
      // the next iteration of the loop will fire its own query.
      await act(async () => {
        player.emitSeek(ORIGIN + 10_000);
      });
      // Still just the original (held) query — queued seek hasn't dispatched.
      expect(store.pendingCount()).toBe(1);

      // Release the mount query → it processes, sees queuedT=10_000, fires
      // a 2nd IDB query (which resolves immediately since hold was released).
      await act(async () => {
        await store.release();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The final reset should be at the latest seek point (10_000), and the
      // final batch should be the seek-window data, not the mount-window.
      const lastReset = resets[resets.length - 1];
      expect(lastReset.latestT).toBe(10_000);
      const lastBatch = batches[batches.length - 1];
      expect(lastBatch.samples).toEqual([{ t: 9_500, y: 0.9 }]);
    });

    // ── Phase 16 — sequential queue + microtask yield ────────────────────
    it("Phase 16: rapid seek burst collapses to LAST t, both queries fire and chart updates twice", async () => {
      const { host, resets } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore({
        signal: [
          metricFrame("signal", ORIGIN + 4_500, 0.45),
          metricFrame("signal", ORIGIN + 9_500, 0.95),
          metricFrame("signal", ORIGIN + 14_500, 1.45),
          metricFrame("signal", ORIGIN + 19_500, 1.95),
          metricFrame("signal", ORIGIN + 28_000, 2.8),
        ],
      });

      // Hold the first hydrate so the burst lands while it's in flight.
      store.hold();
      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
      });
      expect(store.pendingCount()).toBe(1);

      // Burst of 5 seeks — all collapsed into queuedT.
      await act(async () => {
        player.emitSeek(ORIGIN + 25_000);
        player.emitSeek(ORIGIN + 20_000);
        player.emitSeek(ORIGIN + 15_000);
        player.emitSeek(ORIGIN + 10_000);
        player.emitSeek(ORIGIN + 5_000);
      });
      // Still only the held mount query.
      expect(store.pendingCount()).toBe(1);

      // Release: mount query resolves → processes → fires 2nd query for the
      // queued LAST seek (5_000). Only TWO total reset() calls.
      await act(async () => {
        await store.release();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(resets.length).toBe(2);
      expect(resets[0].latestT).toBe(30_000); // mount
      expect(resets[1].latestT).toBe(5_000); // last seek wins
    });

    it("Phase 16: cleanup during in-flight hydrate prevents the chart write", async () => {
      const { host, resets, batches } = makeFakeHost();
      const ORIGIN = 1_000_000;
      const player = makeFakePlayer(ORIGIN + 30_000);
      const store = makeFakeStore({
        signal: [metricFrame("signal", ORIGIN + 29_500, 2.95)],
      });

      // Hold the IDB query so runHydrate is suspended mid-await when we
      // unmount. Without this, runHydrate finishes before the unmount has
      // any chance to flip `cancelled`.
      store.hold();

      let unmount: (() => void) | null = null;
      await act(async () => {
        const result = render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        unmount = result.unmount;
        await Promise.resolve();
      });
      // Mount fired one hydrate that's now sitting on a held promise.
      expect(store.pendingCount()).toBe(1);

      // Unmount → cleanup synchronously sets cancelled=true. Then release
      // the IDB query so runHydrate's `await` resumes. The post-await
      // `await Promise.resolve()` yields one more microtask, then the
      // cancelled-check fires → bail. No reset / pushBatch.
      await act(async () => {
        unmount?.();
        await store.release();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(resets.length).toBe(0);
      expect(batches.length).toBe(0);
    });

    // Phase 16 — Bug 1 scenario: user records 30s, time-travels back 20s
    // (to the 10s mark). The chart MUST show the trailing 5s of data
    // ([5s, 10s]) — that data exists in the store, so the user reported
    // "chart starts fresh" was a bug, not expected behavior.
    it("Phase 16: enter at t=10s of a 30s recording → chart receives 100 backfill samples in [5s, 10s]", async () => {
      const { host, resets, batches } = makeFakeHost();
      const ORIGIN = 1_000_000;
      // 20 Hz over 30s = 600 frames in [ORIGIN, ORIGIN + 30s].
      const frames = Array.from({ length: 600 }, (_, i) =>
        metricFrame("signal", ORIGIN + i * 50, i / 10),
      );
      // Player.currentT starts at the seek point (10s into the recording).
      const player = makeFakePlayer(ORIGIN + 10_000);
      const store = makeFakeStore({ signal: frames });

      await act(async () => {
        render(
          <ChartReplayProbe
            host={host}
            player={player}
            store={store}
            windowMs={5_000}
            timeOrigin={ORIGIN}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The hydrate query targeted [10s - 5s, 10s] = [5s, 10s] in absolute
      // store time. At 20 Hz that's 100 frames (5_000ms / 50ms + 1 inclusive
      // = 101 frames; the boundary inclusion depends on the filter, but we
      // require AT LEAST 100 in this range and ZERO loss).
      expect(resets.length).toBe(1);
      expect(resets[0]?.latestT).toBe(10_000); // host-relative (= 10_000 - ORIGIN shifted, ORIGIN==timeOrigin)
      expect(batches.length).toBe(1);
      const batch = batches[0]!;
      expect(batch.samples.length).toBeGreaterThanOrEqual(100);
      // All samples lie inside the host-relative window [5_000, 10_000].
      for (const s of batch.samples) {
        expect(s.t).toBeGreaterThanOrEqual(5_000);
        expect(s.t).toBeLessThanOrEqual(10_000);
      }
      // First sample at or after the 5s mark, last at or before 10s.
      expect(batch.samples[0]!.t).toBeGreaterThanOrEqual(5_000);
      expect(batch.samples[batch.samples.length - 1]!.t).toBeLessThanOrEqual(10_000);
    });
  });

  // Phase 20-A-3: windowMs used to be passed straight into store queries.
  // A missing / NaN / non-positive value silently produced empty backfill —
  // chart looked broken with no error. Throw at mount so the typo is caught.
  describe("Phase 20: windowMs validation", () => {
    // Render the hook directly so the throw happens during the render
    // (not inside a useEffect, where React would swallow it). Using
    // renderHook keeps each case isolated from React's concurrent-root
    // warning between mounts.
    function tryHook(windowMs: number) {
      try {
        renderHook(() =>
          useChartReplay({
            host: makeFakeHost().host as never,
            player: makeFakePlayer(0) as never,
            store: makeFakeStore({ signal: [] }) as never,
            channel: SIGNAL_CHANNEL,
            windowMs,
            pickValue: (d) => d.value,
          }),
        );
        return null;
      } catch (e) {
        return e;
      }
    }

    it("throws when windowMs is NaN", () => {
      const err = tryHook(Number.NaN);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/windowMs/);
    });

    it("throws when windowMs is undefined", () => {
      const err = tryHook(undefined as unknown as number);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/windowMs/);
    });

    it("throws when windowMs is zero or negative", () => {
      expect(tryHook(0)).toBeInstanceOf(Error);
      expect(tryHook(-100)).toBeInstanceOf(Error);
    });

    it("does NOT throw for a positive finite value", () => {
      expect(tryHook(5_000)).toBeNull();
    });
  });

  // ── chart-replay-fixtures coverage ─────────────────────────────────────────
  // makeFakePlayer.onFrame has two overloads: bare listener (lines 67-70 in
  // chart-replay-fixtures.tsx) and channel-filtered. use-chart-replay only uses
  // the channel-filtered overload. This test drives the bare-listener path so
  // the fixture's branch coverage doesn't create a Lines gap.
  it("makeFakePlayer bare-listener onFrame path receives emitted frames (fixtures lines 67-70)", () => {
    const player = makeFakePlayer(0);
    const received: string[] = [];
    // Bare listener overload → typeof channelOrListener === "function" → lines 68-70
    const off = player.onFrame((frame) => {
      received.push(frame.channelId);
    });
    player.emitFrame({ channelId: "signal", data: {}, t: 100 });
    expect(received).toEqual(["signal"]);
    off();
    player.emitFrame({ channelId: "signal", data: {}, t: 200 });
    expect(received).toHaveLength(1); // unsubscribed
  });
});

it("does not write a hydrate if pickValue tears down its consumer", async () => {
  const { host, handle } = makeFakeHost();
  const player = makeFakePlayer(5000);
  const store = makeFakeStore({ signal: [metricFrame("signal", 4000, 1)] });
  store.hold();
  let unmount!: () => void;
  const view = renderHook(() =>
    useChartReplay({
      host: host as unknown as import("@heojeongbo/fluxion-render").FluxionHost,
      player:
        player as unknown as import("../../../features/player/model/replay-player").ReplayPlayer,
      store:
        store as unknown as import("../../../features/store/model/replay-store").ReplayStore,
      channel: SIGNAL_CHANNEL,
      windowMs: 2000,
      pickValue: () => {
        unmount();
        return 1;
      },
    }),
  );
  unmount = view.unmount;
  await act(async () => {
    store.release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(handle.reset).not.toHaveBeenCalled();
});
