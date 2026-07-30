import { WindowExtent } from "../lib/window-extent";

/**
 * Fixed-capacity ring buffer over a Float32Array.
 * Stores interleaved records of `stride` floats each (e.g. [x,y] stride=2).
 * Zero-allocation push; draw iterates from tail to head in chronological order.
 *
 * Optionally tracks the sliding-window min/max of one value column
 * ({@link enableExtent}) so streaming layers can read their visible-window
 * y-extent in O(log n) ({@link extentMin}/{@link extentMax}) instead of
 * rescanning the whole ring every frame.
 */
export class RingBuffer {
  readonly stride: number;
  readonly capacity: number;
  readonly data: Float32Array;
  private head = 0;
  private count = 0;
  // Sliding-window extent of `extentCol`, opt-in via enableExtent. `totalPushed`
  // is the monotonic lifetime push count, used as each sample's sequence number
  // and to derive the oldest still-retained sequence (totalPushed - capacity).
  private extent: WindowExtent | null = null;
  private extentCol = 1;
  private totalPushed = 0;

  constructor(capacity: number, stride: number) {
    this.capacity = capacity;
    this.stride = stride;
    this.data = new Float32Array(capacity * stride);
  }

  /**
   * Start tracking the sliding-window min/max of column `valueCol` (record[0]
   * is always treated as the time `t`). Enables {@link extentMin}/{@link extentMax}.
   */
  enableExtent(valueCol = 1): void {
    this.extent = new WindowExtent();
    this.extentCol = valueCol;
  }

  get length(): number {
    return this.count;
  }

  /**
   * Chronological start slot: iterate `(start + i) % capacity` for
   * `i < length` to walk records oldest→newest without the per-record
   * closure cost of {@link forEach} (used by the WebGL vertex fill).
   */
  get start(): number {
    return this.count < this.capacity ? 0 : this.head;
  }

  private feedExtent(base: number): void {
    const ext = this.extent;
    if (!ext) return;
    const seq = this.totalPushed;
    const minSeq = seq + 1 - this.capacity;
    ext.push(
      seq,
      this.data[base]!,
      this.data[base + this.extentCol]!,
      minSeq > 0 ? minSeq : 0,
    );
  }

  push(record: ArrayLike<number>): void {
    const base = this.head * this.stride;
    for (let i = 0; i < this.stride; i++) {
      this.data[base + i] = record[i]!;
    }
    this.feedExtent(base);
    this.totalPushed++;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  pushMany(records: Float32Array): void {
    const recCount = records.length / this.stride;
    for (let r = 0; r < recCount; r++) {
      const base = this.head * this.stride;
      const src = r * this.stride;
      for (let i = 0; i < this.stride; i++) {
        this.data[base + i] = records[src + i]!;
      }
      this.feedExtent(base);
      this.totalPushed++;
      this.head = (this.head + 1) % this.capacity;
      if (this.count < this.capacity) this.count++;
    }
  }

  forEach(fn: (data: Float32Array, offset: number, index: number) => void): void {
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const slot = (start + i) % this.capacity;
      fn(this.data, slot * this.stride, i);
    }
  }

  /**
   * Min of the tracked value column over retained records whose `t` (column 0)
   * is >= `xMin`. `+Infinity` when none (or extent tracking is off).
   * Requires {@link enableExtent}.
   */
  extentMin(xMin: number): number {
    if (!this.extent) return Number.POSITIVE_INFINITY;
    const minSeq = this.totalPushed - this.capacity;
    return this.extent.queryMin(minSeq > 0 ? minSeq : 0, xMin);
  }

  /** Max counterpart of {@link extentMin}; `-Infinity` when none. */
  extentMax(xMin: number): number {
    if (!this.extent) return Number.NEGATIVE_INFINITY;
    const minSeq = this.totalPushed - this.capacity;
    return this.extent.queryMax(minSeq > 0 ? minSeq : 0, xMin);
  }

  /** Value of `col` in the oldest retained record, or `NaN` when empty. */
  oldestValue(col: number): number {
    if (this.count === 0) return Number.NaN;
    const start = this.count < this.capacity ? 0 : this.head;
    return this.data[start * this.stride + col]!;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.totalPushed = 0;
    this.extent?.clear();
  }
}

/**
 * Create a stride-2 `[t, y]` ring that tracks the sliding-window y-extent of the
 * value column — the standard setup for a streaming time-series layer, so
 * `scan()` reads the visible-window min/max in O(log n). See {@link RingBuffer.enableExtent}.
 */
export function createStreamingRing(capacity: number): RingBuffer {
  const ring = new RingBuffer(capacity, 2);
  ring.enableExtent(1);
  return ring;
}
