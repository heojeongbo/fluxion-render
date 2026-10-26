import type { BaseChannel } from "../../../shared/model/base-channel";
import type { ReplayStorage } from "../../../shared/model/storage";
import { ReplayPlayer } from "../../player/model/replay-player";
import { ReplayRecorder } from "../../recorder/model/replay-recorder";
import type { RecordingSegment } from "../../store/model/replay-store";
import {
  ReplayStore,
  type ReplayStoreOptions,
  type StorageInfo,
} from "../../store/model/replay-store";

export type ReplaySessionMode = "live" | "replay";

export interface ReplaySessionOptions<S extends ReplayStorage = ReplayStore> {
  channels: BaseChannel<unknown>[];
  /**
   * Optional store instance. It stays the caller's: `dispose()` leaves it open,
   * so one store can back successive sessions (StrictMode, remounts). Without
   * it the session creates a ReplayStore(storeOptions) and disposes it.
   */
  store?: S;
  /** In-memory history only. Set storeOptions.retentionMs for persisted retention. */
  retentionMs?: number;
  memoryCapacity?: number;
  indexIntervalMs?: number;
  storeOptions?: ReplayStoreOptions;
  /**
   * Storage usage percentage (0–100) at which old IDB frames are automatically
   * evicted after each flush. Set to 100 or above to disable. Default: 70.
   */
  evictThresholdPct?: number;
  /**
   * Interval in milliseconds at which current storage usage is logged to
   * `console.log`. Set to 0 to disable. Default: 0.
   */
  storageLogIntervalMs?: number;
}

export class ReplaySession<S extends ReplayStorage = ReplayStore> {
  private readonly _store: S;
  private readonly _ownsStore: boolean;
  private readonly _recorder: ReplayRecorder;
  private readonly _channelMap: Map<string, BaseChannel<unknown>>;
  private _player: ReplayPlayer | null = null;
  private _mode: ReplaySessionMode = "live";
  // Bumped at the start of every enterReplay() and by exitReplay()/dispose().
  // An enterReplay whose captured gen no longer matches after its awaits lost
  // a race to a newer call — it must not install its player or flip the mode
  // (last-to-CALL wins, not last-to-RESOLVE).
  private _opGen = 0;
  private _recordingGeneration = 0;

  constructor(opts: ReplaySessionOptions<S>) {
    this._ownsStore = opts.store === undefined;
    this._store = (opts.store ??
      new ReplayStore({
        evictThresholdPct: opts.evictThresholdPct,
        storageLogIntervalMs: opts.storageLogIntervalMs,
        ...opts.storeOptions,
      })) as S;

    this._channelMap = new Map(opts.channels.map((ch) => [ch.channelId, ch]));

    this._recorder = new ReplayRecorder({
      channels: opts.channels,
      store: this._store,
      retentionMs: opts.retentionMs,
      memoryCapacity: opts.memoryCapacity,
      indexIntervalMs: opts.indexIntervalMs,
    });
  }

  async open(): Promise<void> {
    await this._store.open();
  }

  async startRecording(): Promise<void> {
    if (this._recorder.isRecording) return;
    this._recordingGeneration++;
    this._store.startSegment();
    this._recorder.start();
  }

  stopRecording(): void {
    this._recordingGeneration++;
    this._store.endSegment();
    this._recorder.stop();
  }

  record<T>(channelId: string, data: T, timestamp?: number): void {
    this._recorder.record(channelId, data, timestamp);
  }

  async enterReplay(
    timestamp?: number,
    opts?: { timeRange?: { earliest: number; latest: number } },
  ): Promise<ReplayPlayer> {
    const gen = ++this._opGen;
    this._player?.dispose();

    // Pause quota eviction for the duration of replay: time-travel is read-only
    // review of recorded history, so it must not delete the frames the user is
    // seeking to. Set BEFORE flush() so the entry flush commits pending frames
    // without triggering an eviction pass that would advance `earliest` and
    // clamp this entry's seek forward. Resumed in exitReplay().
    this._store.setEvictionPaused(true);

    // Commit the recorder's pending batch before anyone reads the IDB time
    // range — otherwise the last ~500ms of frames (still in the in-memory
    // queue) are invisible to both `getTimeRange()` and the player's
    // prefetch, leaving a tail gap right where the user just entered.
    try {
      await this._store.flush();

      const idbRange = await this._store.getTimeRange();
      const fallback = idbRange ?? {
        earliest: Date.now() - 10 * 60 * 1000,
        latest: Date.now(),
      };

      let range: { earliest: number; latest: number };
      // Only honour caller-supplied bounds when they describe a real interval.
      // A zero-width or inverted range (e.g. a freshly-seeded liveTimeRange
      // before the first poll) collapses the player to its start point —
      // onEnd fires on the first tick. Fall back to the IDB range instead.
      if (opts?.timeRange && opts.timeRange.latest > opts.timeRange.earliest) {
        const clamped = idbRange
          ? {
              earliest: Math.max(opts.timeRange.earliest, idbRange.earliest),
              latest: Math.min(opts.timeRange.latest, idbRange.latest),
            }
          : opts.timeRange;
        // Belt-and-suspenders: if the intersection collapsed (caller's range
        // doesn't overlap what IDB actually has), fall back to IDB so the
        // player has something to play.
        range = clamped.latest > clamped.earliest ? clamped : fallback;
      } else {
        range = fallback;
      }

      const player = new ReplayPlayer({
        store: this._store,
        channels: this._channelMap,
        timeRange: range,
      });

      if (timestamp !== undefined) {
        player.seek(timestamp);
      }

      // A newer enterReplay()/exitReplay()/dispose() landed while we awaited.
      // Don't install this player or flip the mode — return it disposed so the
      // caller's own gen guard (e.g. useReplayDvr) can treat it uniformly
      // (its dispose() call on the returned player is idempotent).
      if (gen !== this._opGen) {
        player.dispose();
        return player;
      }

      this._player = player;
      this._mode = "replay";
      return player;
    } catch (error) {
      if (gen === this._opGen) {
        this._player = null;
        this._mode = "live";
        this._store.setEvictionPaused(false);
      }
      throw error;
    }
  }

  exitReplay(): void {
    this._opGen++; // invalidate in-flight enterReplay calls
    // Back to live → resume quota eviction (paused in enterReplay).
    this._store.setEvictionPaused(false);
    this._player?.dispose();
    this._player = null;
    this._mode = "live";
  }

  getSegments(): readonly RecordingSegment[] {
    return this._store.getSegments();
  }

  async getTimeRange(): Promise<{ earliest: number; latest: number } | null> {
    return this._store.getTimeRange();
  }

  getStorageInfo(): Promise<StorageInfo> {
    return this._store.getStorageInfo();
  }

  async clearRecording(): Promise<void> {
    const wasRecording = this._recorder.isRecording;
    const generation = this._recordingGeneration;
    this._recorder.stop();
    await this._store.clearAll();
    this._recorder.clear();
    if (wasRecording && generation === this._recordingGeneration) this._recorder.start();
  }

  get mode(): ReplaySessionMode {
    return this._mode;
  }

  get player(): ReplayPlayer | null {
    return this._player;
  }

  get store(): S {
    return this._store;
  }

  get recorder(): ReplayRecorder {
    return this._recorder;
  }

  dispose(): void {
    this._recordingGeneration++;
    this._opGen++; // an in-flight enterReplay must not resurrect a player
    this._player?.dispose();
    this._player = null;
    this._recorder.stop();
    if (this._ownsStore) this._store.dispose();
  }
}
