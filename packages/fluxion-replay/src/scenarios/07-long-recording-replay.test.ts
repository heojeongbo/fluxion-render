/**
 * Scenario 07: Long Recording Replay (~5 minutes accumulated)
 *
 * Simulates the real monitoring use-case: the page has been recording for ~5
 * minutes, then the user time-travels. Verifies the replay CHART data stays
 * correct across a large recording — gap-free / dup-free playback over many
 * prefetch windows, and that a far seek does NOT deliver stale frames from a
 * previously-prefetched window (the bug fixed by the prefetch generation
 * counter in ReplayPlayer).
 *
 * The recording uses a deterministic `value = frameIndex` so every delivered
 * frame's value encodes its timestamp (`value === t / STEP_MS`). That makes
 * "data is tangled / shifted" directly assertable, not just inferred.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../entities/metric-channel/metric-channel";
import { ReplaySession } from "../features/session/model/replay-session";
import { buildMetricRecording, drain } from "./_helpers";

const CPU = new MetricChannel("cpu");

const HZ = 20;
const STEP_MS = 1000 / HZ; // 50 ms between samples
const DURATION_MS = 300_000; // 5 minutes
const FRAME_COUNT = DURATION_MS / STEP_MS; // 6000
const LAST_T = (FRAME_COUNT - 1) * STEP_MS; // 299_950

/** Record 5 minutes of CPU metric at 20 Hz with value === frame index. */
async function seedFiveMinutes(session: ReplaySession): Promise<void> {
  const frames = buildMetricRecording({
    channelId: "cpu",
    startT: 0,
    durationMs: DURATION_MS,
    hz: HZ,
    valueFn: (i) => i, // value === index === t / STEP_MS
  });
  for (const f of frames) {
    session.record("cpu", { name: "cpu", value: f.value }, f.t);
  }
  await session.store.flush();
}

// Headroom for the 5-minute recordings seeded here now comes from
// `testTimeout` in vitest.config.ts, which applies to every test in the
// package — see the comment there for why it is not hand-applied per test.
describe("Scenario 07: long recording replay (~5 min)", () => {
  let session: ReplaySession;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = new ReplaySession({
      channels: [CPU],
      // Keep the whole 5-min span: never evict, never retention-trim mid-test.
      evictThresholdPct: 100,
      retentionMs: 10 * 60_000,
    });
    await session.open();
    await session.startRecording();
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
  });

  it("getTimeRange spans the full 5 minutes", async () => {
    await seedFiveMinutes(session);
    const range = await session.getTimeRange();
    expect(range!.earliest).toBe(0);
    expect(range!.latest).toBe(LAST_T); // 299_950
  });

  it("enterReplay positions deep into the recording", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(150_000);
    await drain();
    expect(player.currentT).toBe(150_000);
    session.exitReplay();
  });

  it("playback over many prefetch windows is gap-free, dup-free, value-coherent", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(150_000);

    const frames: { t: number; value: number }[] = [];
    player.onFrame(({ t, data }) =>
      frames.push({ t, value: (data as { value: number }).value }),
    );

    player.play();
    // ~30 s of playback = 15 prefetch windows (prefetchMs default 2000).
    await vi.advanceTimersByTimeAsync(30_000);
    session.exitReplay();

    expect(frames.length).toBeGreaterThan(100);
    for (let i = 1; i < frames.length; i++) {
      // Strictly ascending, no gaps, no duplicates across prefetch boundaries.
      expect(frames[i]!.t - frames[i - 1]!.t).toBe(STEP_MS);
    }
    // Every value matches its timestamp → no tangling / shifting.
    for (const f of frames) {
      expect(f.value).toBe(f.t / STEP_MS);
    }
    // Playback starts near the seek point (play() rewinds the prefetch cursor by
    // a 3 s lookback for keyframe/continuity safety — so the first frame may be
    // up to 3 s before the target, but never earlier).
    expect(frames[0]!.t).toBeGreaterThanOrEqual(150_000 - 3_000);
  });

  it("a far backward seek does NOT deliver stale frames from the old window", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(150_000);

    // Warm the prefetch buffer near t≈200_000 by playing forward.
    player.play();
    await vi.advanceTimersByTimeAsync(50_000); // advance toward 200k
    player.pause();

    // Now jump far back. The pre-seek prefetch buffer held ~200k frames; the
    // generation guard must prevent any of those from being delivered.
    player.seek(20_000);
    await drain();

    const afterSeek: { t: number; value: number }[] = [];
    player.onFrame(({ t, data }) =>
      afterSeek.push({ t, value: (data as { value: number }).value }),
    );

    player.play();
    await vi.advanceTimersByTimeAsync(10_000);
    session.exitReplay();

    expect(afterSeek.length).toBeGreaterThan(0);
    // No frame from the stale ~200k window leaks in. seek() rewinds the buffer
    // to [20_000 - lookback, …]; nothing should be anywhere near 190k+.
    for (const f of afterSeek) {
      expect(f.t).toBeLessThan(190_000);
      expect(f.t).toBeGreaterThanOrEqual(20_000 - 3_000); // lookback window floor
      expect(f.value).toBe(f.t / STEP_MS); // values still coherent
    }
    // Ascending + gap-free after the seek.
    for (let i = 1; i < afterSeek.length; i++) {
      expect(afterSeek[i]!.t - afterSeek[i - 1]!.t).toBe(STEP_MS);
    }
  });

  it("resumes correctly at a new forward position after a back seek", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(150_000);

    player.play();
    await vi.advanceTimersByTimeAsync(20_000);
    player.seek(20_000);
    await drain();
    player.seek(250_000); // jump deep forward
    await drain();

    const frames: { t: number; value: number }[] = [];
    player.onFrame(({ t, data }) =>
      frames.push({ t, value: (data as { value: number }).value }),
    );

    player.play();
    await vi.advanceTimersByTimeAsync(10_000);
    session.exitReplay();

    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.t).toBeGreaterThanOrEqual(250_000 - 3_000);
      expect(f.value).toBe(f.t / STEP_MS);
    }
  });

  it("a rapid seek burst across the timeline settles at the last position", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(150_000);

    // Quick succession of seeks across the 5-min span.
    player.seek(250_000);
    player.seek(50_000);
    player.seek(280_000);
    await drain();

    expect(player.currentT).toBe(280_000);

    const frames: { t: number; value: number }[] = [];
    player.onFrame(({ t, data }) =>
      frames.push({ t, value: (data as { value: number }).value }),
    );

    player.play();
    await vi.advanceTimersByTimeAsync(8_000);
    session.exitReplay();

    // Only frames from the final (280k) position — no leftovers from 250k / 50k.
    for (const f of frames) {
      expect(f.t).toBeGreaterThanOrEqual(280_000 - 3_000);
      expect(f.t).toBeLessThan(290_000);
      expect(f.value).toBe(f.t / STEP_MS);
    }
  });

  it("after seeking to the past then back to live, the latest 5 s of data plays back", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(150_000);
    const latest = player.timeRange.latest; // LAST_T = 299_950
    const WINDOW_MS = 5_000;

    // Time-travel deep into the PAST, and warm a past-window prefetch buffer so
    // this also guards against those stale ~20k frames leaking into the live
    // window after we return.
    player.seek(20_000);
    await drain();
    player.play();
    await vi.advanceTimersByTimeAsync(2_000);
    player.pause();

    // Return to LIVE. Seek to `latest - WINDOW_MS` (the "show me the most recent
    // 5 seconds" position) rather than exactly `latest`, otherwise `_onTick`
    // ends playback immediately (currentT >= latest) and no data plays.
    player.seek(Math.max(0, latest - WINDOW_MS));
    await drain();

    const frames: { t: number; value: number }[] = [];
    player.onFrame(({ t, data }) =>
      frames.push({ t, value: (data as { value: number }).value }),
    );

    player.play();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    session.exitReplay();

    expect(frames.length).toBeGreaterThan(0);

    // Every frame lives in the live window (3 s = play() keyframe lookback).
    for (const f of frames) {
      expect(f.t).toBeGreaterThanOrEqual(latest - WINDOW_MS - 3_000);
      expect(f.t).toBeLessThanOrEqual(latest);
      // No stale frames from the old ~20k past position leaked in.
      expect(f.t).toBeGreaterThan(100_000);
      // Values still encode their timestamp → no tangling / shifting.
      expect(f.value).toBe(f.t / STEP_MS);
    }

    // 5 seconds of data are actually present, gap-free and dup-free.
    expect(frames.at(-1)!.t - frames[0]!.t).toBeGreaterThanOrEqual(WINDOW_MS);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.t - frames[i - 1]!.t).toBe(STEP_MS);
    }
  });

  it("frame values match timestamps after entering replay deep in the recording", async () => {
    await seedFiveMinutes(session);
    const player = await session.enterReplay(270_000);

    const frames: { t: number; value: number }[] = [];
    player.onFrame(({ t, data }) =>
      frames.push({ t, value: (data as { value: number }).value }),
    );

    player.play();
    await vi.advanceTimersByTimeAsync(8_000);
    session.exitReplay();

    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.value).toBe(f.t / STEP_MS); // value === index === t / 50
      expect(f.t).toBeGreaterThanOrEqual(270_000 - 3_000); // 3 s play() lookback
    }
  });
});
