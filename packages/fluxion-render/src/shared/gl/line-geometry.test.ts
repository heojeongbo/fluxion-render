import { describe, expect, it } from "vitest";
import { RingBuffer } from "../model/ring-buffer";
import { buildLineVertices } from "./line-geometry";

function ringOf(capacity: number, samples: Array<[number, number]>): RingBuffer {
  const ring = new RingBuffer(capacity, 2);
  for (const s of samples) ring.push(s);
  return ring;
}

function scratchFor(ring: RingBuffer): Float32Array {
  return new Float32Array(ring.capacity * 2);
}

describe("buildLineVertices", () => {
  it("copies visible samples chronologically as raw [t, y] pairs", () => {
    const ring = ringOf(8, [
      [0, 1],
      [100, 2],
      [200, 3],
    ]);
    const out = scratchFor(ring);
    const breaks: number[] = [];
    const n = buildLineVertices(ring, 0, undefined, out, breaks);
    expect(n).toBe(3);
    expect(Array.from(out.subarray(0, 6))).toEqual([0, 1, 100, 2, 200, 3]);
    expect(breaks).toEqual([]);
  });

  it("filters samples left of xMin", () => {
    const ring = ringOf(8, [
      [0, 1],
      [100, 2],
      [200, 3],
      [300, 4],
    ]);
    const out = scratchFor(ring);
    const breaks: number[] = [];
    const n = buildLineVertices(ring, 150, undefined, out, breaks);
    expect(n).toBe(2);
    expect(Array.from(out.subarray(0, 4))).toEqual([200, 3, 300, 4]);
  });

  it("records strip breaks at gaps larger than maxGapMs", () => {
    const ring = ringOf(8, [
      [0, 1],
      [100, 2],
      [500, 3], // 400ms gap → break starts here (index 2)
      [600, 4],
      [2000, 5], // 1400ms gap → break at index 4
    ]);
    const out = scratchFor(ring);
    const breaks: number[] = [];
    const n = buildLineVertices(ring, 0, 250, out, breaks);
    expect(n).toBe(5);
    expect(breaks).toEqual([2, 4]);
  });

  it("does not emit a leading break when filtered samples precede a gap", () => {
    const ring = ringOf(8, [
      [0, 1],
      [1000, 2], // huge gap, but [0,1] is filtered → strip STARTS at 1000
      [1100, 3],
    ]);
    const out = scratchFor(ring);
    const breaks: number[] = [];
    const n = buildLineVertices(ring, 500, 100, out, breaks);
    expect(n).toBe(2);
    expect(breaks).toEqual([]);
  });

  it("clears stale break indices from a previous fill", () => {
    const ring = ringOf(8, [
      [0, 1],
      [100, 2],
    ]);
    const out = scratchFor(ring);
    const breaks = [7, 9]; // leftovers from an earlier frame
    buildLineVertices(ring, 0, undefined, out, breaks);
    expect(breaks).toEqual([]);
  });

  it("walks a wrapped ring oldest→newest via ring.start", () => {
    // capacity 4, 6 pushes → the ring holds [200..500] with head mid-buffer.
    const ring = ringOf(4, [
      [0, 0],
      [100, 1],
      [200, 2],
      [300, 3],
      [400, 4],
      [500, 5],
    ]);
    const out = scratchFor(ring);
    const breaks: number[] = [];
    const n = buildLineVertices(ring, 0, undefined, out, breaks);
    expect(n).toBe(4);
    expect(Array.from(out.subarray(0, 8))).toEqual([200, 2, 300, 3, 400, 4, 500, 5]);
  });
});

describe("RingBuffer.start", () => {
  it("is 0 while the ring has not wrapped", () => {
    const ring = ringOf(4, [
      [0, 0],
      [100, 1],
    ]);
    expect(ring.start).toBe(0);
  });

  it("is the oldest slot index once the ring is full", () => {
    const ring = ringOf(3, [
      [0, 0],
      [100, 1],
      [200, 2],
      [300, 3], // overwrote slot 0 → oldest now at slot 1
    ]);
    expect(ring.start).toBe(1);
    expect(ring.data[ring.start * ring.stride]).toBe(100);
  });

  it("matches forEach's chronological order exactly", () => {
    const ring = new RingBuffer(5, 2);
    for (let i = 0; i < 13; i++) ring.push([i * 10, i]);
    const viaForEach: number[] = [];
    ring.forEach((data, off) => viaForEach.push(data[off]!));
    const viaStart: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      viaStart.push(ring.data[((ring.start + i) % ring.capacity) * ring.stride]!);
    }
    expect(viaStart).toEqual(viaForEach);
  });
});
