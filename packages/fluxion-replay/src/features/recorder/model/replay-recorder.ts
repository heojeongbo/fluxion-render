import type { BaseChannel } from "../../../shared/model/base-channel";
import type { SerializedFrame } from "../../../shared/model/frame";
import { GenericRingBuffer } from "../../../shared/model/generic-ring-buffer";
import type { FrameWriter } from "../../../shared/model/storage";
import { TimelineIndex } from "../../timeline/model/timeline-index";

/**
 * Thrown by `ReplayRecorder.record()` (and `ReplaySession.record()`) when
 * the supplied channelId wasn't registered in the session's `channels`
 * option. Catch this specific class to detect channel typos with
 * `instanceof` rather than parsing the message.
 *
 * ```ts
 * try {
 *   session.record("cpuu", { ... });   // typo
 * } catch (e) {
 *   if (e instanceof UnknownChannelError) {
 *     console.warn(`Channel "${e.channelId}" not registered`);
 *   } else throw e;
 * }
 * ```
 */
export class UnknownChannelError extends Error {
  readonly channelId: string;
  readonly availableChannelIds: readonly string[];

  constructor(channelId: string, availableChannelIds: readonly string[]) {
    super(
      `Unknown channel "${channelId}". Available channels: [${availableChannelIds.join(", ")}]`,
    );
    this.name = "UnknownChannelError";
    this.channelId = channelId;
    this.availableChannelIds = availableChannelIds;
  }
}

export interface ReplayRecorderOptions {
  channels: BaseChannel<unknown>[];
  store: FrameWriter;
  retentionMs?: number;
  memoryCapacity?: number;
  indexIntervalMs?: number;
}

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_MEMORY_CAPACITY = 50_000;
const DEFAULT_INDEX_INTERVAL_MS = 1_000;

export class ReplayRecorder {
  private readonly _channels = new Map<string, BaseChannel<unknown>>();
  private readonly _store: FrameWriter;
  private readonly _memoryBuffer: GenericRingBuffer<SerializedFrame>;
  private readonly _index: TimelineIndex;
  private readonly _retentionMs: number;
  private readonly _indexIntervalMs: number;
  private _lastIndexMs = -Infinity;
  private _recording = false;

  constructor(opts: ReplayRecorderOptions) {
    this._store = opts.store;
    this._retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this._indexIntervalMs = opts.indexIntervalMs ?? DEFAULT_INDEX_INTERVAL_MS;
    this._memoryBuffer = new GenericRingBuffer<SerializedFrame>(
      opts.memoryCapacity ?? DEFAULT_MEMORY_CAPACITY,
    );
    this._index = new TimelineIndex();

    for (const ch of opts.channels) {
      this._channels.set(ch.channelId, ch);
    }
  }

  start(): void {
    this._recording = true;
  }

  stop(): void {
    this._recording = false;
  }

  get isRecording(): boolean {
    return this._recording;
  }

  get index(): TimelineIndex {
    return this._index;
  }

  record<T>(channelId: string, data: T, timestamp?: number): void {
    if (!this._recording) return;

    const channel = this._channels.get(channelId) as BaseChannel<T> | undefined;
    if (!channel) {
      throw new UnknownChannelError(channelId, [...this._channels.keys()]);
    }

    const t = timestamp ?? Date.now();
    const payload = channel.encode(data);
    const frame: SerializedFrame = { t, channelId, payload };

    this._store.appendFrame(frame);
    this._memoryBuffer.push(frame);
    this._memoryBuffer.evictWhile((f) => f.t < t - this._retentionMs);

    if (t - this._lastIndexMs >= this._indexIntervalMs) {
      this._index.insert(t);
      this._lastIndexMs = t;
    }
    this._index.pruneBefore(Math.max(t - this._retentionMs, this._memoryBuffer.at(0)!.t));
  }

  /** Synchronous in-memory query. Fastest path for recent data. */
  getRecentFrames(channelId: string, fromMs: number, toMs: number): SerializedFrame[] {
    const result: SerializedFrame[] = [];
    this._memoryBuffer.forEach((f) => {
      if (f.channelId === channelId && f.t >= fromMs && f.t <= toMs) {
        result.push(f);
      }
    });
    return result;
  }

  clear(): void {
    this._memoryBuffer.clear();
    this._index.clear();
    this._lastIndexMs = -Infinity;
  }
}
