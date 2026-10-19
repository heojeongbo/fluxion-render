import type {
  FluxionHost,
  LineLayerHandle,
  LineSample,
} from "@heojeongbo/fluxion-render";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ReplayPlayer,
  ReplayPlayerFrame,
} from "../../../features/player/model/replay-player";
import type { BaseChannel } from "../../../shared/model/base-channel";
import type {
  DecodedFrame,
  ReplayStorage as ReplayStore,
} from "../../../shared/model/storage";

/** Default ms fetched + cached on each side of the visible window. */
const DEFAULT_PREFETCH_MARGIN_MS = 3000;

export interface UseChartReplayOptions<T> {
  /** Host returned by `<FluxionCanvas onReady={setHost}>`. `null` while mounting. */
  host: FluxionHost | null;
  /**
   * Player from `session.enterReplay()`. `null` puts the hook in idle mode —
   * nothing is fetched or pushed. Setting it to a non-null player triggers an
   * immediate backfill at `player.currentT`.
   */
  player: ReplayPlayer | null;
  /** The store backing `player`. Used for the windowed channel-scoped query. */
  store: ReplayStore | null;
  /** Channel to read from. The hook subscribes to `player.onFrame` for this id. */
  channel: BaseChannel<T>;
  /** Target line layer id. Defaults to `channel.channelId`. */
  layerId?: string;
  /**
   * Visible window in ms. On mount and on every `player.seek(t)`, the hook
   * queries `[t - windowMs, t]` from the store and pushes that batch into
   * the chart so the seek point becomes the right edge of the time axis.
   */
  windowMs: number;
  /** Extract the chart y-value from a decoded frame. */
  pickValue: (data: T) => number;
  /**
   * Subtracted from every `t` before it's pushed to the chart layer. The chart's
   * wire format is `Float32` per `[t, y]` pair, so passing absolute ms-since-epoch
   * (~1.78e12) quantises 20Hz samples into a single bucket (~131,072ms precision)
   * — the chart degenerates into a vertical line.
   *
   * Pick a stable origin near "now" (e.g. `useMemo(() => Date.now(), [])` at the
   * page level) and pass the same value to `axisGridLayer({ timeOrigin })` so
   * tick labels still show wall-clock time. Store queries are unaffected — the
   * store holds absolute t, and only the in-memory chart push is shifted.
   *
   * Default `0` (push absolute t — only safe when t fits Float32 precision,
   * i.e. tests with small values or session-relative timelines).
   */
  timeOrigin?: number;
  /**
   * Extra ms fetched + cached on BOTH sides of the visible window so a
   * subsequent seek within ±prefetchMarginMs is an instant cache hit (no IDB
   * round-trip / decode). Only the visible window `[t - windowMs, t]` is ever
   * rendered; the margin lives in the cache only. Default 3000.
   */
  prefetchMarginMs?: number;
}

export interface UseChartReplayResult {
  /** True while a hydrate (backfill query + push) is in flight. */
  isHydrating: boolean;
  /** Sample count from the most recent hydrate (live `onFrame` pushes not counted). */
  hydratedCount: number;
}

/**
 * Bridge between `ReplayPlayer` and a `fluxion-render` streaming line layer.
 *
 * Lifecycle:
 *   - Mount (or `player` becomes non-null) → hydrate at `player.currentT`:
 *     query the store for `[currentT - windowMs, currentT]`, decode each
 *     frame's payload via `channel.decode`, then `handle.reset(currentT)` +
 *     `handle.pushBatch(...)` to make the seek point the right edge.
 *   - `player.seek(t)` → re-hydrate at the clamped t.
 *   - `player.onFrame(channelId)` → `handle.push({ t, y })` for live playback.
 *   - Unmount or deps change → unsubscribe and ignore any in-flight hydrate.
 *
 * Pair with an `axisGridLayer({ xMode: "time", timeWindowMs })` whose
 * `timeWindowMs` matches `windowMs` to keep the chart axis in lockstep.
 */
export function useChartReplay<T>(opts: UseChartReplayOptions<T>): UseChartReplayResult {
  const { host, player, store, channel, windowMs, pickValue } = opts;
  const layerId = opts.layerId ?? channel.channelId;
  const timeOrigin = opts.timeOrigin ?? 0;
  const marginMs = opts.prefetchMarginMs ?? DEFAULT_PREFETCH_MARGIN_MS;

  const [isHydrating, setIsHydrating] = useState(false);
  const [hydratedCount, setHydratedCount] = useState(0);

  // Capture pickValue in a ref so inline arrow functions don't reset the
  // effect on every render — only structural deps drive re-subscription.
  const pickRef = useRef(pickValue);
  pickRef.current = pickValue;

  // Fix 1: cache the last hydrate result so seeks within the same window
  // skip the IDB round-trip entirely.

  // Fix 3: accumulate onFrame events per tick instead of calling handle.push()
  // once per frame — drained as a single pushBatch() in onTick.
  const liveBufferRef = useRef<LineSample[]>([]);

  const handle = useMemo<LineLayerHandle | null>(
    () => (host ? host.line(layerId) : null),
    [host, layerId],
  );

  // Phase 20-A-3: validate up-front so the mistake surfaces at the
  // component that introduced it, not silently as a blank chart from a
  // `[t - NaN, t]` store query. Runs during render so it doesn't get
  // swallowed by React's effect-error handling.
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(
      `useChartReplay: windowMs must be a positive finite number (got ${String(windowMs)}). ` +
        "Match it to your axisGridLayer({ timeWindowMs }) value.",
    );
  }

  useEffect(() => {
    if (!handle || !player || !store) return;

    let cache: {
      from: number;
      to: number;
      frames: DecodedFrame<T>[];
      generation?: number;
    } | null = null;
    let cancelled = false;
    // Sequential hydrate queue. At most one IDB query in flight at a time.
    // Additional seek bursts collapse into `queuedT` — the last requested
    // t replaces any earlier queued value. After the current hydrate
    // finishes, we immediately re-run with `queuedT` if non-null. This
    // gives the user 2-3 visible chart updates during a fast drag instead
    // of just the final one (the prior generation-counter pattern silently
    // discarded every intermediate hydrate).
    let inFlight = false;
    let queuedT: number | null = null;
    // While a hydrate is in flight, every onFrame is parked here. After the
    // backfill lands, the buffer is drained: in-range frames (covered by
    // the backfill) are dropped, post-seek frames flush in arrival order.
    // Without this gate, a frame that arrives BEFORE handle.reset() would
    // get wiped by the reset, leaving the chart with a stutter.
    let hydratingT: number | null = null;
    const pending: ReplayPlayerFrame<T>[] = [];
    // Reset per-effect live buffer so stale samples from a prior player
    // don't bleed into the new subscription.
    liveBufferRef.current = [];

    const flushPending = (cutoff: number) => {
      if (pending.length === 0) return;
      const drained = pending.splice(0, pending.length);
      for (const f of drained) {
        if (f.t <= cutoff) continue; // backfill already covers this t
        handle.push({ t: f.t - timeOrigin, y: pickRef.current(f.data) });
      }
    };

    const runHydrate = async (firstT: number): Promise<void> => {
      inFlight = true;
      let t = firstT;
      try {
        while (!cancelled) {
          hydratingT = t;
          pending.length = 0;
          setIsHydrating(true);

          // Visible window actually drawn — the seek point is its right edge.
          const visibleFrom = t - windowMs;
          // Fetch + cache a wider span (±marginMs) so a re-seek within the
          // margin is a pure cache hit (no IDB, no decode) — instant scrub.
          // Only the visible window is ever pushed (filtered below).
          const fetchFrom = visibleFrom - marginMs;
          const fetchTo = t + marginMs;
          const generation = store.recordingGeneration;
          let frames: DecodedFrame<T>[];
          if (
            cache &&
            cache.generation === generation &&
            cache.from <= visibleFrom &&
            cache.to >= t
          ) {
            // Cache hit: the cached span covers the visible window. Keep the
            // whole cached span; the visible-window filter below narrows it.
            frames = cache.frames;
          } else {
            // Store keeps absolute t; query in that space. Pass the channel
            // (not the channelId) so the store decodes payloads up-front and
            // we don't need to `as T` the result. Phase 20-B-3.
            frames = await store.getFramesByChannel(channel, fetchFrom, fetchTo);
            if (cancelled || generation !== store.recordingGeneration) return;
            cache = { from: fetchFrom, to: fetchTo, frames, generation };
          }
          // Yield once so a React cleanup that sets `cancelled = true` has a
          // chance to run before we touch the chart. Without this yield, a
          // fast-resolving IDB query (cache hit / fake-IDB microtask) lets a
          // stale hydrate's reset+pushBatch land AFTER the next phase
          // (useChartLiveBackfill) already wrote live data — wiping it.
          await Promise.resolve();
          if (cancelled) return;

          // Shift into the chart's host-relative timeline so the Float32 wire
          // format doesn't quantise away the resolution. Render ONLY the
          // visible window [visibleFrom, t] — the ±margin frames live in the
          // cache (for instant re-seeks) but are never pushed to the chart.
          const batch: LineSample[] = [];
          for (const f of frames) {
            if (f.t < visibleFrom || f.t > t) continue;
            batch.push({ t: f.t - timeOrigin, y: pickRef.current(f.data) });
          }
          // 1) Drop stale data + force the worker-side axis to rewind to the
          //    seek point in host-relative space.
          // 2) Re-push backfill — settles the window at
          //    [t - windowMs - timeOrigin, t - timeOrigin].
          // Re-check cancellation in the SAME synchronous tick as the chart
          // write. A DVR→Live transition tears this effect down (cancelled =
          // true) and useChartLiveBackfill takes over; a hydrate whose final
          // await resolved in the cleanup's microtask batch could otherwise
          // emit a stale reset(dvrT) here, forcing the backfill to fight it.
          // This guard is what lets useChartLiveBackfill drop its sync reset.
          if (cancelled) return;
          handle.reset(t - timeOrigin);
          if (batch.length > 0) handle.pushBatch(batch);
          setHydratedCount(batch.length);
          // Replay any onFrame events that landed during the await — only
          // those past the seek point, in arrival order.
          flushPending(t);
          hydratingT = null;

          // Drain queue: jump to the most-recent seek if user kept firing
          // during the await. Intermediate t values are intentionally
          // skipped so we don't fall behind a rapid drag.
          if (queuedT === null) break;
          t = queuedT;
          queuedT = null;
        }
      } catch (err) {
        // Surface IDB / decode errors — they would otherwise be silently
        // swallowed because runHydrate is called via `void`.
        console.error("[useChartReplay] hydrate failed:", err);
      } finally {
        inFlight = false;
        hydratingT = null;
        if (!cancelled) setIsHydrating(false);
      }
    };

    const hydrate = (t: number): void => {
      if (inFlight) {
        // Collapse intermediate seeks; only the LAST t wins. Memory bound is
        // a single number regardless of drag length.
        queuedT = t;
        return;
      }
      void runHydrate(t);
    };

    hydrate(player.currentT);

    const offSeek = player.onSeek((t) => {
      hydrate(t);
    });

    // Typed overload: only this channel's frames reach the listener, and
    // `frame.data` is `T` without a cast (Phase 20-B-1).
    const offFrame = player.onFrame<T>(channel, (frame) => {
      if (hydratingT !== null) {
        // Park until the in-flight hydrate finishes — it'll decide whether
        // to flush or drop based on the seek point.
        pending.push(frame);
        return;
      }
      // Fix 3: accumulate into buffer; onTick flushes as a single pushBatch.
      liveBufferRef.current.push({
        t: frame.t - timeOrigin,
        y: pickRef.current(frame.data),
      });
    });

    // Fix 3: drain the live buffer once per tick with a single pushBatch call
    // instead of one handle.push() per frame, reducing GPU command overhead.
    const offTick = player.onTick(() => {
      const buf = liveBufferRef.current;
      if (buf.length === 0) return;
      if (buf.length === 1) {
        handle.push(buf[0]!);
      } else {
        handle.pushBatch(buf.slice());
      }
      buf.length = 0;
    });

    return () => {
      cancelled = true;
      pending.length = 0;
      queuedT = null;
      liveBufferRef.current = [];
      offSeek();
      offFrame();
      offTick();
    };
  }, [handle, player, store, channel, windowMs, timeOrigin, marginMs]);

  return { isHydrating, hydratedCount };
}
