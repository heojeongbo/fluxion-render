import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowExtent } from "../lib/window-extent";
import { RingBuffer } from "./ring-buffer";

/** Deterministic LCG so a failing extent case is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("RingBuffer", () => {
  it("starts empty", () => {
    const rb = new RingBuffer(4, 1);
    expect(rb.length).toBe(0);
    const seen: number[] = [];
    rb.forEach((data, off) => seen.push(data[off]));
    expect(seen).toEqual([]);
  });

  it("push appends stride=1 records", () => {
    const rb = new RingBuffer(4, 1);
    rb.push([10]);
    rb.push([20]);
    rb.push([30]);
    expect(rb.length).toBe(3);
    const seen: number[] = [];
    rb.forEach((data, off) => seen.push(data[off]));
    expect(seen).toEqual([10, 20, 30]);
  });

  it("overflows: keeps most recent records in chronological order", () => {
    const rb = new RingBuffer(3, 1);
    for (let i = 1; i <= 7; i++) rb.push([i]);
    expect(rb.length).toBe(3);
    const seen: number[] = [];
    rb.forEach((data, off) => seen.push(data[off]));
    expect(seen).toEqual([5, 6, 7]);
  });

  it("pushMany with stride=2 stores records correctly", () => {
    const rb = new RingBuffer(3, 2);
    rb.pushMany(new Float32Array([1, 2, 3, 4, 5, 6]));
    expect(rb.length).toBe(3);
    const pairs: [number, number][] = [];
    rb.forEach((data, off) => pairs.push([data[off], data[off + 1]]));
    expect(pairs).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("pushMany then overflow preserves latest records", () => {
    const rb = new RingBuffer(2, 2);
    rb.pushMany(new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]));
    const pairs: [number, number][] = [];
    rb.forEach((data, off) => pairs.push([data[off], data[off + 1]]));
    expect(pairs).toEqual([
      [3, 3],
      [4, 4],
    ]);
  });

  it("forEach exposes the chronological index", () => {
    const rb = new RingBuffer(3, 1);
    rb.push([100]);
    rb.push([200]);
    const indices: number[] = [];
    rb.forEach((_d, _o, idx) => indices.push(idx));
    expect(indices).toEqual([0, 1]);
  });

  it("clear resets length and makes forEach a no-op", () => {
    const rb = new RingBuffer(3, 1);
    rb.push([1]);
    rb.push([2]);
    rb.clear();
    expect(rb.length).toBe(0);
    let calls = 0;
    rb.forEach(() => calls++);
    expect(calls).toBe(0);
  });
});

describe("RingBuffer sliding-window extent", () => {
  it("extentMin/Max are +/-Infinity until extent tracking is enabled", () => {
    const rb = new RingBuffer(4, 2);
    rb.push([0, 5]);
    expect(rb.extentMin(0)).toBe(Number.POSITIVE_INFINITY);
    expect(rb.extentMax(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("oldestValue is NaN when empty, else the oldest retained record's column", () => {
    const rb = new RingBuffer(3, 2);
    expect(rb.oldestValue(0)).toBeNaN();
    rb.push([10, 1]);
    rb.push([20, 2]);
    expect(rb.oldestValue(0)).toBe(10); // not full → oldest at index 0
    rb.push([30, 3]);
    rb.push([40, 4]); // overflow: 10 evicted, oldest is now 20 (at head)
    expect(rb.length).toBe(3);
    expect(rb.oldestValue(0)).toBe(20);
  });

  it("clear() resets the extent and it is reusable", () => {
    const rb = new RingBuffer(4, 2);
    rb.enableExtent(); // default value column = 1
    rb.push([0, 5]);
    rb.push([1, 9]);
    expect(rb.extentMin(0)).toBe(5);
    expect(rb.extentMax(0)).toBe(9);
    rb.clear();
    expect(rb.extentMin(0)).toBe(Number.POSITIVE_INFINITY);
    expect(rb.extentMax(0)).toBe(Number.NEGATIVE_INFINITY);
    rb.push([0, 3]);
    expect(rb.extentMin(0)).toBe(3);
    expect(rb.extentMax(0)).toBe(3);
  });

  it("matches brute-force min/max over retained, in-window samples (with eviction)", () => {
    const rand = lcg(0x5eed);
    for (let trial = 0; trial < 40; trial++) {
      const cap = 2 + Math.floor(rand() * 20);
      const rb = new RingBuffer(cap, 2);
      rb.enableExtent(1);
      const hist: { t: number; y: number }[] = [];
      let t = 0;
      // Exceed capacity so eviction (minSeq > 0) and both push paths are hit.
      const pushes = cap + 5 + Math.floor(rand() * 80);
      for (let i = 0; i < pushes; i++) {
        t += 1 + Math.floor(rand() * 4); // strictly increasing time
        const y = Math.floor(rand() * 200) - 100; // integers → exact in Float32
        if (i % 3 === 0) rb.push([t, y]);
        else rb.pushMany(new Float32Array([t, y]));
        hist.push({ t, y });

        const retained = hist.slice(Math.max(0, hist.length - cap));
        for (const xMin of [0, t - cap * 3, t - 1, t, t + 1]) {
          let mn = Number.POSITIVE_INFINITY;
          let mx = Number.NEGATIVE_INFINITY;
          for (const s of retained) {
            if (s.t < xMin) continue;
            if (s.y < mn) mn = s.y;
            if (s.y > mx) mx = s.y;
          }
          expect(rb.extentMin(xMin)).toBe(mn);
          expect(rb.extentMax(xMin)).toBe(mx);
        }
      }
    }
  });
});

describe("bounded time queries", () => {
  it("excludes future samples, supports reverse seeks, and scans only the visible tail", () => {
    const ring = new RingBuffer(10000, 2);
    ring.enableExtent();
    for (let t = 0; t < 10000; t++) ring.push([t, t]);
    expect(ring.extentMin(20, 30)).toBe(20);
    expect(ring.extentMax(20, 30)).toBe(30);
    expect(ring.extentMin(0, 10)).toBe(0);
    expect(ring.extentMax(0, 10)).toBe(10);
    let visited = 0;
    ring.forEachRange(9990, 9999, () => {
      visited++;
    });
    expect(visited).toBe(10);
    ring.push([10000, -3]);
    expect(ring.extentMin(9990, 10000)).toBe(-3);
  });
  it("falls back to the 1.7.0 extents for unordered input and resets ordering on clear", () => {
    const ring = new RingBuffer(4, 2);
    ring.enableExtent();
    ring.push([10, 2]);
    ring.push([0, 1]);
    ring.push([20, 999]);
    // Unordered: xMax is ignored, exactly like 1.7.0's extentMin/Max(xMin).
    expect(ring.extentMin(0, 10)).toBe(1);
    expect(ring.extentMax(0, 10)).toBe(999);
    ring.clear();
    ring.push([1, 5]);
    ring.push([2, 7]);
    // Ordered again after clear(): the bounded query excludes t=2.
    expect(ring.extentMax(0, 1)).toBe(5);
  });
});

describe("time-order tracking", () => {
  // A backward or non-finite t makes WindowExtent warn once; keep output clean.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function visit(
    ring: RingBuffer,
    xMin: number,
    xMax: number,
    rightNeighbor?: boolean,
  ): number[] {
    const seen: number[] = [];
    ring.forEachRange(xMin, xMax, (data, off) => seen.push(data[off]!), rightNeighbor);
    return seen;
  }

  it("recovers the indexed fast path once the order-breaking sample is evicted", () => {
    const ring = new RingBuffer(8, 2);
    ring.enableExtent();
    for (let t = 0; t < 8; t++) ring.push([t, t]);
    expect(ring.timeIndex(5)).toBe(5);
    ring.push([2.5, -100]); // backward step (seq 8)
    // Unordered while the glitch is retained: no binary search, full walks.
    expect(ring.timeIndex(5)).toBe(0);
    expect(ring.timeIndex(5, true)).toBe(ring.length);
    for (let t = 8; t < 15; t++) ring.push([t, t]);
    // The glitch is now the OLDEST retained sample — still unordered.
    expect(ring.timeIndex(10)).toBe(0);
    ring.push([15, 15]); // evicts it
    // Retained t = 8..15, sorted again: indexed bounds are back.
    expect(ring.timeIndex(10)).toBe(2);
    expect(ring.timeIndex(10, true)).toBe(3);
    expect(visit(ring, 9, 11, true)).toEqual([9, 10, 11, 12]);
    // Bounded extents use the visible window again (t=12..15 excluded) …
    expect(ring.extentMin(9, 11)).toBe(9);
    expect(ring.extentMax(9, 11)).toBe(11);
    // … and the sliding-window deques answer the open-ended query.
    expect(ring.extentMin(8)).toBe(8);
    expect(ring.extentMax(8)).toBe(15);
  });

  it("treats a non-finite t as order-breaking until it is evicted", () => {
    const ring = new RingBuffer(4, 2);
    ring.enableExtent();
    ring.push([0, 0]);
    ring.push([Number.NaN, 50]);
    ring.push([2, 2]);
    expect(ring.timeIndex(2)).toBe(0);
    ring.push([3, 3]);
    ring.push([4, 4]); // NaN now oldest retained
    expect(ring.timeIndex(4)).toBe(0);
    ring.push([5, 5]); // NaN evicted
    expect(ring.timeIndex(4)).toBe(2);
    expect(ring.extentMax(2, 4)).toBe(4);
  });

  it("clear() forgets a retained glitch immediately", () => {
    const ring = new RingBuffer(16, 2);
    ring.push([10, 0]);
    ring.push([5, 0]);
    expect(ring.timeIndex(7)).toBe(0);
    ring.clear();
    for (let t = 0; t < 4; t++) ring.push([t, 0]);
    expect(ring.timeIndex(2)).toBe(2);
  });

  it("an unordered right-neighbour walk visits every sample not left of xMin (1.7.0 draw set)", () => {
    const ring = new RingBuffer(16, 2);
    for (const t of [1, 0, 5, 10, 20, 30]) ring.push([t, 0]);
    // Ordered, this would stop after the right neighbour (20); unordered there is
    // no index bound, so — like 1.7.0's draw loop — everything past xMax is kept
    // and left to the canvas clip.
    expect(visit(ring, 0, 12, true)).toEqual([1, 0, 5, 10, 20, 30]);
    expect(visit(ring, 2, 12, true)).toEqual([5, 10, 20, 30]);
    // Without a right neighbour the [xMin, xMax] filter still applies.
    expect(visit(ring, 0, 12)).toEqual([1, 0, 5, 10]);
    expect(visit(ring, 2, 12)).toEqual([5, 10]);
  });

  it("matches 1.7.0's deque extents while a glitch is retained, and exact window extents once ordered", () => {
    const rand = lcg(0x0bad5eed);
    for (let trial = 0; trial < 40; trial++) {
      const cap = 3 + Math.floor(rand() * 14);
      const ring = new RingBuffer(cap, 2);
      ring.enableExtent(1);
      // 1.7.0's RingBuffer.extentMin/Max(xMin) was exactly this deque query.
      const ref = new WindowExtent();
      const hist: { t: number; y: number; breaks: boolean }[] = [];
      let t = 0;
      let prevT = Number.NEGATIVE_INFINITY;
      for (let seq = 0; seq < cap * 5; seq++) {
        t += rand() < 0.15 ? -1 - Math.floor(rand() * 6) : Math.floor(rand() * 4);
        const y = Math.floor(rand() * 200) - 100;
        if (seq % 2 === 0) ring.push([t, y]);
        else ring.pushMany(new Float32Array([t, y]));
        const minSeq = Math.max(0, seq + 1 - cap);
        ref.push(seq, t, y, minSeq);
        hist.push({ t, y, breaks: t < prevT });
        prevT = t;

        const retained = hist.slice(Math.max(0, hist.length - cap));
        const unordered = retained.some((s) => s.breaks);
        for (const [xMin, xMax] of [
          [t - 6, t - 2],
          [t - 3, t],
          [t - 40, t + 5],
        ] as const) {
          if (unordered) {
            expect(ring.extentMin(xMin, xMax)).toBe(ref.queryMin(minSeq, xMin));
            expect(ring.extentMax(xMin, xMax)).toBe(ref.queryMax(minSeq, xMin));
          } else {
            let mn = Number.POSITIVE_INFINITY;
            let mx = Number.NEGATIVE_INFINITY;
            for (const s of retained) {
              if (s.t < xMin || s.t > xMax) continue;
              if (s.y < mn) mn = s.y;
              if (s.y > mx) mx = s.y;
            }
            expect(ring.extentMin(xMin, xMax)).toBe(mn);
            expect(ring.extentMax(xMin, xMax)).toBe(mx);
          }
        }
      }
    }
  });
});
