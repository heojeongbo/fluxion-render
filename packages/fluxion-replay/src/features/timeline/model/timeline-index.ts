export class TimelineIndex {
  private _entries: number[] = [];

  get earliest(): number | null {
    return this._entries.length > 0 ? this._entries[0] : null;
  }

  get latest(): number | null {
    return this._entries.length > 0 ? this._entries[this._entries.length - 1] : null;
  }

  insert(t: number): void {
    const i = this._lowerBound(t);
    if (this._entries[i] !== t) {
      this._entries.splice(i, 0, t);
    }
  }

  insertMany(timestamps: number[]): void {
    for (const t of timestamps) {
      this.insert(t);
    }
  }

  /** Returns the largest t <= target, or null if none. */
  floor(target: number): number | null {
    let lo = 0;
    let hi = this._entries.length - 1;
    let result: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this._entries[mid] <= target) {
        result = this._entries[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  /** Returns the smallest t >= target, or null if none. */
  ceiling(target: number): number | null {
    const i = this._lowerBound(target);
    return i < this._entries.length ? this._entries[i] : null;
  }

  /** Returns all t in [from, to] inclusive. */
  range(from: number, to: number): number[] {
    const lo = this._lowerBound(from);
    const result: number[] = [];
    for (let i = lo; i < this._entries.length && this._entries[i] <= to; i++) {
      result.push(this._entries[i]);
    }
    return result;
  }

  /** Drop index entries outside the retained in-memory history. */
  pruneBefore(t: number): void {
    this._entries.splice(0, this._lowerBound(t));
  }

  clear(): void {
    this._entries = [];
  }

  private _lowerBound(target: number): number {
    let lo = 0;
    let hi = this._entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._entries[mid] < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}
