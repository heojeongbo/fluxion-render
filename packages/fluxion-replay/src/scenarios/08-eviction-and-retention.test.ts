/**
 * Scenario 08: Quota Eviction + Retention Together (long recording)
 *
 * The library has TWO independent aging mechanisms, and a real long-running
 * recording exercises both at once:
 *
 *  - Quota eviction (`evictThresholdPct`, default 70): after each IDB flush,
 *    if `percentUsed` reaches the threshold, every flush trims the oldest 1% of
 *    the recorded time span from IndexedDB (`deleteFramesBefore`) until usage
 *    falls below the low watermark.
 *  - Retention trim (`retentionMs`): on every `record()`, the recorder's
 *    in-memory buffer drops frames older than `now - retentionMs`.
 *
 * Scenarios 04/07 test each in isolation; this one runs both on one session and
 * asserts they operate on their respective stores without interfering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../entities/metric-channel/metric-channel";
import { ReplaySession } from "../features/session/model/replay-session";
import { buildMetricRecording } from "./_helpers";

const HZ = 20;
const STEP_MS = 1000 / HZ; // 50 ms
const DURATION_MS = 120_000; // 2 minutes
const RETENTION_MS = 30_000; // keep only the last 30 s in memory

describe("Scenario 08: quota eviction + retention together", () => {
  let session: ReplaySession;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = new ReplaySession({
      channels: [new MetricChannel("cpu")],
      // Default eviction threshold is 70 — pass it explicitly to make the
      // scenario self-documenting and independent of the default.
      evictThresholdPct: 70,
      retentionMs: RETENTION_MS,
    });
    await session.open();
    await session.startRecording();
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function seed(): void {
    const frames = buildMetricRecording({
      channelId: "cpu",
      startT: 0,
      durationMs: DURATION_MS,
      hz: HZ,
      valueFn: (i) => i,
    });
    for (const f of frames) {
      session.record("cpu", { name: "cpu", value: f.value }, f.t);
    }
  }

  it("retention trims the in-memory buffer to the last retentionMs as recording advances", () => {
    seed();
    const lastT = DURATION_MS - STEP_MS; // 119_950
    // After recording to lastT, the recorder's in-memory buffer holds only
    // frames with t >= lastT - retentionMs. Anything older was evicted on the
    // record() that crossed the retention edge.
    const recent = session.recorder.getRecentFrames("cpu", 0, DURATION_MS);
    expect(recent.length).toBeGreaterThan(0);
    for (const f of recent) {
      expect(f.t).toBeGreaterThanOrEqual(lastT - RETENTION_MS);
    }
    // The oldest frame (t=0) is long gone from memory.
    expect(recent.some((f) => f.t === 0)).toBe(false);
  });

  it("quota eviction deletes the oldest IDB frames once percentUsed exceeds the threshold", async () => {
    const deleteSpy = vi.spyOn(session.store, "deleteFramesBefore");
    // Force over-threshold so the post-flush eviction pass fires.
    vi.spyOn(session.store, "getStorageInfo").mockResolvedValue({
      usedBytes: 850,
      quotaBytes: 1_000,
      percentUsed: 85, // > 70
      idbFrameCount: DURATION_MS / STEP_MS,
    });

    seed();
    await session.store.flush();

    // The oldest slice of the recorded span is dropped from IDB. Eviction can fire
    // more than once (a periodic pass during the batched writes + the explicit
    // flush), so assert at least one pass with a sane cutoff.
    expect(deleteSpy).toHaveBeenCalled();
    const cutoff = deleteSpy.mock.calls[0]![0] as number;
    expect(cutoff).toBeGreaterThan(0);
    // The cut targets the oldest slice of the span, never the whole recording.
    const span = DURATION_MS - STEP_MS;
    expect(cutoff).toBeLessThanOrEqual(span * 0.1 + STEP_MS);
  });

  it("below threshold: IDB eviction does NOT fire, but retention still trims memory", async () => {
    const deleteSpy = vi.spyOn(session.store, "deleteFramesBefore");
    vi.spyOn(session.store, "getStorageInfo").mockResolvedValue({
      usedBytes: 100,
      quotaBytes: 1_000,
      percentUsed: 10, // < 70
      idbFrameCount: DURATION_MS / STEP_MS,
    });

    seed();
    await session.store.flush();

    // Quota eviction is a no-op below threshold.
    expect(deleteSpy).not.toHaveBeenCalled();
    // Retention is independent of quota — memory is still bounded to retentionMs.
    const lastT = DURATION_MS - STEP_MS;
    const recent = session.recorder.getRecentFrames("cpu", 0, DURATION_MS);
    for (const f of recent) {
      expect(f.t).toBeGreaterThanOrEqual(lastT - RETENTION_MS);
    }
  });
});
