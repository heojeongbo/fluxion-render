import { vi } from "vitest";
import { MetricChannel } from "../../../entities/metric-channel/metric-channel";
import type {
  ReplayPlayer,
  ReplayPlayerFrame,
  ReplayPlayerState,
} from "../../../features/player/model/replay-player";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import type { BaseChannel } from "../../../shared/model/base-channel";
import type { SerializedFrame } from "../../../shared/model/frame";
import { useChartReplay } from "./use-chart-replay";

// Shared test doubles for useChartReplay's tests and benches. Kept in lib/ so
// both .test.tsx and .bench.ts can import without circular paths.

export interface PushCall {
  id: string;
  sample: { t: number; y: number };
}
export interface PushBatchCall {
  id: string;
  samples: { t: number; y: number }[];
}
export interface ResetCall {
  id: string;
  latestT?: number;
}

export function makeFakeHost() {
  const pushes: PushCall[] = [];
  const batches: PushBatchCall[] = [];
  const resets: ResetCall[] = [];
  const order: string[] = []; // order in which mutations happened

  const handle = {
    id: "signal",
    push: vi.fn((s: { t: number; y: number }) => {
      pushes.push({ id: "signal", sample: s });
      order.push(`push:${s.t}:${s.y}`);
    }),
    pushBatch: vi.fn((samples: readonly { t: number; y: number }[]) => {
      batches.push({ id: "signal", samples: [...samples] });
      order.push(`pushBatch:${samples.length}`);
    }),
    reset: vi.fn((latestT?: number) => {
      resets.push({ id: "signal", latestT });
      order.push(`reset:${latestT ?? "undef"}`);
    }),
  };

  const host = {
    line: vi.fn((_id: string) => handle),
  };

  return { host, handle, pushes, batches, resets, order };
}

export type FrameListener = (frame: ReplayPlayerFrame) => void;
export type SeekListener = (t: number) => void;
export type TickListener = (t: number) => void;
export type EndListener = () => void;
export type StateListener = (state: ReplayPlayerState) => void;

export function makeFakePlayer(initialT = 1000) {
  const frameListeners = new Set<FrameListener>();
  const seekListeners = new Set<SeekListener>();
  const tickListeners = new Set<TickListener>();
  const endListeners = new Set<EndListener>();
  const stateListeners = new Set<StateListener>();
  let currentT = initialT;
  let state: ReplayPlayerState = "idle";

  return {
    get currentT() {
      return currentT;
    },
    setCurrentT(t: number) {
      currentT = t;
    },
    get state() {
      return state;
    },
    // Supports both `onFrame(listener)` and
    // `onFrame(channel, listener)` (Phase 20-B-1 overloads). When called
    // with a channel, wraps the listener with a channelId filter so the
    // real player's behaviour is faithfully mirrored.
    onFrame: vi.fn(
      (
        channelOrListener: BaseChannel<unknown> | FrameListener,
        maybeListener?: FrameListener,
      ) => {
        if (typeof channelOrListener === "function") {
          const l = channelOrListener;
          frameListeners.add(l);
          return () => frameListeners.delete(l);
        }
        const targetId = channelOrListener.channelId;
        const wrapper: FrameListener = (frame) => {
          if (frame.channelId !== targetId) return;
          maybeListener?.(frame);
        };
        frameListeners.add(wrapper);
        return () => frameListeners.delete(wrapper);
      },
    ),
    onSeek: vi.fn((l: SeekListener) => {
      seekListeners.add(l);
      return () => seekListeners.delete(l);
    }),
    onTick: vi.fn((l: TickListener) => {
      tickListeners.add(l);
      return () => tickListeners.delete(l);
    }),
    onEnd: vi.fn((l: EndListener) => {
      endListeners.add(l);
      return () => endListeners.delete(l);
    }),
    onStateChange: vi.fn((l: StateListener) => {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    }),
    seek: vi.fn((_t: number) => {}),
    play: vi.fn((_rate?: number) => {}),
    pause: vi.fn(() => {}),
    stop: vi.fn(() => {}),
    dispose: vi.fn(() => {
      frameListeners.clear();
      seekListeners.clear();
      tickListeners.clear();
      endListeners.clear();
      stateListeners.clear();
    }),
    emitFrame(frame: ReplayPlayerFrame) {
      for (const l of frameListeners) l(frame);
    },
    emitSeek(t: number) {
      for (const l of seekListeners) l(t);
    },
    emitTick(t: number) {
      for (const l of tickListeners) l(t);
    },
    emitEnd() {
      for (const l of endListeners) l();
    },
    emitState(s: ReplayPlayerState) {
      state = s;
      for (const l of stateListeners) l(s);
    },
    frameListenerCount() {
      return frameListeners.size;
    },
    seekListenerCount() {
      return seekListeners.size;
    },
    tickListenerCount() {
      return tickListeners.size;
    },
    endListenerCount() {
      return endListeners.size;
    },
    stateListenerCount() {
      return stateListeners.size;
    },
  };
}

export type FakePlayer = ReturnType<typeof makeFakePlayer>;

/**
 * Mock the slice of `ReplaySession` that `useReplayDvr` touches:
 * `enterReplay` / `exitReplay`. Holds a fake player so successive
 * `enterReplay` calls return either the same player or a fresh one
 * (`fresh: true` opt-in).
 */
export interface MakeFakeSessionOpts {
  /** Player returned by enterReplay. Defaults to a new makeFakePlayer(0). */
  player?: FakePlayer;
  /** If true, enterReplay creates a fresh fake player each call. */
  fresh?: boolean;
  /**
   * Value returned by `session.getTimeRange()`. Defaults to null (no
   * recording yet). Pass the same object you pass as `liveTimeRange` so
   * `useReplayDvr.enter()` sees a consistent range regardless of which
   * path it reads it from.
   */
  timeRange?: { earliest: number; latest: number } | null;
}

export function makeFakeSession(opts: MakeFakeSessionOpts = {}) {
  let activePlayer = opts.player ?? makeFakePlayer(0);
  const enterCalls: number[] = [];
  const exitCalls: number[] = [];
  // When pendingResolvers is non-null, enterReplay parks each call's resolve
  // here and the test drives ordering with releaseEnter(n) / releaseEnterReverse().
  let pendingEnterResolvers: Array<() => void> | null = null;

  const enterReplay = vi.fn(async (t?: number): Promise<FakePlayer | null> => {
    enterCalls.push(t ?? Number.NaN);
    // Capture the player snapshot at call time so each call returns its own.
    const player = opts.fresh ? makeFakePlayer(t ?? 0) : activePlayer;
    if (opts.fresh) activePlayer = player;
    else if (t !== undefined) activePlayer.setCurrentT(t);

    if (pendingEnterResolvers) {
      await new Promise<void>((resolve) => pendingEnterResolvers!.push(resolve));
    }
    return player;
  });

  const exitReplay = vi.fn(() => {
    exitCalls.push(performance.now());
  });

  // useReplayDvr's exit() calls session.getTimeRange() in the background to
  // prefetch the post-exit IDB latest for the next enter() staleness check.
  let _timeRange = opts.timeRange ?? null;
  const session = {
    __fake: true,
    getTimeRange: vi.fn(async () => _timeRange),
    setTimeRange(r: { earliest: number; latest: number } | null) {
      _timeRange = r;
    },
  } as unknown as ReplaySession & {
    setTimeRange(r: { earliest: number; latest: number } | null): void;
  };

  return {
    session,
    enterReplay: enterReplay as unknown as (t?: number) => Promise<ReplayPlayer | null>,
    exitReplay,
    enterCalls,
    exitCalls,
    get player() {
      return activePlayer;
    },
    /** Park subsequent enterReplay calls until releaseEnter*. */
    holdEnter(): void {
      pendingEnterResolvers = [];
    },
    /** Resolve all parked enters in arrival order. */
    async releaseEnter(): Promise<void> {
      const resolvers = pendingEnterResolvers ?? [];
      pendingEnterResolvers = null;
      for (const r of resolvers) r();
      await Promise.resolve();
    },
    /** Resolve parked enters in REVERSE order — stale enter wins the race. */
    async releaseEnterReverse(): Promise<void> {
      const resolvers = pendingEnterResolvers ?? [];
      pendingEnterResolvers = null;
      for (let i = resolvers.length - 1; i >= 0; i--) resolvers[i]!();
      await Promise.resolve();
    },
    pendingEnterCount(): number {
      return pendingEnterResolvers?.length ?? 0;
    },
  };
}

/**
 * Fake store with optional pending-promise hold. Tests can call `hold()` to
 * pause new `getFramesByChannel` resolutions, fire other events (like
 * `player.emitFrame`), then `release()` to let the pending hydrate complete.
 * Lets us reliably reproduce hydrate-vs-onFrame races.
 */
export function makeFakeStore(framesByChannel: Record<string, SerializedFrame[]>) {
  let pendingResolvers: Array<() => void> = [];
  let isHeld = false;

  // Supports both `getFramesByChannel(channelId, ...)` and the typed
  // `getFramesByChannel(channel, ...)` overload (Phase 20-B-2). When a
  // channel is passed, payloads are decoded into `{ t, channelId, data }`.
  const getFramesByChannel = vi.fn(
    async (
      channelOrId: string | BaseChannel<unknown>,
      fromMs: number,
      toMs: number,
    ): Promise<
      SerializedFrame[] | Array<{ t: number; channelId: string; data: unknown }>
    > => {
      const channelId =
        typeof channelOrId === "string" ? channelOrId : channelOrId.channelId;
      const all = framesByChannel[channelId] ?? [];
      const filtered = all.filter((f) => f.t >= fromMs && f.t <= toMs);
      if (isHeld) {
        await new Promise<void>((resolve) => pendingResolvers.push(resolve));
      }
      if (typeof channelOrId === "string") return filtered;
      return filtered.map((f) => ({
        t: f.t,
        channelId: f.channelId,
        data: channelOrId.decode(f.payload),
      }));
    },
  );

  // No-op spy — callers (e.g. useChartLiveBackfill) await this before
  // querying so they observe the recorder's just-committed batch. The fake
  // has nothing to flush, but exposing the spy lets tests assert order.
  const flush = vi.fn(async () => {});

  return {
    getFramesByChannel,
    flush,
    /** Hold subsequent getFramesByChannel calls until release(). */
    hold(): void {
      isHeld = true;
    },
    /** Resolve every currently-pending getFramesByChannel call. */
    async release(): Promise<void> {
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      isHeld = false;
      for (const r of resolvers) r();
      // One microtask hop so awaiting code can advance.
      await Promise.resolve();
    },
    pendingCount(): number {
      return pendingResolvers.length;
    },
  };
}

/**
 * Build a SerializedFrame with a MetricChannel-encoded payload.
 * The decoded `value` becomes the chart y.
 */
export function metricFrame(
  channelId: string,
  t: number,
  value: number,
): SerializedFrame {
  const ch = new MetricChannel(channelId);
  return { t, channelId, payload: ch.encode({ name: channelId, value }) };
}

export interface BuildRecordingOpts {
  /** Absolute base timestamp the first frame lands on. */
  origin: number;
  /** Sample rate in Hz. Frame spacing = 1000 / hz ms. */
  hz: number;
  /** Total recording length in ms (e.g. 60_000 for one minute). */
  durationMs: number;
  /** Defaults to "signal". */
  channelId?: string;
  /** Optional value generator. Receives the frame index. Defaults to a sine. */
  signalFn?: (i: number, hz: number) => number;
}

/**
 * Materialise a deterministic recording of `durationMs * hz / 1000` frames.
 * Used by tests for assertions and by benches for warmup payloads.
 */
export function buildRecording(opts: BuildRecordingOpts): SerializedFrame[] {
  const channelId = opts.channelId ?? "signal";
  const frameCount = Math.floor(opts.durationMs * (opts.hz / 1000));
  const signalFn = opts.signalFn ?? ((i, hz) => Math.sin((i / hz) * 0.6) * 0.8);
  const out: SerializedFrame[] = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    out[i] = metricFrame(
      channelId,
      opts.origin + i * (1000 / opts.hz),
      signalFn(i, opts.hz),
    );
  }
  return out;
}

// Stable channel instance — useChartReplay's effect deps include `channel`,
// so reusing one prevents spurious re-subscribes across renders.
export const SIGNAL_CHANNEL = new MetricChannel("signal");

export interface ChartReplayProbeProps {
  host: ReturnType<typeof makeFakeHost>["host"] | null;
  player: ReturnType<typeof makeFakePlayer> | null;
  store: ReturnType<typeof makeFakeStore> | null;
  windowMs: number;
  timeOrigin?: number;
  channel?: MetricChannel;
}

/**
 * Thin React harness that mounts `useChartReplay` with the fake shapes from
 * this fixtures module. Returned by `render()` so callers can `act()` around
 * it and inspect the spy arrays on the fake host.
 */
export function ChartReplayProbe(props: ChartReplayProbeProps) {
  const channel = props.channel ?? SIGNAL_CHANNEL;
  useChartReplay({
    host: props.host as never,
    player: props.player as never,
    store: props.store as never,
    channel,
    windowMs: props.windowMs,
    timeOrigin: props.timeOrigin,
    pickValue: (d) => d.value,
  });
  return null;
}
