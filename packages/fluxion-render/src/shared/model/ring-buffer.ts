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
  private ordered = true;
  private lastT = -Infinity;
  private revision = 0;
  private rangeCache = {
    revision: -1,
    xMin: NaN,
    xMax: NaN,
    min: Infinity,
    max: -Infinity,
  };

  /** Changes whenever data is added or cleared; useful for derived-data caches. */
  get version(): number {
    return this.revision;
  }

  /** First chronological index >= t (or > t for upper). Unordered data falls back to a full scan. */
  timeIndex(t: number, upper = false): number {
    if (!this.ordered) return upper ? this.count : 0;
    let lo = 0,
      hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const value = this.data[((this.start + mid) % this.capacity) * this.stride]!;
      if (upper ? value <= t : value < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Iterate a time window without walking old retained history. */
  forEachRange(
    xMin: number,
    xMax: number,
    fn: (data: Float32Array, offset: number, index: number) => void,
    rightNeighbor = false,
  ): void {
    const from = this.timeIndex(xMin);
    const end = Math.min(
      this.count,
      this.timeIndex(xMax, true) + (rightNeighbor ? 1 : 0),
    );
    for (let i = from; i < end; i++) {
      const off = ((this.start + i) % this.capacity) * this.stride;
      const t = this.data[off]!;
      if (this.ordered || (t >= xMin && t <= xMax)) fn(this.data, off, i);
    }
  }

  private queryRange(xMin: number, xMax: number): typeof this.rangeCache {
    const c = this.rangeCache;
    if (c.revision === this.revision && c.xMin === xMin && c.xMax === xMax) return c;
    c.revision = this.revision;
    c.xMin = xMin;
    c.xMax = xMax;
    c.min = Infinity;
    c.max = -Infinity;
    this.forEachRange(xMin, xMax, (data, off) => {
      const value = data[off + this.extentCol]!;
      if (value < c.min) c.min = value;
      if (value > c.max) c.max = value;
    });
    return c;
  }

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
    const t = this.data[base]!;
    if (!Number.isFinite(t) || t < this.lastT) this.ordered = false;
    this.lastT = t;
    this.revision++;
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
    // The retained records are at most two contiguous physical runs
    // ([start, capacity) then [0, head)), so walk each with a plain incrementing
    // offset — no per-element `% capacity` (this runs once per sample per 2d
    // streaming draw/scan). Order and callback shape are identical to before.
    const { count, capacity, stride, data } = this;
    const start = count < capacity ? 0 : this.head;
    const firstLen = Math.min(count, capacity - start);
    let index = 0;
    for (
      let off = start * stride, end = (start + firstLen) * stride;
      off < end;
      off += stride
    ) {
      fn(data, off, index++);
    }
    for (let off = 0, end = (count - firstLen) * stride; off < end; off += stride) {
      fn(data, off, index++);
    }
  }

  /**
   * Min of the tracked value column over retained records whose `t` (column 0)
   * is >= `xMin`. `+Infinity` when none (or extent tracking is off).
   * Requires {@link enableExtent}.
   */
  extentMin(xMin: number, xMax = Infinity): number {
    if (!this.extent) return Number.POSITIVE_INFINITY;
    if (!this.ordered || xMax < this.lastT) return this.queryRange(xMin, xMax).min;
    const minSeq = this.totalPushed - this.capacity;
    return this.extent.queryMin(minSeq > 0 ? minSeq : 0, xMin);
  }

  /** Max counterpart of {@link extentMin}; `-Infinity` when none. */
  extentMax(xMin: number, xMax = Infinity): number {
    if (!this.extent) return Number.NEGATIVE_INFINITY;
    if (!this.ordered || xMax < this.lastT) return this.queryRange(xMin, xMax).max;
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
    this.ordered = true;
    this.lastT = -Infinity;
    this.revision++;
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
