import { describe, expect, it } from "vitest";
import { createFakeCtx, type FakeCtx } from "../../test/setup";
import {
  drawLabel,
  LABEL_PAD,
  type LabelOpts,
  labelBlitPos,
  labelMetaOf,
  labelOf,
  MAX_LABELS_PER_STYLE,
  MAX_STYLE_BUCKETS,
  resetLabelCache,
  spriteFor,
} from "./label-cache";

// Deterministic sprite geometry under the test stubs (measureText width = 50):
// "10px sans-serif" → fontPx 10, extra 3, boxH 14 → cssH 22, cssW 52;
// anchors: top 4, middle 11, bottom 18.
const BASE: LabelOpts = {
  font: "10px sans-serif",
  color: "#fff",
  align: "left",
  baseline: "top",
  dpr: 1,
};

function ctx2d(): OffscreenCanvasRenderingContext2D {
  return createFakeCtx() as unknown as OffscreenCanvasRenderingContext2D;
}

function drawImages(ctx: FakeCtx) {
  return ctx.calls.filter((c) => c.name === "drawImage");
}

/** Wrap the global OffscreenCanvas stub with a construction counter. */
function withCtorCounter<T>(fn: (count: () => number) => T): T {
  const Real = (globalThis as { OffscreenCanvas: new (w: number, h: number) => object })
    .OffscreenCanvas;
  let ctors = 0;
  (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = class extends Real {
    constructor(w: number, h: number) {
      super(w, h);
      ctors++;
    }
  };
  try {
    return fn(() => ctors);
  } finally {
    (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = Real;
  }
}

describe("label-cache", () => {
  it("left/top: exact blit geometry and a correctly rasterized sprite", () => {
    const ctx = ctx2d();
    drawLabel(ctx, "A", 10, 20, BASE);

    const calls = drawImages(ctx as unknown as FakeCtx);
    expect(calls).toHaveLength(1);
    const [canvas, dx, dy, dw, dh] = calls[0]!.args as [
      { getContext(): FakeCtx },
      number,
      number,
      number,
      number,
    ];
    expect(dx).toBe(10 - LABEL_PAD); // left align: x - PAD
    expect(dy).toBe(20 - 4); // top anchor 4
    expect(dw).toBe(52);
    expect(dh).toBe(22);
    expect(labelOf(canvas)).toBe("A");
    expect(labelMetaOf(canvas)).toEqual({ text: "A", yAnchor: 4 });

    // The sprite itself was rasterized with the requested style + baseline.
    const sctx = canvas.getContext();
    expect(sctx.font).toBe("10px sans-serif");
    expect(sctx.fillStyle).toBe("#fff");
    expect(sctx.textAlign).toBe("left");
    expect(sctx.textBaseline).toBe("top");
    expect(sctx.calls.some((c) => c.name === "setTransform" && c.args[0] === 1)).toBe(
      true,
    );
    expect(
      sctx.calls.some(
        (c) => c.name === "fillText" && c.args[0] === "A" && c.args[2] === 4,
      ),
    ).toBe(true);
    // No fillText on the TARGET ctx — the sprite path replaces it.
    expect((ctx as unknown as FakeCtx).calls.some((c) => c.name === "fillText")).toBe(
      false,
    );
  });

  it("center and right alignment offset by the measured width", () => {
    const ctx = ctx2d();
    drawLabel(ctx, "C", 100, 20, { ...BASE, align: "center" });
    drawLabel(ctx, "R", 100, 20, { ...BASE, align: "right" });
    const [center, right] = drawImages(ctx as unknown as FakeCtx);
    expect(center!.args[1]).toBe(100 - LABEL_PAD - 25); // textW 50 / 2
    expect(right!.args[1]).toBe(100 - LABEL_PAD - 50);
  });

  it("middle and bottom baselines anchor exactly", () => {
    const ctx = ctx2d();
    drawLabel(ctx, "M", 10, 20, { ...BASE, baseline: "middle" });
    drawLabel(ctx, "B", 10, 20, { ...BASE, baseline: "bottom" });
    const [middle, bottom] = drawImages(ctx as unknown as FakeCtx);
    expect(middle!.args[2]).toBe(20 - 11); // cssH 22 / 2
    expect(bottom!.args[2]).toBe(20 - 18); // cssH - PAD - extra

    const mMeta = labelMetaOf(middle!.args[0] as object)!;
    const bMeta = labelMetaOf(bottom!.args[0] as object)!;
    expect(mMeta.yAnchor).toBe(11);
    expect(bMeta.yAnchor).toBe(18);
  });

  it("caches per text: identical calls construct ONE sprite", () => {
    withCtorCounter((count) => {
      const ctx = ctx2d();
      drawLabel(ctx, "hit", 10, 20, BASE);
      drawLabel(ctx, "hit", 30, 40, BASE);
      expect(count()).toBe(1);
      const calls = drawImages(ctx as unknown as FakeCtx);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0]).toBe(calls[1]!.args[0]); // same sprite canvas
    });
  });

  it("font, color, dpr, and baseline each key a distinct sprite", () => {
    withCtorCounter((count) => {
      const ctx = ctx2d();
      drawLabel(ctx, "k", 0, 0, BASE);
      drawLabel(ctx, "k", 0, 0, { ...BASE, font: "11px sans-serif" });
      drawLabel(ctx, "k", 0, 0, { ...BASE, color: "#666" });
      drawLabel(ctx, "k", 0, 0, { ...BASE, dpr: 2 });
      drawLabel(ctx, "k", 0, 0, { ...BASE, baseline: "middle" });
      expect(count()).toBe(5);
    });
  });

  it("per-style LRU evicts the oldest label at the cap", () => {
    withCtorCounter((count) => {
      const ctx = ctx2d();
      for (let i = 0; i < MAX_LABELS_PER_STYLE; i++) {
        drawLabel(ctx, `t${i}`, 0, 0, BASE);
      }
      expect(count()).toBe(MAX_LABELS_PER_STYLE);
      drawLabel(ctx, "overflow", 0, 0, BASE); // evicts t0
      drawLabel(ctx, "t0", 0, 0, BASE); // re-rasterized
      expect(count()).toBe(MAX_LABELS_PER_STYLE + 2);
    });
  });

  it("a cache hit refreshes recency (LRU re-insert)", () => {
    withCtorCounter((count) => {
      const ctx = ctx2d();
      for (let i = 0; i < MAX_LABELS_PER_STYLE; i++) {
        drawLabel(ctx, `t${i}`, 0, 0, BASE);
      }
      drawLabel(ctx, "t0", 0, 0, BASE); // refresh t0 → oldest is now t1
      drawLabel(ctx, "overflow", 0, 0, BASE); // evicts t1, NOT t0
      const before = count();
      drawLabel(ctx, "t0", 0, 0, BASE); // still cached
      expect(count()).toBe(before);
      drawLabel(ctx, "t1", 0, 0, BASE); // evicted → re-rasterized
      expect(count()).toBe(before + 1);
    });
  });

  it("style-bucket LRU evicts the oldest style wholesale at the cap", () => {
    withCtorCounter((count) => {
      const ctx = ctx2d();
      for (let i = 0; i < MAX_STYLE_BUCKETS; i++) {
        drawLabel(ctx, "s", 0, 0, { ...BASE, color: `#c${i}` });
      }
      drawLabel(ctx, "s", 0, 0, { ...BASE, color: "#new" }); // evicts #c0's bucket
      const before = count();
      drawLabel(ctx, "s", 0, 0, { ...BASE, color: "#c0" }); // re-rasterized
      expect(count()).toBe(before + 1);
    });
  });

  it("falls back to verbatim fillText when OffscreenCanvas is missing, and latches", () => {
    const saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    try {
      const ctx = ctx2d();
      drawLabel(ctx, "F", 10, 20, BASE);
      const fake = ctx as unknown as FakeCtx;
      expect(
        fake.calls.some(
          (c) =>
            c.name === "fillText" &&
            c.args[0] === "F" &&
            c.args[1] === 10 &&
            c.args[2] === 20,
        ),
      ).toBe(true);
      expect(drawImages(fake)).toHaveLength(0);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
    }

    // Latched: sprites stay off even after the global returns...
    const ctx2 = ctx2d();
    drawLabel(ctx2, "F2", 1, 2, BASE);
    expect(drawImages(ctx2 as unknown as FakeCtx)).toHaveLength(0);
    expect((ctx2 as unknown as FakeCtx).calls.some((c) => c.name === "fillText")).toBe(
      true,
    );

    // ...until an explicit reset re-arms the sprite path.
    resetLabelCache();
    const ctx3 = ctx2d();
    drawLabel(ctx3, "F3", 1, 2, BASE);
    expect(drawImages(ctx3 as unknown as FakeCtx)).toHaveLength(1);
  });

  it("falls back when getContext returns null", () => {
    const saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
      getContext(): null {
        return null;
      }
    };
    try {
      const ctx = ctx2d();
      drawLabel(ctx, "N", 5, 6, BASE);
      const fake = ctx as unknown as FakeCtx;
      expect(fake.calls.some((c) => c.name === "fillText")).toBe(true);
      expect(drawImages(fake)).toHaveLength(0);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
      resetLabelCache();
    }
  });

  it("falls back when the constructor throws", () => {
    const saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
      constructor() {
        throw new Error("no canvas");
      }
    };
    try {
      const ctx = ctx2d();
      drawLabel(ctx, "T", 5, 6, BASE);
      const fake = ctx as unknown as FakeCtx;
      expect(fake.calls.some((c) => c.name === "fillText")).toBe(true);
      expect(drawImages(fake)).toHaveLength(0);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
      resetLabelCache();
    }
  });

  it("parses fontPx from the shorthand and defaults to 11 without a px size", () => {
    const ctx = ctx2d();
    // "bold 12.5px Arial": extra 4, boxH 18 → cssH 28.
    drawLabel(ctx, "p", 0, 0, { ...BASE, font: "bold 12.5px Arial" });
    // "monospace" (no px): defaults 11 → extra 3, boxH 16 → cssH 24.
    drawLabel(ctx, "p", 0, 0, { ...BASE, font: "monospace" });
    const [a, b] = drawImages(ctx as unknown as FakeCtx);
    expect(a!.args[4]).toBe(28);
    expect(b!.args[4]).toBe(24);
  });

  it("bumps an odd em box to even so the middle anchor is integral", () => {
    const ctx = ctx2d();
    // fontPx 10.5 → boxH ceil(14.7)=15 → bumped 16; extra 3 → cssH 24.
    drawLabel(ctx, "e", 0, 20, {
      ...BASE,
      font: "10.5px sans-serif",
      baseline: "middle",
    });
    const [call] = drawImages(ctx as unknown as FakeCtx);
    expect(call!.args[4]).toBe(24);
    expect(call!.args[2]).toBe(20 - 12); // integral middle anchor
  });

  it("snaps blit coords to the device grid (dpr 2) and guards dpr <= 0", () => {
    const ctx = ctx2d();
    drawLabel(ctx, "s", 10.3, 20, { ...BASE, dpr: 2 });
    const [snap] = drawImages(ctx as unknown as FakeCtx);
    expect(snap!.args[1]).toBe(Math.round((10.3 - LABEL_PAD) * 2) / 2); // 9.5
    expect(snap!.args[2]).toBe(16); // (20 - 4) already on the grid

    drawLabel(ctx, "z", 10, 20, { ...BASE, dpr: 0 }); // treated as dpr 1
    const calls = drawImages(ctx as unknown as FakeCtx);
    expect(calls[1]!.args[1]).toBe(10 - LABEL_PAD);
  });

  it("labelOf/labelMetaOf return undefined for foreign canvases", () => {
    expect(labelOf({})).toBeUndefined();
    expect(labelMetaOf({})).toBeUndefined();
  });

  it("resetLabelCache drops sprites (fresh canvas after reset)", () => {
    const ctx = ctx2d();
    drawLabel(ctx, "r", 0, 0, BASE);
    resetLabelCache();
    drawLabel(ctx, "r", 0, 0, BASE);
    const [a, b] = drawImages(ctx as unknown as FakeCtx);
    expect(a!.args[0]).not.toBe(b!.args[0]);
  });
});

describe("spriteFor / labelBlitPos (GL texture path)", () => {
  it("returns the SAME cached sprite drawLabel rasterized (shared cache)", () => {
    resetLabelCache();
    const ctx = ctx2d();
    drawLabel(ctx, "12:00:05", 10, 20, BASE);
    const blitted = drawImages(ctx as unknown as FakeCtx)[0]!.args[0];
    const sprite = spriteFor("12:00:05", BASE);
    expect(sprite).not.toBeNull();
    expect(sprite!.canvas).toBe(blitted); // identity: one raster for both paths
  });

  it("rasterizes via the lazy measuring scratch when no draw preceded it", () => {
    resetLabelCache();
    const sprite = spriteFor("3.5", { ...BASE, baseline: "middle" });
    expect(sprite).not.toBeNull();
    // Stub metrics: width 50 → cssW 52; "10px" → cssH 22, middle anchor 11.
    expect(sprite!.cssW).toBe(52);
    expect(sprite!.cssH).toBe(22);
    expect(sprite!.yAnchor).toBe(11);
    expect(labelOf(sprite!.canvas)).toBe("3.5");
  });

  it("labelBlitPos matches drawLabel's blit exactly (dpr snap, all aligns)", () => {
    resetLabelCache();
    const out = { dx: 0, dy: 0 };
    for (const align of ["left", "center", "right"] as const) {
      for (const dpr of [1, 2]) {
        const opts = { ...BASE, align, dpr };
        const ctx = ctx2d();
        drawLabel(ctx, "x", 10.3, 20.7, opts);
        const call = drawImages(ctx as unknown as FakeCtx)[0]!;
        const sprite = spriteFor("x", opts)!;
        labelBlitPos(sprite, 10.3, 20.7, align, dpr, out);
        expect([out.dx, out.dy]).toEqual([call.args[1], call.args[2]]);
      }
    }
  });

  it("latches when sprite creation fails after the scratch was established", () => {
    resetLabelCache();
    expect(spriteFor("warm", BASE)).not.toBeNull(); // scratch + sprite OK
    const g = globalThis as { OffscreenCanvas?: unknown };
    const Real = g.OffscreenCanvas;
    g.OffscreenCanvas = class {
      constructor() {
        throw new Error("no OffscreenCanvas");
      }
    };
    try {
      // New text → new sprite canvas → ctor throws → null + latch.
      expect(spriteFor("fresh", BASE)).toBeNull();
      g.OffscreenCanvas = Real;
      expect(spriteFor("fresh", BASE)).toBeNull(); // latched
    } finally {
      g.OffscreenCanvas = Real;
    }
  });

  it("returns null when the scratch canvas constructor throws", () => {
    resetLabelCache();
    const g = globalThis as { OffscreenCanvas?: unknown };
    const Real = g.OffscreenCanvas;
    g.OffscreenCanvas = class {
      constructor() {
        throw new Error("no OffscreenCanvas");
      }
    };
    try {
      expect(spriteFor("a", BASE)).toBeNull();
    } finally {
      g.OffscreenCanvas = Real;
    }
  });

  it("returns null and latches when the scratch canvas cannot be created", () => {
    resetLabelCache();
    const g = globalThis as { OffscreenCanvas?: unknown };
    const Real = g.OffscreenCanvas;
    g.OffscreenCanvas = class {
      getContext() {
        return null;
      }
    };
    try {
      expect(spriteFor("a", BASE)).toBeNull();
      g.OffscreenCanvas = Real; // restored, but the latch must hold
      expect(spriteFor("a", BASE)).toBeNull();
      resetLabelCache(); // re-arms latch AND scratch
      expect(spriteFor("a", BASE)).not.toBeNull();
    } finally {
      g.OffscreenCanvas = Real;
    }
  });
});
