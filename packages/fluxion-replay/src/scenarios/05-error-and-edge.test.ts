/**
 * Scenario 05: Error Handling & Edge Cases
 *
 * Validates the library's robustness:
 * - Graceful degradation when data is absent.
 * - Safe replay after clearRecording().
 * - Correct resource cleanup on dispose().
 * - Seek clamping at range boundaries.
 * - Listener isolation after dispose().
 * - Concurrent enterReplay calls (last one wins, previous player is disposed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../entities/metric-channel/metric-channel";
import { ReplaySession } from "../features/session/model/replay-session";
import { drain, seedMetricFrames } from "./_helpers";

const CPU = new MetricChannel("cpu");

describe("Scenario 05: error handling and edge cases", () => {
  let session: ReplaySession;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = new ReplaySession({ channels: [CPU] });
    await session.open();
    await session.startRecording();
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
  });

  it("enterReplay on an empty store returns a player with a fallback time range", async () => {
    // No frames recorded — IDB is empty
    const player = await session.enterReplay();
    expect(player).toBeDefined();
    // Fallback range must be a real non-zero interval
    expect(player.timeRange.latest).toBeGreaterThan(player.timeRange.earliest);
    session.exitReplay();
  });

  it("getTimeRange returns null before any frames are flushed", async () => {
    const range = await session.getTimeRange();
    expect(range).toBeNull();
  });

  it("clearRecording wipes IDB and allows fresh recording", async () => {
    seedMetricFrames(session, "cpu", 5);
    await session.store.flush();

    const before = await session.getTimeRange();
    expect(before).not.toBeNull();

    await session.clearRecording();

    const after = await session.getTimeRange();
    expect(after).toBeNull();

    // Re-record and verify the new data is stored
    session.record("cpu", { name: "cpu", value: 99 }, 100);
    await session.store.flush();

    const fresh = await session.getTimeRange();
    expect(fresh!.earliest).toBe(100);
  });

  it("dispose() clears all timers — clearInterval called for flush and log timers", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const s = new ReplaySession({
      channels: [CPU],
      storageLogIntervalMs: 1_000,
    });
    await s.open();
    s.dispose();

    // flush timer + storage-log timer = at least 2 clearInterval calls
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    clearSpy.mockRestore();
  });

  it("onFrame listener is not called after player.dispose()", async () => {
    seedMetricFrames(session, "cpu", 3);
    await session.store.flush();

    const player = await session.enterReplay();
    const received: number[] = [];
    player.onFrame(({ t }) => received.push(t));

    player.dispose();

    // Advance time — the disposed player must not fire any more listeners
    player.play();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(received).toHaveLength(0);
    session.exitReplay();
  });

  it("seek below earliest clamps to earliest", async () => {
    seedMetricFrames(session, "cpu", 3); // t = 1000, 2000, 3000
    await session.store.flush();

    const player = await session.enterReplay();
    player.seek(-99_999);
    await drain();

    expect(player.currentT).toBe(player.timeRange.earliest);
    session.exitReplay();
  });

  it("seek above latest clamps to latest", async () => {
    seedMetricFrames(session, "cpu", 3); // t = 1000, 2000, 3000
    await session.store.flush();

    const player = await session.enterReplay();
    player.seek(99_999_999);
    await drain();

    expect(player.currentT).toBe(player.timeRange.latest);
    session.exitReplay();
  });

  it("calling enterReplay again replaces the previous player and the session holds the new one", async () => {
    seedMetricFrames(session, "cpu", 5);
    await session.store.flush();

    const p1 = await session.enterReplay(1_000);
    expect(session.player).toBe(p1);

    // Second call — p1 is disposed, p2 becomes the active player
    const disposeSpy = vi.spyOn(p1, "dispose");
    const p2 = await session.enterReplay(2_000);

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(session.player).toBe(p2);
    expect(session.player).not.toBe(p1);

    session.exitReplay();
  });

  it("record() while stopped is silently ignored (no error thrown)", async () => {
    seedMetricFrames(session, "cpu", 3, 1_000);
    await session.store.flush();

    session.stopRecording();
    expect(session.recorder.isRecording).toBe(false);

    // record() when stopped must be a no-op, not throw
    expect(() => session.record("cpu", { name: "cpu", value: 77 }, 9_000)).not.toThrow();

    await session.startRecording();
    expect(session.recorder.isRecording).toBe(true);

    // Old frames survived the stop/start cycle
    const range = await session.getTimeRange();
    expect(range!.earliest).toBe(1_000);
  });

  it("multiple onEnd listeners all fire when playback finishes", async () => {
    seedMetricFrames(session, "cpu", 2);
    await session.store.flush();

    const player = await session.enterReplay();
    const counts = [0, 0, 0];
    player.onEnd(() => counts[0]++);
    player.onEnd(() => counts[1]++);
    player.onEnd(() => counts[2]++);

    player.play();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(counts).toEqual([1, 1, 1]);
    session.exitReplay();
  });

  it("unsubscribe function returned by onFrame stops delivery", async () => {
    seedMetricFrames(session, "cpu", 5);
    await session.store.flush();

    const player = await session.enterReplay();
    const received: number[] = [];
    const off = player.onFrame(({ t }) => received.push(t));

    // Unsubscribe before play starts — no frames should arrive
    off();
    player.play();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(received).toHaveLength(0);
    session.exitReplay();
  });
});
