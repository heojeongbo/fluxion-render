import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../../../entities/metric-channel/metric-channel";
import type { ReplayClock } from "../../../shared/model/storage";
import { ReplayPlayer } from "./replay-player";

class Clock implements ReplayClock {
  currentT = 0;
  tick: (t: number) => void = () => {};
  start(t: number) {
    this.currentT = t;
  }
  seek(t: number) {
    this.currentT = t;
  }
  onTick(fn: (t: number) => void) {
    this.tick = fn;
    return () => {
      this.tick = () => {};
    };
  }
  advance(t: number) {
    this.currentT = t;
    this.tick(t);
  }
  pause() {}
  resume() {}
  stop() {}
  setRate() {}
  dispose() {}
}
afterEach(() => vi.restoreAllMocks());
describe("replay frame identity", () => {
  it("seek discards overlapping prefetch and emits each frame once, including the endpoint before end", async () => {
    const channel = new MetricChannel("metric");
    const clock = new Clock();
    const rows = [0, 500, 1000].map((t) => ({
      t,
      channelId: "metric",
      payload: channel.encode({ name: "n", value: t }),
    }));
    const store = {
      getFrames: vi.fn(async (from: number, to: number) =>
        rows.filter((f) => f.t > from && f.t <= to),
      ),
    };
    const player = new ReplayPlayer({
      store,
      clock,
      channels: new Map([["metric", channel]]),
      timeRange: { earliest: 0, latest: 1000 },
    });
    const events: (number | string)[] = [];
    player.onFrame((f) => events.push(f.t));
    player.onEnd(() => events.push("end"));
    player.play();
    clock.advance(0);
    await Promise.resolve();
    await Promise.resolve();
    player.seek(500);
    clock.advance(500);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(501);
    expect(events).toEqual([0, 500]);
    clock.advance(1000);
    expect(events).toEqual([0, 500, 1000, "end"]);
    expect(player.currentT).toBe(1000);
    clock.advance(1001);
    expect(events.filter((e) => e === "end")).toHaveLength(1);
    player.dispose();
  });
  it("waits for a delayed terminal read and never publishes after disposal", async () => {
    const channel = new MetricChannel("metric");
    const clock = new Clock();
    let resolve!: (
      rows: { t: number; channelId: string; payload: ArrayBuffer }[],
    ) => void;
    const store = {
      getFrames: () =>
        new Promise<{ t: number; channelId: string; payload: ArrayBuffer }[]>((r) => {
          resolve = r;
        }),
    };
    const player = new ReplayPlayer({
      store,
      clock,
      channels: new Map([["metric", channel]]),
      timeRange: { earliest: 0, latest: 1 },
    });
    const events: string[] = [];
    player.onFrame(() => events.push("frame"));
    player.onEnd(() => events.push("end"));
    player.play();
    clock.advance(2);
    expect(events).toEqual([]);
    resolve([
      { t: 1, channelId: "metric", payload: channel.encode({ name: "n", value: 1 }) },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["frame", "end"]);
    player.play();
    clock.advance(2);
    player.dispose();
    resolve([]);
    await Promise.resolve();
    expect(events).toEqual(["frame", "end"]);
  });
});
