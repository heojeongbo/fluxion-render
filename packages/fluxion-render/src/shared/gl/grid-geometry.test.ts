import { describe, expect, it } from "vitest";
import { LineListBuilder, snapCenter } from "./grid-geometry";

describe("snapCenter", () => {
  it("mirrors the 2d stroke centering exactly (round + 0.5)", () => {
    expect(snapCenter(10)).toBe(10.5);
    expect(snapCenter(10.4)).toBe(10.5);
    expect(snapCenter(10.6)).toBe(11.5);
    expect(snapCenter(-0.4)).toBe(0.5);
  });
});

describe("LineListBuilder", () => {
  it("appends [x1,y1,x2,y2] segments as vertex pairs", () => {
    const b = new LineListBuilder();
    b.seg(1, 2, 3, 4);
    b.seg(5, 6, 7, 8);
    expect(b.count).toBe(4);
    expect(Array.from(b.verts.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("reset clears the count but keeps (and reuses) the backing store", () => {
    const b = new LineListBuilder();
    b.seg(1, 2, 3, 4);
    const backing = b.verts;
    b.reset();
    expect(b.count).toBe(0);
    b.seg(9, 9, 9, 9);
    expect(b.verts).toBe(backing);
    expect(Array.from(b.verts.subarray(0, 4))).toEqual([9, 9, 9, 9]);
  });

  it("doubles the backing store on demand without losing segments", () => {
    const b = new LineListBuilder();
    const initial = b.verts.length; // 64 floats = 16 segments
    for (let i = 0; i < 20; i++) b.seg(i, i, i + 1, i + 1);
    expect(b.count).toBe(40);
    expect(b.verts.length).toBeGreaterThan(initial);
    // Spot-check a pre-growth and a post-growth segment.
    expect(Array.from(b.verts.subarray(0, 4))).toEqual([0, 0, 1, 1]);
    expect(Array.from(b.verts.subarray(76, 80))).toEqual([19, 19, 20, 20]);
  });
});
