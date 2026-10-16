import { describe, expect, it } from "vitest";
import { HoverDataCache } from "./hover-data-cache";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeCache(capacity = 8) {
  const c = new HoverDataCache();
  c.registerLayer("a", { capacity, label: "Series A", color: "#f00" });
  return c;
}

function pushMany(cache: HoverDataCache, id: string, pairs: [number, number][]) {
  for (const [t, y] of pairs) cache.push(id, t, y);
}

// ─── registerLayer ──────────────────────────────────────────────────────────

describe("registerLayer", () => {
  it("registers a layer with defaults", () => {
    const c = new HoverDataCache();
    c.registerLayer("x");
    expect(c.getLayers()).toEqual([{ id: "x", label: "x", color: "#ffffff" }]);
  });

  it("uses provided label and color", () => {
    const c = new HoverDataCache();
    c.registerLayer("x", { label: "My Series", color: "#abc" });
    expect(c.getLayers()[0]).toMatchObject({ label: "My Series", color: "#abc" });
  });

  it("is idempotent — second registerLayer call is ignored", () => {
    const c = new HoverDataCache();
    c.registerLayer("x", { label: "first" });
    c.registerLayer("x", { label: "second" }); // should be ignored
    expect(c.getLayers()[0]!.label).toBe("first");
    expect(c.getLayers()).toHaveLength(1);
  });

  it("preserves insertion order in getLayers()", () => {
    const c = new HoverDataCache();
    c.registerLayer("b");
    c.registerLayer("a");
    c.registerLayer("c");
    expect(c.getLayers().map((l) => l.id)).toEqual(["b", "a", "c"]);
  });
});

// ─── push / findNearest ─────────────────────────────────────────────────────

describe("push + findNearest", () => {
  it("returns null when layer is empty", () => {
    const c = makeCache();
    expect(c.findNearest("a", 5, 0)).toBeNull();
  });

  it("returns null for unknown layer id", () => {
    const c = makeCache();
    c.push("a", 1, 10);
    expect(c.findNearest("unknown", 1, 0)).toBeNull();
  });

  it("push to an unregistered layer id is a silent no-op", () => {
    const c = makeCache();
    expect(() => c.push("unregistered", 5, 5)).not.toThrow();
    expect(c.getPoints("unregistered")).toEqual([]);
  });

  it("finds the single pushed point", () => {
    const c = makeCache();
    c.push("a", 10, 42);
    expect(c.findNearest("a", 10, 0)).toEqual({ t: 10, y: 42 });
  });

  it("finds nearest by smallest |t - targetT|", () => {
    const c = makeCache();
    pushMany(c, "a", [
      [10, 1],
      [20, 2],
      [30, 3],
      [40, 4],
    ]);
    expect(c.findNearest("a", 22, 0)).toEqual({ t: 20, y: 2 });
    expect(c.findNearest("a", 28, 0)).toEqual({ t: 30, y: 3 });
  });

  it("returns the exact match when it exists", () => {
    const c = makeCache();
    pushMany(c, "a", [
      [5, 99],
      [10, 100],
      [15, 101],
    ]);
    expect(c.findNearest("a", 10, 0)).toEqual({ t: 10, y: 100 });
  });

  it("skips points where t < xMin", () => {
    const c = makeCache();
    pushMany(c, "a", [
      [1, 10],
      [2, 20],
      [5, 50],
      [8, 80],
    ]);
    // xMin = 4 → skip t=1,2; nearest of {5,8} to targetT=6 is t=5
    expect(c.findNearest("a", 6, 4)).toEqual({ t: 5, y: 50 });
  });

  it("returns null when all points are before xMin", () => {
    const c = makeCache();
    pushMany(c, "a", [
      [1, 10],
      [2, 20],
    ]);
    expect(c.findNearest("a", 5, 10)).toBeNull();
  });
});

// ─── pushBatch ──────────────────────────────────────────────────────────────

describe("pushBatch", () => {
  it("pushes stride-2 Float32Array", () => {
    const c = makeCache();
    c.pushBatch("a", new Float32Array([1, 10, 2, 20, 3, 30]));
    expect(c.findNearest("a", 2, 0)).toEqual({ t: 2, y: 20 });
  });

  it("ignores trailing partial record (odd length)", () => {
    const c = makeCache();
    c.pushBatch("a", new Float32Array([1, 10, 2, 20, 3])); // last element ignored
    expect(c.findNearest("a", 3, 0)).toEqual({ t: 2, y: 20 }); // t=3 was not pushed
  });

  it("is a no-op for unknown layer id", () => {
    const c = makeCache();
    expect(() => c.pushBatch("unknown", new Float32Array([1, 2]))).not.toThrow();
  });
});

// ─── ring-wrap (capacity overflow) ──────────────────────────────────────────

describe("ring-wrap behavior", () => {
  it("evicts the oldest entry when capacity is exceeded", () => {
    const c = new HoverDataCache();
    c.registerLayer("a", { capacity: 3 });
    pushMany(c, "a", [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]); // wraps: evicts t=1
    // xMin=0 → all visible. Nearest to t=1 is now t=2 (t=1 was evicted)
    expect(c.findNearest("a", 1, 0)).toEqual({ t: 2, y: 2 });
  });

  it("handles large number of pushes correctly", () => {
    const c = new HoverDataCache();
    c.registerLayer("a", { capacity: 4 });
    for (let i = 0; i < 100; i++) c.push("a", i, i * 2);
    // Last 4 entries: t=96..99
    expect(c.findNearest("a", 97, 95)).toEqual({ t: 97, y: 194 });
  });
});

// ─── clear ──────────────────────────────────────────────────────────────────

describe("clear", () => {
  it("clears a specific layer", () => {
    const c = new HoverDataCache();
    c.registerLayer("a");
    c.registerLayer("b");
    c.push("a", 1, 10);
    c.push("b", 2, 20);
    c.clear("a");
    expect(c.findNearest("a", 1, 0)).toBeNull();
    expect(c.findNearest("b", 2, 0)).toEqual({ t: 2, y: 20 });
  });

  it("clears all layers when called without id", () => {
    const c = new HoverDataCache();
    c.registerLayer("a");
    c.registerLayer("b");
    c.push("a", 1, 10);
    c.push("b", 2, 20);
    c.clear();
    expect(c.findNearest("a", 1, 0)).toBeNull();
    expect(c.findNearest("b", 2, 0)).toBeNull();
  });

  it("is safe to call on empty layer", () => {
    const c = makeCache();
    expect(() => c.clear("a")).not.toThrow();
  });

  it("allows pushing new data after clear", () => {
    const c = makeCache();
    c.push("a", 1, 99);
    c.clear("a");
    c.push("a", 5, 42);
    expect(c.findNearest("a", 5, 0)).toEqual({ t: 5, y: 42 });
  });
});

// ─── getPoints ──────────────────────────────────────────────────────────────

describe("getPoints", () => {
  it("returns [] for an unknown layer", () => {
    const c = makeCache();
    expect(c.getPoints("nope")).toEqual([]);
  });

  it("returns [] for an empty layer", () => {
    const c = makeCache();
    expect(c.getPoints("a")).toEqual([]);
  });

  it("returns all retained points in chronological order", () => {
    const c = makeCache(8);
    pushMany(c, "a", [
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(c.getPoints("a")).toEqual([
      { t: 10, y: 1 },
      { t: 20, y: 2 },
      { t: 30, y: 3 },
    ]);
  });

  it("after ring wrap returns only the most recent `capacity` points, oldest→newest", () => {
    const c = makeCache(3);
    pushMany(c, "a", [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    expect(c.getPoints("a")).toEqual([
      { t: 3, y: 3 },
      { t: 4, y: 4 },
      { t: 5, y: 5 },
    ]);
  });
});

// ─── getLatestT ─────────────────────────────────────────────────────────────

describe("getLatestT", () => {
  it("returns 0 when no layers registered", () => {
    const c = new HoverDataCache();
    expect(c.getLatestT()).toBe(0);
  });

  it("returns 0 when all layers are empty", () => {
    const c = makeCache();
    expect(c.getLatestT()).toBe(0);
  });

  it("returns the t of the last pushed point", () => {
    const c = makeCache();
    pushMany(c, "a", [
      [1, 10],
      [5, 50],
      [3, 30],
    ]);
    // Last pushed is t=3 (not the max — it's insertion order)
    expect(c.getLatestT()).toBe(3);
  });

  it("returns the max across multiple layers", () => {
    const c = new HoverDataCache();
    c.registerLayer("a");
    c.registerLayer("b");
    c.push("a", 10, 1);
    c.push("b", 20, 2);
    expect(c.getLatestT()).toBe(20);
  });

  it("updates correctly after ring-wrap", () => {
    const c = new HoverDataCache();
    c.registerLayer("a", { capacity: 3 });
    pushMany(c, "a", [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    expect(c.getLatestT()).toBe(5);
  });

  it("returns 0 after clear", () => {
    const c = makeCache();
    c.push("a", 99, 1);
    c.clear("a");
    expect(c.getLatestT()).toBe(0);
  });
});

// ─── multiple layers ─────────────────────────────────────────────────────────

describe("multiple independent layers", () => {
  it("each layer maintains its own ring", () => {
    const c = new HoverDataCache();
    c.registerLayer("a");
    c.registerLayer("b");
    c.push("a", 1, 10);
    c.push("b", 2, 20);
    expect(c.findNearest("a", 2, 0)).toEqual({ t: 1, y: 10 });
    expect(c.findNearest("b", 1, 0)).toEqual({ t: 2, y: 20 });
  });
});

it("keeps the newest cross-layer time after overwrite and ignores clearing missing layers", () => {
  const cache = new HoverDataCache();
  cache.registerLayer("a", { capacity: 2 });
  cache.registerLayer("b");
  cache.pushBatch("a", new Float32Array([0, 0, 2, 2, 4, 4]));
  cache.push("b", 1, 1);
  cache.clear("missing");
  expect(cache.getLatestT()).toBe(4);
  expect(cache.findNearest("a", 0, 0)?.t).toBe(2);
});
