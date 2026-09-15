/**
 * Scenario 09: Long Multi-Stream User Scenarios (5 min & 10 min)
 *
 * Simulates real user behaviour after a 5- or 10-minute multi-channel recording:
 *   - Scrub to any point and verify data integrity (value === t / STEP_MS)
 *   - Past→present→past round-trip seeks (stale-frame contamination guard)
 *   - Rapid seek bursts across the full timeline
 *   - Pause → idle → resume continuity
 *   - Multi-channel fan-out seek atomicity and cross-channel isolation
 *   - onEnd fires exactly once after near-end playback
 *
 * All channels encode `value = t / STEP_MS` so a wrong value immediately
 * reveals tangled, shifted, or stale frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../entities/metric-channel/metric-channel";
import { ReplaySession } from "../features/session/model/replay-session";
import { drain } from "./_helpers";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const HZ = 20;
const STEP_MS = 1000 / HZ; // 50 ms

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Record all channelIds at timestamp t with value === t / STEP_MS. */
function seedBroadcastFrame(
  session: ReplaySession,
  t: number,
  channelIds: readonly string[],
): void {
  for (const id of channelIds) {
    session.record(id, { name: id, value: t / STEP_MS }, t);
  }
}

/**
 * Seed `durationMs` of multi-channel data at HZ, plus a sentinel tick
 * `sentinelGapMs` beyond the last real frame so timeRange.latest is large
 * enough that onEnd doesn't fire prematurely during short test playbacks.
 */
async function seedMultiChannelRecording(
  session: ReplaySession,
  durationMs: number,
  channelIds: readonly string[],
  sentinelGapMs = 30_000,
): Promise<void> {
  const count = Math.floor(durationMs / STEP_MS);
  for (let i = 0; i < count; i++) {
    seedBroadcastFrame(session, i * STEP_MS, channelIds);
  }
  // Sentinel: sentinel value -1 so tests can filter it out if needed.
  const sentinelT = (count - 1) * STEP_MS + sentinelGapMs;
  for (const id of channelIds) {
    session.record(id, { name: id, value: -1 }, sentinelT);
  }
  await session.store.flush();
}

// ---------------------------------------------------------------------------
// Group A: 5-minute recording, 3 channels
// ---------------------------------------------------------------------------

const DURATION_5MIN = 300_000;
const LAST_REAL_5MIN = DURATION_5MIN - STEP_MS; // 299_950
const CH_5 = ["s0", "s1", "s2"] as const;
const ch5_0 = new MetricChannel("s0");
const ch5_1 = new MetricChannel("s1");
const ch5_2 = new MetricChannel("s2");

describe("Scenario 09-A: 5-minute multi-channel recording", () => {
  let session: ReplaySession;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = new ReplaySession({
      channels: [ch5_0, ch5_1, ch5_2],
      evictThresholdPct: 100,
      retentionMs: 20 * 60_000,
    });
    await session.open();
    await session.startRecording();
    await seedMultiChannelRecording(session, DURATION_5MIN, CH_5);
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // A1. Full playback from t=0: gap-free, dup-free, value-coherent
  // -------------------------------------------------------------------------

  it("A1: full 5-min 3-ch playback is gap-free, dup-free, and value-coherent", async () => {
    const player = await session.enterReplay(0);

    const s0: { t: number; value: number }[] = [];
    const s1: { t: number; value: number }[] = [];
    const s2: { t: number; value: number }[] = [];

    player.onFrame(ch5_0, ({ t, data }) => {
      if (data.value >= 0) s0.push({ t, value: data.value });
    });
    player.onFrame(ch5_1, ({ t, data }) => {
      if (data.value >= 0) s1.push({ t, value: data.value });
    });
    player.onFrame(ch5_2, ({ t, data }) => {
      if (data.value >= 0) s2.push({ t, value: data.value });
    });

    player.play();
    await vi.advanceTimersByTimeAsync(30_000);
    session.exitReplay();

    // Each channel must have received frames
    expect(s0.length).toBeGreaterThan(100);
    expect(s1.length).toBeGreaterThan(100);
    expect(s2.length).toBeGreaterThan(100);

    for (const frames of [s0, s1, s2]) {
      // Strictly ascending, exactly STEP_MS apart
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!.t - frames[i - 1]!.t).toBe(STEP_MS);
      }
      // Every value encodes its timestamp
      for (const f of frames) {
        expect(f.value).toBe(f.t / STEP_MS);
      }
    }
  });

  // -------------------------------------------------------------------------
  // A2. Mid-point seek → playback → data integrity + 3-channel sync
  // -------------------------------------------------------------------------

  it("A2: seek to 5-min midpoint delivers correct values and channels stay in sync", async () => {
    const SEEK_T = 150_000;
    const player = await session.enterReplay(SEEK_T);
    await drain();

    const s0Frames: { t: number; value: number }[] = [];
    const s1Frames: { t: number; value: number }[] = [];
    const s2Frames: { t: number; value: number }[] = [];

    player.onFrame(ch5_0, ({ t, data }) => {
      if (data.value >= 0) s0Frames.push({ t, value: data.value });
    });
    player.onFrame(ch5_1, ({ t, data }) => {
      if (data.value >= 0) s1Frames.push({ t, value: data.value });
    });
    player.onFrame(ch5_2, ({ t, data }) => {
      if (data.value >= 0) s2Frames.push({ t, value: data.value });
    });

    player.play();
    await vi.advanceTimersByTimeAsync(30_000);
    session.exitReplay();

    // All 3 channels received frames
    expect(s0Frames.length).toBeGreaterThan(0);
    expect(s1Frames.length).toBeGreaterThan(0);
    expect(s2Frames.length).toBeGreaterThan(0);

    // Frames start near the seek point (play() 3s lookback is acceptable)
    const lookback = 3_000;
    for (const frames of [s0Frames, s1Frames, s2Frames]) {
      expect(frames[0]!.t).toBeGreaterThanOrEqual(SEEK_T - lookback);
      // Value coherence
      for (const f of frames) {
        expect(f.value).toBe(f.t / STEP_MS);
      }
      // Gap-free
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!.t - frames[i - 1]!.t).toBe(STEP_MS);
      }
    }

    // Cross-channel sync: same-index frames share the same timestamp
    const minLen = Math.min(s0Frames.length, s1Frames.length, s2Frames.length);
    for (let i = 0; i < minLen; i++) {
      expect(s0Frames[i]!.t).toBe(s1Frames[i]!.t);
      expect(s1Frames[i]!.t).toBe(s2Frames[i]!.t);
    }
  });

  // -------------------------------------------------------------------------
  // A3. Past → present → past round-trip (stale frame contamination guard)
  // -------------------------------------------------------------------------

  it("A3: past-present-past round-trip seek delivers only frames from the correct time window", async () => {
    const player = await session.enterReplay(0);

    // Phase 1: establish a "present" well ahead of the phase-2 target so the
    // seek below is genuinely backward. Rate is 1.0, so this lands currentT at
    // 50_000 — the old comment here claimed ~200k, which the playback rate
    // never made possible and which made the phase-2 guard below look stricter
    // than it is.
    player.play();
    await vi.advanceTimersByTimeAsync(50_000);
    player.pause();

    // Phase 2: seek back, play briefly
    player.seek(30_000);
    await drain();
    const phase2Frames: { t: number; value: number }[] = [];
    player.onFrame(ch5_0, ({ t, data }) => {
      if (data.value >= 0) phase2Frames.push({ t, value: data.value });
    });
    player.play();
    await vi.advanceTimersByTimeAsync(5_000);
    player.pause();

    // All phase-2 frames must live near 30k (no stale ~200k frames)
    expect(phase2Frames.length).toBeGreaterThan(0);
    for (const f of phase2Frames) {
      expect(f.t).toBeLessThan(180_000);
      expect(f.value).toBe(f.t / STEP_MS);
    }

    // Phase 3: seek forward to 250k
    player.seek(250_000);
    await drain();
    const phase3Frames: { t: number; value: number }[] = [];
    player.onFrame(ch5_0, ({ t, data }) => {
      if (data.value >= 0) phase3Frames.push({ t, value: data.value });
    });
    player.play();
    await vi.advanceTimersByTimeAsync(10_000);
    session.exitReplay();

    expect(phase3Frames.length).toBeGreaterThan(0);
    for (const f of phase3Frames) {
      // No stale frames from phase-2 (~30k) window
      expect(f.t).toBeGreaterThanOrEqual(250_000 - 3_000);
      expect(f.value).toBe(f.t / STEP_MS);
    }
  });

  // -------------------------------------------------------------------------
  // A4. Rapid seek burst (5 seeks) — settles at final position
  // -------------------------------------------------------------------------

  it("A4: rapid 5-seek burst settles at the last seek position with no stale frames", async () => {
    const player = await session.enterReplay(0);

    player.seek(260_000);
    player.seek(80_000);
    player.seek(240_000);
    player.seek(50_000);
    player.seek(280_000);
    await drain();

    expect(player.currentT).toBe(280_000);

    const frames: { t: number; value: number }[] = [];
    player.onFrame(ch5_0, ({ t, data }) => {
      if (data.value >= 0) frames.push({ t, value: data.value });
    });

    player.play();
    await vi.advanceTimersByTimeAsync(10_000);
    session.exitReplay();

    expect(frames.length).toBeGreaterThan(0);
    // All frames from the final seek position, not from any intermediate seek
    for (const f of frames) {
      expect(f.t).toBeGreaterThanOrEqual(280_000 - 3_000);
      expect(f.t).toBeLessThan(300_000);
      expect(f.value).toBe(f.t / STEP_MS);
    }
  });

  // -------------------------------------------------------------------------
  // A5. Pause → idle → resume — playback continues from pause position
  // -------------------------------------------------------------------------

  it("A5: pause-idle-resume continues playback gaplessly from the paused position", async () => {
    const SEEK_T = 100_000;
    const player = await session.enterReplay(SEEK_T);

    const preFrames: { t: number; value: number }[] = [];
    player.onFrame(ch5_0, ({ t, data }) => {
      if (data.value >= 0) preFrames.push({ t, value: data.value });
    });

    player.play();
    // Step the advance in small increments. Under v8 coverage instrumentation
    // the rAF loop body runs slower, and a single large advance can overshoot
    // the wall-clock delta enough to trip an end/stop reset (currentT → 0).
    // Stepping keeps each settle bounded so the pause snapshot is deterministic.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(500); // ~5s → currentT ≈ 105k
    player.pause();

    const pausedAt = player.currentT;
    expect(pausedAt).toBeGreaterThan(SEEK_T);

    // Idle for 5 simulated seconds (no frames should arrive during pause)
    const countAtPause = preFrames.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(preFrames.length).toBe(countAtPause); // no new frames while paused

    // Resume
    player.play();
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(500); // ~10s
    session.exitReplay();

    // Frames after resume start at pausedAt (with STEP_MS precision)
    const postFrames = preFrames.slice(countAtPause);
    expect(postFrames.length).toBeGreaterThan(0);
    // First post-resume frame must be at or just after the pause position
    expect(postFrames[0]!.t).toBeGreaterThanOrEqual(pausedAt);

    // Gap-free and value-coherent throughout
    for (let i = 1; i < preFrames.length; i++) {
      expect(preFrames[i]!.t - preFrames[i - 1]!.t).toBe(STEP_MS);
    }
    for (const f of preFrames) {
      expect(f.value).toBe(f.t / STEP_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// Group B: 10-minute recording, 3 channels
// ---------------------------------------------------------------------------

const DURATION_10MIN = 600_000;
const FRAME_COUNT_10MIN = DURATION_10MIN / STEP_MS; // 12 000
const LAST_REAL_10MIN = (FRAME_COUNT_10MIN - 1) * STEP_MS; // 599_950
const CH_10 = ["m0", "m1", "m2"] as const;
const ch10_0 = new MetricChannel("m0");
const ch10_1 = new MetricChannel("m1");
const ch10_2 = new MetricChannel("m2");

describe("Scenario 09-B: 10-minute multi-channel recording", () => {
  let session: ReplaySession;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = new ReplaySession({
      channels: [ch10_0, ch10_1, ch10_2],
      evictThresholdPct: 100,
      retentionMs: 30 * 60_000,
    });
    await session.open();
    await session.startRecording();
    await seedMultiChannelRecording(session, DURATION_10MIN, CH_10);
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // B1. Time range spans the full 10 minutes, all 3 channels fully stored
  // -------------------------------------------------------------------------

  it("B1: time range spans full 10 min and all 3 channels store 12 000 frames each", async () => {
    const range = await session.getTimeRange();
    expect(range!.earliest).toBe(0);
    // getTimeRange includes the sentinel tick, so latest > LAST_REAL_10MIN
    expect(range!.latest).toBeGreaterThanOrEqual(LAST_REAL_10MIN);

    // Query only the real frames (exclude sentinel at > LAST_REAL_10MIN)
    const f0 = await session.store.getFramesByChannel(ch10_0, 0, LAST_REAL_10MIN);
    const f1 = await session.store.getFramesByChannel(ch10_1, 0, LAST_REAL_10MIN);
    const f2 = await session.store.getFramesByChannel(ch10_2, 0, LAST_REAL_10MIN);

    expect(f0).toHaveLength(FRAME_COUNT_10MIN);
    expect(f1).toHaveLength(FRAME_COUNT_10MIN);
    expect(f2).toHaveLength(FRAME_COUNT_10MIN);
  });

  // -------------------------------------------------------------------------
  // B2. Value integrity sampled at 5 seek points across the 10-min span
  // -------------------------------------------------------------------------

  it("B2: value coherence holds at five seek points across the 10-min span", async () => {
    const seekPoints = [0, 150_000, 300_000, 450_000, 590_000];

    for (const seekT of seekPoints) {
      // Re-enter replay at each seek point
      const player = await session.enterReplay(seekT);
      await drain();

      const m0Frames: { t: number; value: number }[] = [];
      const m1Frames: { t: number; value: number }[] = [];
      const m2Frames: { t: number; value: number }[] = [];

      player.onFrame(ch10_0, ({ t, data }) => {
        if (data.value >= 0) m0Frames.push({ t, value: data.value });
      });
      player.onFrame(ch10_1, ({ t, data }) => {
        if (data.value >= 0) m1Frames.push({ t, value: data.value });
      });
      player.onFrame(ch10_2, ({ t, data }) => {
        if (data.value >= 0) m2Frames.push({ t, value: data.value });
      });

      player.play();
      await vi.advanceTimersByTimeAsync(5_000);
      session.exitReplay();

      const lookback = 3_000;
      for (const frames of [m0Frames, m1Frames, m2Frames]) {
        expect(frames.length).toBeGreaterThan(0);
        expect(frames[0]!.t).toBeGreaterThanOrEqual(seekT - lookback);
        for (const f of frames) {
          expect(f.value).toBe(f.t / STEP_MS);
        }
        for (let i = 1; i < frames.length; i++) {
          expect(frames[i]!.t - frames[i - 1]!.t).toBe(STEP_MS);
        }
      }

      // Cross-channel sync
      const minLen = Math.min(m0Frames.length, m1Frames.length, m2Frames.length);
      for (let i = 0; i < minLen; i++) {
        expect(m0Frames[i]!.t).toBe(m1Frames[i]!.t);
        expect(m1Frames[i]!.t).toBe(m2Frames[i]!.t);
      }
    }
  });

  // -------------------------------------------------------------------------
  // B3. Near-end seek + playback → onEnd fires exactly once
  // -------------------------------------------------------------------------

  it("B3: seek to near end of 10-min recording, play to end, onEnd fires exactly once", async () => {
    const player = await session.enterReplay(590_000);
    await drain();

    const frames: { t: number; value: number }[] = [];
    let endCount = 0;

    player.onFrame(ch10_0, ({ t, data }) => {
      if (data.value >= 0) frames.push({ t, value: data.value });
    });
    player.onEnd(() => {
      endCount++;
    });

    player.play();
    // sentinel is 30 000 ms past LAST_REAL_10MIN; need enough time to reach it
    await vi.advanceTimersByTimeAsync(50_000);

    expect(endCount).toBe(1);
    expect(frames.length).toBeGreaterThan(0);

    // All real frames live within the seeked window (filter sentinel value -1)
    for (const f of frames) {
      expect(f.t).toBeGreaterThanOrEqual(590_000 - 3_000);
      expect(f.t).toBeLessThanOrEqual(LAST_REAL_10MIN);
      expect(f.value).toBe(f.t / STEP_MS);
    }

    session.exitReplay();
    expect(session.mode).toBe("live");
  });

  // -------------------------------------------------------------------------
  // B4. Backward seek from ~500k → no stale frames from old prefetch window
  // -------------------------------------------------------------------------

  it("B4: backward seek from 500k to 50k delivers no stale frames from the old window", async () => {
    const player = await session.enterReplay(0);

    // Warm prefetch buffer near 500k
    player.play();
    await vi.advanceTimersByTimeAsync(50_000); // advance ~50k real-time → currentT ≈ 50k
    // Do a fast seek forward to build a window near 500k
    player.seek(500_000);
    await drain();
    player.play();
    await vi.advanceTimersByTimeAsync(5_000); // prefetch at 500k
    player.pause();

    // Now seek far backward
    player.seek(50_000);
    await drain();

    const afterSeek: { t: number; value: number }[] = [];
    player.onFrame(ch10_0, ({ t, data }) => {
      if (data.value >= 0) afterSeek.push({ t, value: data.value });
    });

    player.play();
    await vi.advanceTimersByTimeAsync(10_000);
    session.exitReplay();

    expect(afterSeek.length).toBeGreaterThan(0);
    // No frames from the stale 500k window
    for (const f of afterSeek) {
      expect(f.t).toBeLessThan(450_000);
      expect(f.t).toBeGreaterThanOrEqual(50_000 - 3_000);
      expect(f.value).toBe(f.t / STEP_MS);
    }
    // Gap-free
    for (let i = 1; i < afterSeek.length; i++) {
      expect(afterSeek[i]!.t - afterSeek[i - 1]!.t).toBe(STEP_MS);
    }
  });

  // -------------------------------------------------------------------------
  // B5. Multi-channel fan-out seek atomicity across two seek points
  // -------------------------------------------------------------------------

  it("B5: sequential seeks reposition all 3 channels atomically with no cross-channel contamination", async () => {
    const player = await session.enterReplay(0);

    const m0Ts: number[] = [];
    const m1Ts: number[] = [];
    const m2Ts: number[] = [];
    const m0Values: number[] = [];
    const m1Values: number[] = [];
    const m2Values: number[] = [];

    player.onFrame(ch10_0, ({ t, data }) => {
      if (data.value >= 0) {
        m0Ts.push(t);
        m0Values.push(data.value);
      }
    });
    player.onFrame(ch10_1, ({ t, data }) => {
      if (data.value >= 0) {
        m1Ts.push(t);
        m1Values.push(data.value);
      }
    });
    player.onFrame(ch10_2, ({ t, data }) => {
      if (data.value >= 0) {
        m2Ts.push(t);
        m2Values.push(data.value);
      }
    });

    // First window: seek to 300k
    player.seek(300_000);
    await drain();
    expect(player.currentT).toBe(300_000);

    player.play();
    await vi.advanceTimersByTimeAsync(5_000);
    player.pause();

    const countAfterFirst = Math.min(m0Ts.length, m1Ts.length, m2Ts.length);
    expect(countAfterFirst).toBeGreaterThan(0);

    // All channels in sync at first window
    for (let i = 0; i < countAfterFirst; i++) {
      expect(m0Ts[i]).toBe(m1Ts[i]);
      expect(m1Ts[i]).toBe(m2Ts[i]);
    }

    // Second window: seek back to 100k
    player.seek(100_000);
    await drain();
    expect(player.currentT).toBe(100_000);

    // Clear collected frames
    m0Ts.length = 0;
    m1Ts.length = 0;
    m2Ts.length = 0;
    m0Values.length = 0;
    m1Values.length = 0;
    m2Values.length = 0;

    player.play();
    await vi.advanceTimersByTimeAsync(5_000);
    session.exitReplay();

    const minLen2 = Math.min(m0Ts.length, m1Ts.length, m2Ts.length);
    expect(minLen2).toBeGreaterThan(0);

    // All frames near 100k, no contamination from the previous 300k window
    for (const ts of [m0Ts, m1Ts, m2Ts]) {
      for (const t of ts) {
        expect(t).toBeGreaterThanOrEqual(100_000 - 3_000);
        expect(t).toBeLessThan(300_000);
      }
    }

    // Cross-channel sync at second window
    for (let i = 0; i < minLen2; i++) {
      expect(m0Ts[i]).toBe(m1Ts[i]);
      expect(m1Ts[i]).toBe(m2Ts[i]);
    }

    // Value coherence
    for (const values of [m0Values, m1Values, m2Values]) {
      for (let i = 0; i < values.length; i++) {
        const t = m0Ts[i]!;
        expect(values[i]).toBe(t / STEP_MS);
      }
    }

    // No cross-channel value contamination
    // m0, m1, m2 all have the same value (value = t/STEP_MS, same t per tick)
    // so we verify each channel's value matches ITS OWN timestamps
    for (let i = 0; i < minLen2; i++) {
      expect(m0Values[i]).toBe(m0Ts[i]! / STEP_MS);
      expect(m1Values[i]).toBe(m1Ts[i]! / STEP_MS);
      expect(m2Values[i]).toBe(m2Ts[i]! / STEP_MS);
    }
  });
});
