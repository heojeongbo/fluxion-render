import { VirtualClock } from "../../../shared/lib/virtual-clock";
import type { BaseChannel } from "../../../shared/model/base-channel";
import type { SerializedFrame } from "../../../shared/model/frame";
import type { FrameReader, ReplayClock } from "../../../shared/model/storage";

export type ReplayPlayerState = "idle" | "playing" | "paused" | "stopped";

export interface ReplayPlayerFrame<T = unknown> {
  readonly channelId: string;
  readonly data: T;
  readonly t: number;
}

export type FrameListener<T = unknown> = (frame: ReplayPlayerFrame<T>) => void;
export type TickListener = (currentT: number) => void;
export type StateListener = (state: ReplayPlayerState) => void;
export type EndListener = () => void;
export type SeekListener = (clampedT: number) => void;

export interface ReplayPlayerOptions {
  store: FrameReader;
  channels: Map<string, BaseChannel<unknown>>;
  timeRange: { earliest: number; latest: number };
  prefetchMs?: number;
  /** Injectable owned clock; defaults to VirtualClock. */
  clock?: ReplayClock;
}

const DEFAULT_PREFETCH_MS = 2_000;

/**
 * Refill hysteresis, as a fraction of `prefetchMs`.
 *
 * Without it, `_prefetch` sets `_prefetchedUpTo = currentT + prefetchMs`, so
 * the very next tick (16 ms later) is already "behind" the horizon and fetches
 * again — one IndexedDB range query per animation frame, each covering ~16 ms
 * and returning about one frame. Measured at 60 queries/second per playing
 * player, and in the scenario tests it was 98% of their wall clock
 * (4 064 ticks → 4 064 `getFrames` calls for a 65 s playback).
 *
 * Refilling only once the buffered horizon has drained below half the window
 * makes it one query per ~`prefetchMs / 2` of playback instead, while still
 * leaving that much buffered runway for the async fetch to land.
 */
const REFILL_AT = 0.5;

/** Returns the index of the first element with t > value (sorted ascending). */
function upperBound(arr: SerializedFrame[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ReplayPlayer {
  private readonly _clock: ReplayClock;
  private readonly _store: FrameReader;
  private readonly _channels: Map<string, BaseChannel<unknown>>;
  private readonly _timeRange: { earliest: number; latest: number };
  private readonly _prefetchMs: number;
  private _state: ReplayPlayerState = "idle";
  private _frameListeners = new Set<FrameListener>();
  private _tickListeners = new Set<TickListener>();
  private _stateListeners = new Set<StateListener>();
  private _endListeners = new Set<EndListener>();
  private _seekListeners = new Set<SeekListener>();
  private _prefetchBuffer: SerializedFrame[] = [];
  private _prefetchedUpTo: number;
  // Tracks the last explicitly set position (via seek() or captured at stop()).
  // Used by play() so that seek() → stop() → play() resumes at the seek point
  // rather than timeRange.earliest (which VirtualClock.stop() would imply via
  // its _startVirtualMs = 0 reset).
  private _lastKnownT: number;
  private _isPrefetching = false;
  // Bumped whenever the prefetch buffer is reset (seek/play/stop). An in-flight
  // _prefetch captures this at start and discards its result if it changed —
  // preventing a fetch issued before a seek from reintroducing frames the seek
  // just discarded (which would surface as out-of-window "tangled" chart data).
  private _prefetchGeneration = 0;
  private _offTick: (() => void) | null = null;
  private _ended = false;

  constructor(opts: ReplayPlayerOptions) {
    this._store = opts.store;
    this._channels = opts.channels;
    this._timeRange = opts.timeRange;
    this._prefetchMs = opts.prefetchMs ?? DEFAULT_PREFETCH_MS;
    // Initialise to earliest - 1 so the first getFrames call uses an
    // inclusive lower bound (covering earliest exactly) while all subsequent
    // calls use lowerOpen=true to avoid re-fetching the boundary frame.
    this._prefetchedUpTo = opts.timeRange.earliest - 1;
    this._lastKnownT = opts.timeRange.earliest;
    this._clock = opts.clock ?? new VirtualClock();
  }

  get currentT(): number {
    // "stopped" is the only state where _clock.currentT is unreliable:
    // VirtualClock.stop() resets _startVirtualMs to 0, so the clock returns 0
    // regardless of where playback ended or where the last seek was.
    // _lastKnownT is captured by stop() just before the reset, giving the
    // correct "where am I" answer. All other states (idle, playing, paused)
    // rely on the clock directly — paused snapshots currentT into
    // _startVirtualMs so _clock.currentT remains accurate there too.
    return this._state === "stopped" ? this._lastKnownT : this._clock.currentT;
  }

  get state(): ReplayPlayerState {
    return this._state;
  }

  /**
   * The `{ earliest, latest }` window the player operates over — captured at
   * construction and never mutated. `latest` doubles as the playback end
   * condition: `_onTick` fires `onEnd` once `currentT >= timeRange.latest`,
   * and `seek()` clamps targets into this range.
   *
   * Returned reference is the internal object; treat as read-only.
   */
  get timeRange(): { readonly earliest: number; readonly latest: number } {
    return this._timeRange;
  }

  seek(t: number): void {
    const clamped = Math.max(
      this._timeRange.earliest,
      Math.min(this._timeRange.latest, t),
    );
    this._lastKnownT = clamped;
    this._clock.seek(clamped);
    // Use at least 3s lookback so a keyframe (default interval = 2s) is always included
    // before the seek point — prevents VP8 decoder corruption from missing keyframes.
    const lookback = Math.max(this._prefetchMs, 3_000);
    // Invalidate any in-flight prefetch so it can't merge stale pre-seek frames.
    this._prefetchGeneration++;
    this._prefetchBuffer = [];
    this._isPrefetching = false;
    this._prefetchedUpTo = Math.max(clamped - lookback, this._timeRange.earliest) - 1;
    this._ended = false;
    for (const listener of this._seekListeners) listener(clamped);
  }

  play(rate = 1.0): void {
    if (this._state === "idle" || this._state === "stopped") {
      // Use _lastKnownT (updated by seek() and stop()) instead of
      // _clock.currentT so that seek() → stop() → play() resumes at
      // the seek point. VirtualClock.stop() resets _startVirtualMs to 0,
      // so _clock.currentT would always return earliest after a stop.
      const startT = Math.max(
        this._timeRange.earliest,
        Math.min(this._timeRange.latest, this._lastKnownT),
      );
      this._prefetchGeneration++;
      // A superseded fetch never clears the flag itself (see _prefetch's finally).
      this._isPrefetching = false;
      this._prefetchedUpTo = Math.max(startT - 3_000, this._timeRange.earliest) - 1;
      this._prefetchBuffer = [];
      this._ended = false;
      this._offTick?.();
      this._offTick = null;
      this._clock.start(startT, rate);
      this._offTick = this._clock.onTick((t) => this._onTick(t));
    } else if (this._state === "paused") {
      this._clock.setRate(rate);
      this._clock.resume();
    } else {
      this._clock.setRate(rate);
      return;
    }
    this._setState("playing");
  }

  pause(): void {
    if (this._state !== "playing") return;
    this._clock.pause();
    this._setState("paused");
  }

  stop(): void {
    // Snapshot the current position before the clock resets to 0, so a
    // subsequent play() can resume from here rather than timeRange.earliest.
    this._lastKnownT = this._clock.currentT;
    this._clock.stop();
    this._offTick?.();
    this._offTick = null;
    this._prefetchGeneration++;
    this._isPrefetching = false;
    this._prefetchBuffer = [];
    this._prefetchedUpTo = this._timeRange.earliest;
    this._ended = false;
    this._setState("stopped");
  }

  /**
   * Subscribe to decoded frames. Two call forms:
   *
   * - `onFrame(listener)` — fires for every channel; `frame.data` is `unknown`.
   * - `onFrame(channel, listener)` — fires only for frames whose `channelId`
   *   matches `channel.channelId`; `frame.data` is typed as `T` so consumers
   *   don't have to cast. Internally still one shared listener set; the
   *   filter + cast happen at delivery time.
   */
  onFrame(listener: FrameListener<unknown>): () => void;
  onFrame<T>(channel: BaseChannel<T>, listener: FrameListener<T>): () => void;
  onFrame<T>(
    channelOrListener: BaseChannel<T> | FrameListener<unknown>,
    maybeListener?: FrameListener<T>,
  ): () => void {
    if (typeof channelOrListener === "function") {
      const l = channelOrListener as FrameListener;
      this._frameListeners.add(l);
      return () => this._frameListeners.delete(l);
    }
    // Channel-scoped overload — filter by channelId; the channel argument's
    // generic is the only reason we know `data` is `T`, so we cast inside.
    const targetId = channelOrListener.channelId;
    const typedListener = maybeListener as FrameListener<T>;
    const wrapper: FrameListener<unknown> = (frame) => {
      if (frame.channelId !== targetId) return;
      typedListener(frame as ReplayPlayerFrame<T>);
    };
    this._frameListeners.add(wrapper);
    return () => this._frameListeners.delete(wrapper);
  }

  onTick(listener: TickListener): () => void {
    this._tickListeners.add(listener);
    return () => this._tickListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this._stateListeners.add(listener);
    return () => this._stateListeners.delete(listener);
  }

  onEnd(listener: EndListener): () => void {
    this._endListeners.add(listener);
    return () => this._endListeners.delete(listener);
  }

  /**
   * Subscribe to `seek(t)` calls. Listener receives the clamped target time
   * (so callers can react without re-clamping). Useful for downstream
   * components — e.g. a chart that needs to re-hydrate from the store at
   * the new seek point — that can't be reached via the streaming `onFrame`
   * or `onTick` events.
   *
   * Returns an unsubscribe function.
   */
  onSeek(listener: SeekListener): () => void {
    this._seekListeners.add(listener);
    return () => this._seekListeners.delete(listener);
  }

  dispose(): void {
    this._prefetchGeneration++;
    this._isPrefetching = false;
    this._ended = true;
    this._clock.dispose();
    this._offTick?.();
    this._offTick = null;
    this._frameListeners.clear();
    this._tickListeners.clear();
    this._stateListeners.clear();
    this._endListeners.clear();
    this._seekListeners.clear();
    this._prefetchBuffer = [];
  }

  private _setState(state: ReplayPlayerState): void {
    this._state = state;
    for (const listener of this._stateListeners) {
      listener(state);
    }
  }

  private _onTick(currentT: number): void {
    if (this._ended) return;

    const atEnd = currentT >= this._timeRange.latest;
    currentT = Math.min(currentT, this._timeRange.latest);

    // Prefetch ahead — skip if a fetch is already in-flight, and only once the
    // buffered horizon has drained past REFILL_AT (see the constant: without
    // the hysteresis this fires on every single frame).
    // seek()/play()/stop() rewind `_prefetchedUpTo` behind `currentT`, making
    // the remaining horizon negative, so they still refill on the next tick.
    if (
      !this._isPrefetching &&
      this._prefetchedUpTo - currentT < this._prefetchMs * REFILL_AT
    ) {
      void this._prefetch(currentT);
    }

    // Do not end until a query covering the endpoint has completed.
    if (atEnd && (this._isPrefetching || this._prefetchedUpTo < currentT)) return;

    // Drain buffered frames up to currentT.
    // Buffer is kept sorted by t, so find the first frame past currentT with
    // binary search and splice in O(k) instead of scanning the whole buffer.
    const cutoff = upperBound(this._prefetchBuffer, currentT);
    const toEmit = this._prefetchBuffer.splice(0, cutoff);

    for (const f of toEmit) {
      const channel = this._channels.get(f.channelId);
      if (!channel) continue;
      const data = channel.decode(f.payload);
      const playerFrame: ReplayPlayerFrame = { channelId: f.channelId, data, t: f.t };
      // Isolate each listener — a throwing subscriber must not starve the
      // others of this frame (it was already spliced out of the buffer).
      for (const listener of this._frameListeners) {
        try {
          listener(playerFrame);
        } catch (err) {
          console.error("[fluxion-replay] frame listener error:", err);
        }
      }
    }

    // Emit tick
    for (const listener of this._tickListeners) {
      try {
        listener(currentT);
      } catch (err) {
        console.error("[fluxion-replay] tick listener error:", err);
      }
    }
    if (atEnd) {
      this.stop();
      this._lastKnownT = currentT;
      this._ended = true;
      for (const listener of this._endListeners) listener();
    }
  }

  private async _prefetch(currentT: number): Promise<void> {
    const from = this._prefetchedUpTo;
    const to = Math.min(currentT + this._prefetchMs, this._timeRange.latest);
    if (from >= to) return;
    this._isPrefetching = true;
    this._prefetchedUpTo = to;
    // Snapshot the generation; a seek/play/stop during the await bumps it and
    // means our result is stale (covers a window the player no longer wants).
    const generation = this._prefetchGeneration;

    try {
      // lowerOpen=true: the lower bound is the previously fetched upper edge,
      // so using an exclusive lower bound prevents the boundary frame from
      // being re-fetched and emitted twice when prefetch windows adjoin.
      const frames = await this._store.getFrames(from, to, true);
      // Discard if the buffer was reset while we were fetching — merging here
      // would reintroduce frames the seek/play/stop just dropped. Leave
      // `_prefetchedUpTo` to the newer generation (seek/play/stop already set it).
      if (this._prefetchGeneration !== generation) return;
      if (frames.length > 0) {
        // Queries cover disjoint chronological ranges; seek clears the buffer.
        // A loop also handles batches larger than the engine argument limit.
        for (const frame of frames) this._prefetchBuffer.push(frame);
      }
    } catch {
      // Roll back so the range is retried next tick — but only if still current;
      // a stale rejection must not clobber the post-seek `_prefetchedUpTo`.
      if (this._prefetchGeneration === generation) {
        this._prefetchedUpTo = from;
      }
    } finally {
      if (this._prefetchGeneration === generation) {
        this._isPrefetching = false;
        if (
          this._state === "playing" &&
          this._clock.currentT >= this._timeRange.latest &&
          this._prefetchedUpTo >= this._timeRange.latest
        )
          this._onTick(this._clock.currentT);
      }
    }
  }
}
