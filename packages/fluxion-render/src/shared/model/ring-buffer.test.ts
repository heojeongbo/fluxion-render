import { describe, expect, it } from "vitest";
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
  it("falls back correctly for unordered input and resets ordering on clear", () => {
    const ring = new RingBuffer(4, 2);
    ring.enableExtent();
    ring.push([10, 2]);
    ring.push([0, 1]);
    ring.push([20, 999]);
    expect(ring.extentMin(0, 10)).toBe(1);
    expect(ring.extentMax(0, 10)).toBe(2);
    ring.clear();
    ring.push([1, 5]);
    expect(ring.extentMax(0, 1)).toBe(5);
  });
});
