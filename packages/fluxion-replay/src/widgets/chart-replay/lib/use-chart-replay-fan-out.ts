import type {
  FluxionHost,
  LineLayerHandle,
  LineSample,
  ScatterLayerHandle,
} from "@heojeongbo/fluxion-render";
import { useEffect, useRef, useState } from "react";
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

/** One line/scatter series fed by the shared channel via its own `pick`. */
export interface ReplayFanOutLine<T> {
  /** Target layer id on the source's host. */
  layerId: string;
  /** Worker-side handle kind. Default `"line"`. */
  type?: "line" | "scatter";
  /**
   * Extract this line's y from a decoded frame. Return `null` (or a non-finite
   * number) to skip the frame for this line.
   */
  pick: (data: T) => number | null;
}

/** One fan-out target: a host plus the lines drawn on it. */
export interface ReplayFanOutSource<T> {
  /** Host from `<FluxionCanvas onReady={...}>`. `null` while mounting → skipped. */
  host: FluxionHost | null;
  lines: ReplayFanOutLine<T>[];
}

export interface UseChartReplayFanOutOptions<T> {
  /**
   * Player from `session.enterReplay()`. `null` puts the hook in idle mode —
   * nothing is fetched or pushed. Pass `isDvr ? player : null` to gate on DVR.
   */
  player: ReplayPlayer | null;
  /** The store backing `player`. Used for the windowed channel-scoped query. */
  store: ReplayStore | null;
  /** Shared channel queried once per hydrate and fanned across all lines. */
  channel: BaseChannel<T>;
  /**
   * Visible window in ms. On mount and on every `player.seek(t)`, the hook
   * queries `[t - windowMs, t]` ONCE and feeds the result to every line.
   */
  windowMs: number;
  /** Subtracted from every `t` before push (Float32 precision). Default `0`. */
  timeOrigin?: number;
  /**
   * Extra ms fetched + cached on BOTH sides of the visible window so a
   * subsequent seek within ±prefetchMarginMs is an instant cache hit (no IDB
   * round-trip / decode). Only the visible window `[t - windowMs, t]` is ever
   * rendered; the margin lives in the cache only. Default 3000.
   */
  prefetchMarginMs?: number;
  /**
   * Current fan-out targets. Read through a ref and called FRESH on each
   * hydrate/frame, so hosts that mount/unmount between pushes are picked up
   * without re-running the effect.
   */
  getSources: () => ReplayFanOutSource<T>[];
  /**
   * Dependency-injection seam keeping the library pool-agnostic. Return `false`
   * to skip a host that is disposed/stale — e.g. a `FluxionWorkerPool` consumer
   * passes `(h) => pool.hasHost(h.hostId)`. Default: always live.
   */
  isHostLive?: (host: FluxionHost) => boolean;
}

export interface UseChartReplayFanOutResult {
  /** True while a hydrate (single windowed query + fan-out push) is in flight. */
  isHydrating: boolean;
  /**
   * Frame count from the most recent hydrate's single query — the windowed query
   * plus its ±prefetchMarginMs margin (NOT lines × frames; the query is
   * channel+window only). `0` before the first hydrate.
   */
  hydratedCount: number;
}

/**
 * Fans ONE recorded channel out to MANY chart lines/cells. Runs a single
 * windowed `getFramesByChannel` per enter/seek and feeds N lines, each
 * extracting its own y via `pick` — so a "snapshot" channel that drives a grid
 * of cells decodes each payload once instead of N times (as N per-cell
 * `useChartReplay` calls would).
 *
 * Mirrors `useChartReplay`'s sequential-queue + microtask-yield hydrate machine,
 * but resolves a per-line `host.line(id)`/`host.scatter(id)` handle from a fresh
 * `getSources()` on each push. Pool-agnostic via the optional `isHostLive` seam.
 *
 * @example
 * useChartReplayFanOut<Snapshot>({
 *   player: isDvr ? dvr.player : null,
 *   store, channel: snapshotChannel, windowMs: 5_000, timeOrigin,
 *   getSources: () => cells.map((lines, i) => ({ host: hosts[i] ?? null, lines })),
 *   isHostLive: (h) => pool.hasHost(h.hostId),
 * });
 */
export function useChartReplayFanOut<T>(
  opts: UseChartReplayFanOutOptions<T>,
): UseChartReplayFanOutResult {
  const { player, store, channel, windowMs } = opts;
  const timeOrigin = opts.timeOrigin ?? 0;
  const marginMs = opts.prefetchMarginMs ?? DEFAULT_PREFETCH_MARGIN_MS;

  const [isHydrating, setIsHydrating] = useState(false);
  const [hydratedCount, setHydratedCount] = useState(0);

  // Mirror latest callbacks into refs so the effect closure doesn't go stale
  // when the parent re-renders with a new function reference. Only structural
  // deps (player, store, channel, windowMs, timeOrigin, marginMs) drive
  // re-subscription — callback identity changes are intentionally excluded.
  const getSourcesRef = useRef(opts.getSources);
  getSourcesRef.current = opts.getSources;
  const isHostLiveRef = useRef(opts.isHostLive);
  isHostLiveRef.current = opts.isHostLive;

  // Cache the last hydrate's query so same-window re-scrubs skip the IDB round
  // trip. The query is channel+window only (independent of lines), so it's
  // reusable across every fan-out target.

  // Live frames accumulated between ticks; each fans across N lines on drain.
  const liveBufferRef = useRef<ReplayPlayerFrame<T>[]>([]);

  // Validate up-front so a `[t - NaN, t]` query doesn't silently blank every
  // cell. Runs during render (mirrors useChartReplay).
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(
      `useChartReplayFanOut: windowMs must be a positive finite number (got ${String(windowMs)}). ` +
        "Match it to your axisGridLayer({ timeWindowMs }) value.",
    );
  }

  useEffect(() => {
    if (!player || !store) return;

    const isLive = (host: FluxionHost): boolean =>
      isHostLiveRef.current ? isHostLiveRef.current(host) : true;

    const resolveHandle = (
      host: FluxionHost,
      line: ReplayFanOutLine<T>,
    ): LineLayerHandle | ScatterLayerHandle =>
      (line.type ?? "line") === "scatter"
        ? host.scatter(line.layerId)
        : host.line(line.layerId);

    let cache: {
      from: number;
      to: number;
      frames: DecodedFrame<T>[];
      generation?: number;
    } | null = null;
    let cancelled = false;
    let inFlight = false;
    let queuedT: number | null = null;
    let hydratingT: number | null = null;
    const pending: ReplayPlayerFrame<T>[] = [];
    liveBufferRef.current = [];

    /** Push one decoded frame across every visible line. */
    const fanOut = (frame: ReplayPlayerFrame<T>): void => {
      const t = frame.t - timeOrigin;
      for (const src of getSourcesRef.current()) {
        const host = src.host;
        if (!host || !isLive(host)) continue;
        for (const line of src.lines) {
          const y = line.pick(frame.data);
          if (y === null || !Number.isFinite(y)) continue;
          resolveHandle(host, line).push({ t, y });
        }
      }
    };

    const flushPending = (cutoff: number): void => {
      if (pending.length === 0) return;
      const drained = pending.splice(0, pending.length);
      for (const f of drained) {
        if (f.t <= cutoff) continue; // backfill already covers this t
        fanOut(f);
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

          // Visible window actually drawn; the ±margin span is fetched + cached
          // (for instant re-seeks) but never pushed — each line filters to the
          // visible window below.
          const visibleFrom = t - windowMs;
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
            frames = cache.frames;
          } else {
            frames = await store.getFramesByChannel(channel, fetchFrom, fetchTo);
            if (cancelled || generation !== store.recordingGeneration) return;
            cache = { from: fetchFrom, to: fetchTo, frames, generation };
          }
          // Yield so a React cleanup that sets `cancelled` can land before we
          // touch the charts (defeats the stale-hydrate-wipes-live race).
          await Promise.resolve();
          if (cancelled) return;

          // Fan the single query out to every line: rewind each handle's axis
          // to the seek point, then push that line's picked batch.
          const latestT = t - timeOrigin;
          for (const src of getSourcesRef.current()) {
            const host = src.host;
            if (!host || !isLive(host)) continue;
            for (const line of src.lines) {
              const batch: LineSample[] = [];
              for (const f of frames) {
                if (f.t < visibleFrom || f.t > t) continue; // visible window only
                const y = line.pick(f.data);
                if (y === null || !Number.isFinite(y)) continue;
                batch.push({ t: f.t - timeOrigin, y });
              }
              const handle = resolveHandle(host, line);
              handle.reset(latestT);
              if (batch.length > 0) handle.pushBatch(batch);
            }
          }
          setHydratedCount(frames.length);

          flushPending(t);
          hydratingT = null;

          if (queuedT === null) break;
          t = queuedT;
          queuedT = null;
        }
      } catch (err) {
        // Surface IDB / decode errors — they would otherwise be silently
        // swallowed because runHydrate is called via `void`.
        console.error("[useChartReplayFanOut] hydrate failed:", err);
      } finally {
        inFlight = false;
        hydratingT = null;
        if (!cancelled) setIsHydrating(false);
      }
    };

    const hydrate = (t: number): void => {
      if (inFlight) {
        queuedT = t; // collapse intermediate seeks; last wins
        return;
      }
      void runHydrate(t);
    };

    hydrate(player.currentT);

    const offSeek = player.onSeek((t) => {
      hydrate(t);
    });

    const offFrame = player.onFrame<T>(channel, (frame) => {
      if (hydratingT !== null) {
        pending.push(frame);
        return;
      }
      liveBufferRef.current.push(frame);
    });

    // Drain buffered frames once per tick; each frame fans across N lines.
    const offTick = player.onTick(() => {
      const buf = liveBufferRef.current;
      if (buf.length === 0) return;
      const drained = buf.splice(0, buf.length);
      for (const f of drained) fanOut(f);
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
    // opts.isHostLive and opts.getSources are intentionally excluded: they are
    // mirrored into refs above and the effect reads them via those refs, so
    // function-reference churn on the parent does not tear down the subscription.
  }, [player, store, channel, windowMs, timeOrigin, marginMs]);

  return { isHydrating, hydratedCount };
}
