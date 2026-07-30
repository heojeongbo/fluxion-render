import { describe, expect, it, vi } from "vitest";
import type { GlRenderer } from "../../../shared/gl/gl-renderer";
import {
  type ClipTransform,
  dataToClip,
  laneToClip,
} from "../../../shared/gl/gl-transform";
import { Viewport } from "../../../shared/model/viewport";
import { createFakeCtx } from "../../../test/setup";
import { AxisGridLayer } from "../../axis-grid-layer/model/axis-grid-layer";
import { LineChartLayer } from "./line-chart-layer";

function makeViewport() {
  const v = new Viewport();
  v.setSize(1000, 100, 1);
  v.setBounds({ xMin: 0, xMax: 5000, yMin: -1, yMax: 1 });
  return v;
}

describe("LineChartLayer (streaming)", () => {
  it("no-op when fewer than 2 samples have been pushed", () => {
    const layer = new LineChartLayer("l");
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, makeViewport());
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
  });

  it("setData ignores buffers shorter than one [t,y] pair (length < 2)", () => {
    const layer = new LineChartLayer("l");
    const vp = makeViewport();
    expect(vp.latestT).toBe(0);
    layer.setData(new Float32Array([42]).buffer, 1, vp);
    // No sample pushed, latestT untouched.
    expect(vp.latestT).toBe(0);
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.some((c) => c.name === "moveTo")).toBe(false);
  });

  it("accumulates [t,y] samples across multiple setData calls", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ capacity: 8 });
    const vp = makeViewport();
    layer.setData(new Float32Array([0, 0, 100, 0.5]).buffer, 4, vp);
    layer.setData(new Float32Array([200, -0.5, 300, 0.8]).buffer, 4, vp);
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    // 4 samples -> 1 moveTo + 3 lineTos
    expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
    expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(3);
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
  });

  it("applies opacity at stroke time and restores globalAlpha after draw", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ capacity: 8, opacity: 0.4 });
    const vp = makeViewport();
    layer.setData(new Float32Array([0, 0, 100, 0.5]).buffer, 4, vp);
    const ctx = createFakeCtx();
    let alphaAtStroke = Number.NaN;
    const origStroke = ctx.stroke;
    ctx.stroke = () => {
      alphaAtStroke = ctx.globalAlpha;
      origStroke();
    };
    ctx.globalAlpha = 0.9; // pre-existing frame alpha that must be restored.
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(alphaAtStroke).toBe(0.4);
    expect(ctx.globalAlpha).toBe(0.9);
  });

  it("leaves globalAlpha untouched when opacity is the default 1", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ capacity: 8 });
    const vp = makeViewport();
    layer.setData(new Float32Array([0, 0, 100, 0.5]).buffer, 4, vp);
    const ctx = createFakeCtx();
    let alphaAtStroke = Number.NaN;
    const origStroke = ctx.stroke;
    ctx.stroke = () => {
      alphaAtStroke = ctx.globalAlpha;
      origStroke();
    };
    ctx.globalAlpha = 0.9;
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(alphaAtStroke).toBe(0.9);
    expect(ctx.globalAlpha).toBe(0.9);
  });

  it("applies opacity on the decimated draw path too", () => {
    const layer = new LineChartLayer("l");
    // Many samples + decimate so the decimated branch (separate stroke) runs.
    layer.setConfig({ capacity: 4096, decimate: true, opacity: 0.5 });
    const vp = makeViewport();
    const samples: number[] = [];
    for (let i = 0; i < 4000; i++) samples.push(i, Math.sin(i));
    layer.setData(new Float32Array(samples).buffer, samples.length, vp);
    const ctx = createFakeCtx();
    let alphaAtStroke = Number.NaN;
    const origStroke = ctx.stroke;
    ctx.stroke = () => {
      alphaAtStroke = ctx.globalAlpha;
      origStroke();
    };
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(alphaAtStroke).toBe(0.5);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("advances viewport.latestT to the newest timestamp", () => {
    const layer = new LineChartLayer("l");
    const vp = makeViewport();
    expect(vp.latestT).toBe(0);
    layer.setData(new Float32Array([100, 0.1, 250, 0.2, 900, 0.3]).buffer, 6, vp);
    expect(vp.latestT).toBe(900);
    // An earlier batch must not roll latestT backwards
    layer.setData(new Float32Array([50, 0.0]).buffer, 2, vp);
    expect(vp.latestT).toBe(900);
  });

  it("overflow keeps most recent samples (ring buffer)", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ capacity: 3 });
    const vp = makeViewport();
    layer.setData(
      new Float32Array([0, 0, 100, 1, 200, 2, 300, 3, 400, 4]).buffer,
      10,
      vp,
    );
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    // capacity 3 -> 1 moveTo + 2 lineTos
    expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
    expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(2);
  });

  it("respects color + lineWidth config", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ color: "#ff00aa", lineWidth: 3 });
    const vp = makeViewport();
    layer.setData(new Float32Array([0, 0, 100, 0.5]).buffer, 4, vp);
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.strokeStyle).toBe("#ff00aa");
    expect(ctx.lineWidth).toBe(3);
  });

  it("draw filters samples older than viewport.bounds.xMin", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ capacity: 16 });
    const vp = makeViewport();
    // Push 5 samples at t = 0, 100, 200, 300, 400
    layer.setData(
      new Float32Array([0, 0, 100, 0.1, 200, 0.2, 300, 0.3, 400, 0.4]).buffer,
      10,
      vp,
    );
    // Retarget the viewport to the trailing 200ms window
    vp.setBounds({ xMin: 200, xMax: 400, yMin: -1, yMax: 1 });
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    // Only samples at t = 200, 300, 400 remain visible -> 1 moveTo + 2 lineTo
    expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
    expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(2);
  });

  it("draw skips stroke entirely when every sample is outside the window", () => {
    const layer = new LineChartLayer("l");
    layer.setConfig({ capacity: 16 });
    const vp = makeViewport();
    layer.setData(new Float32Array([0, 0, 100, 1, 200, 2]).buffer, 6, vp);
    // Window starts in the future — nothing visible
    vp.setBounds({ xMin: 5000, xMax: 6000, yMin: -1, yMax: 1 });
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(0);
    expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(0);
  });

  describe("scan (y auto-fit support)", () => {
    it("publishes visible-window min/max to viewport.observedYMin/Max", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 16 });
      const vp = makeViewport();
      vp.setBounds({ xMin: 0, xMax: 5000, yMin: -10, yMax: 10 });
      layer.setData(
        new Float32Array([100, 0.1, 200, -0.5, 300, 1.2, 400, 0.3]).buffer,
        8,
        vp,
      );
      vp.beginScan();
      layer.scan?.(vp);
      expect(vp.observedYMin).toBeCloseTo(-0.5);
      expect(vp.observedYMax).toBeCloseTo(1.2);
    });

    it("excludes samples outside the current x window", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 16 });
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 100, 100, 50, 200, -20, 300, 5]).buffer, 8, vp);
      // Only samples with t >= 150 should contribute
      vp.setBounds({ xMin: 150, xMax: 500, yMin: -100, yMax: 100 });
      vp.beginScan();
      layer.scan?.(vp);
      expect(vp.observedYMin).toBeCloseTo(-20);
      expect(vp.observedYMax).toBeCloseTo(5);
    });

    it("leaves observed extents at +/-Inf when ring is empty", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      vp.beginScan();
      layer.scan?.(vp);
      expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
      expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
    });

    it("leaves observed extents untouched when every sample is outside the window", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8 });
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 1, 200, 2]).buffer, 6, vp);
      vp.setBounds({ xMin: 5000, xMax: 6000, yMin: -1, yMax: 1 });
      vp.beginScan();
      layer.scan?.(vp);
      expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
      expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
    });

    it("two layers merge their observations into a single aggregate", () => {
      const a = new LineChartLayer("a");
      const b = new LineChartLayer("b");
      const vp = makeViewport();
      vp.setBounds({ xMin: 0, xMax: 1000, yMin: -100, yMax: 100 });
      a.setData(new Float32Array([100, 1, 200, 2, 300, 3]).buffer, 6, vp);
      b.setData(new Float32Array([150, -5, 250, 10, 350, 0]).buffer, 6, vp);
      vp.beginScan();
      a.scan?.(vp);
      b.scan?.(vp);
      expect(vp.observedYMin).toBeCloseTo(-5);
      expect(vp.observedYMax).toBeCloseTo(10);
    });
  });

  describe("capacity via retentionMs + maxHz", () => {
    it("auto-calculates capacity from retentionMs and maxHz", () => {
      const layer = new LineChartLayer("l");
      // ceil(10 * 60 * 1.1) = 660
      layer.setConfig({ retentionMs: 10_000, maxHz: 60 });
      const vp = makeViewport();
      // Fill 660 samples then push 1 more — oldest should be dropped (ring wraps)
      const buf = new Float32Array(660 * 2);
      for (let i = 0; i < 660; i++) {
        buf[i * 2] = i;
        buf[i * 2 + 1] = 0;
      }
      layer.setData(buf.buffer, buf.length, vp);
      const extra = new Float32Array([700, 9]);
      layer.setData(extra.buffer, 2, vp);
      vp.setBounds({ xMin: 0, xMax: 10000, yMin: -1, yMax: 10 });
      vp.beginScan();
      layer.scan?.(vp);
      // y=9 should be visible; y=0 from very first sample is dropped
      expect(vp.observedYMax).toBeCloseTo(9);
    });

    it("explicit capacity takes priority over retentionMs+maxHz", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 500, retentionMs: 10_000, maxHz: 60 });
      const vp = makeViewport();
      // Fill 500 + 1 samples — ring wraps at 500, not 660
      const buf = new Float32Array(500 * 2);
      for (let i = 0; i < 500; i++) {
        buf[i * 2] = i;
        buf[i * 2 + 1] = 1;
      }
      layer.setData(buf.buffer, buf.length, vp);
      layer.setData(new Float32Array([600, 5]).buffer, 2, vp);
      vp.setBounds({ xMin: 0, xMax: 10000, yMin: -1, yMax: 10 });
      vp.beginScan();
      layer.scan?.(vp);
      expect(vp.observedYMax).toBeCloseTo(5);
    });

    it("retentionMs alone without maxHz leaves capacity unchanged", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 100 });
      layer.setConfig({ retentionMs: 10_000 }); // no maxHz → no-op
      const vp = makeViewport();
      // Fill 100 samples + 1 overflow — ring capacity should still be 100
      const buf = new Float32Array(100 * 2);
      for (let i = 0; i < 100; i++) {
        buf[i * 2] = i;
        buf[i * 2 + 1] = 0;
      }
      layer.setData(buf.buffer, buf.length, vp);
      layer.setData(new Float32Array([200, 7]).buffer, 2, vp);
      vp.setBounds({ xMin: 0, xMax: 10000, yMin: -1, yMax: 10 });
      vp.beginScan();
      layer.scan?.(vp);
      // capacity=100 so first sample was dropped and y=7 is present
      expect(vp.observedYMax).toBeCloseTo(7);
    });
  });

  describe("visible flag", () => {
    it("visible: false skips draw", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ visible: false });
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
    });

    it("visible: false skips scan (y extents untouched)", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ visible: false });
      const vp = makeViewport();
      vp.setBounds({ xMin: 0, xMax: 1000, yMin: -100, yMax: 100 });
      layer.setData(new Float32Array([0, 99, 100, -99]).buffer, 4, vp);
      vp.beginScan();
      layer.scan?.(vp);
      expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
      expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
    });

    it("toggling visible back to true resumes draw", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
      layer.setConfig({ visible: false });
      layer.setConfig({ visible: true });
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    });
  });

  it("dispose clears the ring buffer", () => {
    const layer = new LineChartLayer("l");
    const vp = makeViewport();
    layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
    layer.dispose();
    const ctx = createFakeCtx();
    layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
    expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
  });

  describe("clearData (replay seek support)", () => {
    it("drops every sample from the ring buffer", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 1, 200, 2]).buffer, 6, vp);
      layer.clearData();
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
    });

    it("preserves config so subsequent pushes use the same capacity", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 3, color: "#abc" });
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
      layer.clearData();
      // Push 5 samples; the configured capacity of 3 must still cap the ring.
      layer.setData(
        new Float32Array([200, 2, 300, 3, 400, 4, 500, 5, 600, 6]).buffer,
        10,
        vp,
      );
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      // 3 visible samples -> 1 moveTo + 2 lineTos
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
      expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(2);
      expect(ctx.strokeStyle).toBe("#abc");
    });
  });

  // Phase 17 — Bug 2 e2e: when a DVR hydrate does
  // `clearData(latestT = seekT)` then `setData(samples in [seekT - windowMs, seekT])`,
  // the line + axis combination MUST render those samples (not "start fresh").
  // This is the worker-side equivalent of `useChartReplay.hydrate`. The user
  // reported the chart looked empty after going to past; this test pins down
  // the exact pipeline so that bug can't silently regress.
  describe("DVR hydrate integration (line + axis)", () => {
    it("clearData(seekT) + setData([seekT-windowMs, seekT]) renders all backfill samples", () => {
      const SEEK_T = 10_000; // host-relative ms
      const WINDOW_MS = 5_000;

      const axis = new AxisGridLayer("axis");
      axis.setConfig({
        xMode: "time",
        timeWindowMs: WINDOW_MS,
        yMode: "auto",
        applyToViewport: true,
      });
      const line = new LineChartLayer("line");
      line.setConfig({ capacity: 200 });

      const v = new Viewport();
      v.setSize(1000, 100, 1);

      // The hydrate flow: reset wipes the ring AND rewinds latestT, then
      // setData pushes the backfill samples (each t <= SEEK_T).
      line.clearData();
      v.latestT = SEEK_T; // CLEAR_DATA op also sets viewport.latestT

      // 100 samples at 50 ms intervals covering [5000, 9950].
      const buf = new Float32Array(200);
      for (let i = 0; i < 100; i++) {
        const t = SEEK_T - WINDOW_MS + i * 50;
        buf[i * 2] = t;
        buf[i * 2 + 1] = i / 10;
      }
      line.setData(buf.buffer, buf.length, v);

      // The axis scan computes the visible window from viewport.latestT.
      v.beginScan();
      axis.scan?.(v);
      // The line scan filters by xMin (= latestT - windowMs).
      line.scan?.(v);

      // The axis must have anchored the visible range at [SEEK_T - WINDOW_MS, SEEK_T].
      expect(v.bounds.xMin).toBe(SEEK_T - WINDOW_MS);
      expect(v.bounds.xMax).toBe(SEEK_T);

      // The line must actually draw — 100 samples in range → 1 moveTo + 99 lineTos.
      const ctx = createFakeCtx();
      line.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, v);
      const moves = ctx.calls.filter((c) => c.name === "moveTo").length;
      const lines = ctx.calls.filter((c) => c.name === "lineTo").length;
      expect(moves).toBe(1);
      expect(lines).toBe(99);
      expect(ctx.calls.some((c) => c.name === "stroke")).toBe(true);
    });

    it("the boundary sample at t === seekT is NOT silently dropped", () => {
      // Specifically guards against an off-by-one in xMax / latestT logic
      // that would clip the most recent backfill point.
      const SEEK_T = 20_000;
      const WINDOW_MS = 5_000;

      const axis = new AxisGridLayer("axis");
      axis.setConfig({
        xMode: "time",
        timeWindowMs: WINDOW_MS,
        applyToViewport: true,
      });
      const line = new LineChartLayer("line");
      line.setConfig({ capacity: 16 });
      const v = new Viewport();
      v.setSize(500, 100, 1);

      line.clearData();
      v.latestT = SEEK_T;
      // Two samples, the second exactly at SEEK_T.
      line.setData(new Float32Array([SEEK_T - 1_000, 0.1, SEEK_T, 0.2]).buffer, 4, v);

      v.beginScan();
      axis.scan?.(v);
      line.scan?.(v);
      const ctx = createFakeCtx();
      line.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, v);

      // Two samples → 1 moveTo + 1 lineTo. If the boundary sample were
      // dropped we'd get 0 lineTos.
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
      expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(1);
    });
  });

  // Regression for the DVR→Live "all charts blank" bug. `viewport.latestT` is
  // GLOBAL — shared by every layer of a host. The live backfill clears a
  // layer's ring with `reset()` (CLEAR_DATA with NO latestT) precisely so it
  // does NOT rewind the shared latestT and yank every sibling layer's time
  // window. These tests pin that contract: clearing layer A must not blank
  // sibling layer B; rewinding latestT (the old buggy path) does.
  describe("shared-host multi-layer: clearing one layer must not blank siblings", () => {
    const WINDOW_MS = 30_000;

    function makeAxisAndViewport() {
      const axis = new AxisGridLayer("axis");
      axis.setConfig({
        xMode: "time",
        timeWindowMs: WINDOW_MS,
        yMode: "auto",
        applyToViewport: true,
      });
      const v = new Viewport();
      v.setSize(1000, 100, 1);
      return { axis, v };
    }

    // Fill a layer with `count` samples ending exactly at `endT` (50 ms apart),
    // advancing the shared latestT to `endT` via setData (monotonic-up).
    function fill(layer: LineChartLayer, endT: number, count: number, v: Viewport) {
      const buf = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        buf[i * 2] = endT - (count - 1 - i) * 50;
        buf[i * 2 + 1] = i / 10;
      }
      layer.setData(buf.buffer, buf.length, v);
    }

    // A line is actually visible only if a path was built — `draw` always calls
    // stroke(), even with no in-window samples, so count moveTo instead.
    function drawsLine(layer: LineChartLayer, v: Viewport): boolean {
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, v);
      return ctx.calls.some((c) => c.name === "moveTo");
    }

    it("reset() without latestT on layer A leaves sibling B drawing", () => {
      const NOW = 200_000;
      const { axis, v } = makeAxisAndViewport();
      const a = new LineChartLayer("a");
      const b = new LineChartLayer("b");
      a.setConfig({ capacity: 1024 });
      b.setConfig({ capacity: 1024 });

      // Both layers hold a recent window; latestT advances to NOW.
      fill(a, NOW, 100, v);
      fill(b, NOW, 100, v);
      v.beginScan();
      axis.scan?.(v);
      expect(v.bounds.xMin).toBe(NOW - WINDOW_MS);
      expect(v.bounds.xMax).toBe(NOW);
      expect(drawsLine(a, v)).toBe(true);
      expect(drawsLine(b, v)).toBe(true);

      // Live backfill for A: ring-only clear (NO latestT rewind), then refill.
      a.clearData(); // CLEAR_DATA with latestT undefined → latestT untouched
      // B is untouched. Its samples must still be in-window — the window did
      // not move because clearData() left latestT alone.
      fill(a, NOW, 100, v); // A's fresh window lands, latestT stays NOW

      v.beginScan();
      axis.scan?.(v);
      expect(v.bounds.xMin).toBe(NOW - WINDOW_MS); // window unchanged
      expect(v.bounds.xMax).toBe(NOW);
      // The whole point: B never blanked.
      expect(drawsLine(b, v)).toBe(true);
      expect(drawsLine(a, v)).toBe(true);
    });

    it("CONTRAST: rewinding latestT forward (the old buggy path) DOES blank sibling B", () => {
      // Demonstrates the failure mode the no-latestT reset avoids: if A's clear
      // had forced latestT far forward while B still held only older samples,
      // B's data falls outside [latestT - windowMs, latestT] and B blanks.
      const PAST = 100_000;
      const { axis, v } = makeAxisAndViewport();
      const a = new LineChartLayer("a");
      const b = new LineChartLayer("b");
      a.setConfig({ capacity: 1024 });
      b.setConfig({ capacity: 1024 });

      fill(a, PAST, 100, v);
      fill(b, PAST, 100, v);
      v.beginScan();
      axis.scan?.(v);
      expect(drawsLine(b, v)).toBe(true);

      // Simulate the buggy forward rewind: clear A AND jam latestT to a much
      // later "now" (as `reset(now - timeOrigin)` did). B's window-relative
      // data is now far in the past → outside the window → B draws nothing.
      const FUTURE = PAST + WINDOW_MS * 4;
      a.clearData();
      v.latestT = FUTURE; // the destructive global rewind

      v.beginScan();
      axis.scan?.(v);
      expect(v.bounds.xMin).toBe(FUTURE - WINDOW_MS);
      expect(drawsLine(b, v)).toBe(false); // ← the all-charts-blank symptom
    });
  });

  describe("draw decimation (decimate: true)", () => {
    // Viewport is 1000px wide over [0, 5000]. 5000 samples → 5 per pixel.
    function fill5000(layer: LineChartLayer, vp: Viewport, spikeAt?: number) {
      layer.setConfig({ capacity: 6000 });
      const buf = new Float32Array(5000 * 2);
      for (let i = 0; i < 5000; i++) {
        buf[i * 2] = i; // t = 0..4999 (1px ≈ 5 samples)
        // Mostly ~0, with one big spike if requested.
        buf[i * 2 + 1] = i === spikeAt ? 0.9 : Math.sin(i * 0.01) * 0.05;
      }
      layer.setData(buf.buffer, buf.length, vp);
    }

    it("emits far fewer path points than samples (≈ O(width), not O(samples))", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ decimate: true });
      fill5000(layer, vp);

      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const points =
        ctx.calls.filter((c) => c.name === "moveTo").length +
        ctx.calls.filter((c) => c.name === "lineTo").length;
      // 5000 samples → bounded to ~a few per 1000px column, well under 5000.
      expect(points).toBeGreaterThan(0);
      expect(points).toBeLessThan(5000);
      expect(points).toBeLessThanOrEqual(1000 * 4); // ≤ ~4 points/pixel
    });

    it("preserves a spike's peak in the decimated path (visually lossless)", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ decimate: true });
      fill5000(layer, vp, 2500); // spike of y=0.9 at t=2500

      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      // The spike's y (0.9) maps to a px via yToPx; it must appear among the
      // drawn points (the min/max bucket keeps the column's extreme).
      const spikePy = vp.yToPx(0.9);
      const ys = ctx.calls
        .filter((c) => c.name === "moveTo" || c.name === "lineTo")
        .map((c) => (c.args as number[])[1]);
      expect(ys.some((y) => Math.abs(y - spikePy) < 0.5)).toBe(true);
    });

    it("two consecutive decimated draws emit identical call sequences (scratch reset)", () => {
      // Guards the persistent-sink state (`_dFirst` and scratch reuse): a
      // second draw must not be affected by the first one's leftover state.
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ decimate: true });
      fill5000(layer, vp);

      const ctxA = createFakeCtx();
      layer.draw(ctxA as unknown as OffscreenCanvasRenderingContext2D, vp);
      const ctxB = createFakeCtx();
      layer.draw(ctxB as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctxB.calls).toEqual(ctxA.calls);
    });

    it("decimate does NOT change the ring — scan still sees full-resolution y extremes", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ decimate: true });
      fill5000(layer, vp, 2500); // spike 0.9
      vp.setBounds({ xMin: 0, xMax: 5000, yMin: -1, yMax: 1 });
      vp.beginScan();
      layer.scan?.(vp);
      // The full-resolution spike is still observed for y-auto bounds.
      expect(vp.observedYMax).toBeCloseTo(0.9, 5);
    });

    it("decimated path skips samples older than viewport.bounds.xMin", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ decimate: true });
      fill5000(layer, vp); // t = 0..4999
      // Retarget so the first half of the ring is below xMin — the decimated
      // forEach must `continue` past those (line: `if (t < xMin) return`).
      vp.setBounds({ xMin: 2500, xMax: 5000, yMin: -1, yMax: 1 });
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const xs = ctx.calls
        .filter((c) => c.name === "moveTo" || c.name === "lineTo")
        .map((c) => (c.args as number[])[0]);
      // Every emitted point's x-pixel must be at/after the xMin column.
      const xMinPx = vp.xToPx(2500);
      expect(xs.length).toBeGreaterThan(0);
      expect(xs.every((x) => x >= xMinPx - 1)).toBe(true);
    });

    it("decimated path with every sample out of window emits no points", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ decimate: true });
      fill5000(layer, vp); // t = 0..4999
      // Window entirely after the data — every sample hits the xMin filter,
      // so curCol stays NaN and the final flush is skipped (no path built).
      vp.setBounds({ xMin: 10_000, xMax: 12_000, yMin: -1, yMax: 1 });
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(0);
      expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(0);
    });

    it("decimate omitted (auto) decimates when oversampled", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ capacity: 6000 }); // decimate omitted → AUTO
      const buf = new Float32Array(3000 * 2);
      for (let i = 0; i < 3000; i++) {
        buf[i * 2] = i;
        buf[i * 2 + 1] = 0;
      }
      layer.setData(buf.buffer, buf.length, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const lineTos = ctx.calls.filter((c) => c.name === "lineTo").length;
      // 3000 samples > 2×1000px → auto-decimates, far fewer than every sample.
      expect(lineTos).toBeGreaterThan(0);
      expect(lineTos).toBeLessThan(3000);
    });

    it("decimate: false draws every sample even when oversampled", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setConfig({ capacity: 6000, decimate: false }); // explicit opt-out
      const buf = new Float32Array(3000 * 2);
      for (let i = 0; i < 3000; i++) {
        buf[i * 2] = i;
        buf[i * 2 + 1] = 0;
      }
      layer.setData(buf.buffer, buf.length, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const lineTos = ctx.calls.filter((c) => c.name === "lineTo").length;
      expect(lineTos).toBe(2999); // 1 moveTo + 2999 lineTo = every sample
    });
  });

  describe("maxGapMs gap-breaking", () => {
    it("breaks the stroke at gaps larger than maxGapMs (extra moveTo, fewer lineTo)", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8, maxGapMs: 150 });
      const vp = makeViewport();
      // Two bursts separated by an 800 ms silence.
      layer.setData(
        new Float32Array([0, 0, 100, 0.5, 200, 0.2, 1000, -0.3, 1100, 0.1]).buffer,
        10,
        vp,
      );
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      // One subpath per burst: 2 moveTo; the gap edge is NOT bridged.
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(2);
      expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(3);
    });

    it("no maxGapMs leaves the path fully connected (unchanged behavior)", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8 });
      const vp = makeViewport();
      layer.setData(
        new Float32Array([0, 0, 100, 0.5, 200, 0.2, 1000, -0.3, 1100, 0.1]).buffer,
        10,
        vp,
      );
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
      expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(4);
    });

    it("a gap exactly equal to maxGapMs does NOT break (strict >)", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8, maxGapMs: 100 });
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 0.5, 200, 0.2]).buffer, 6, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(1);
      expect(ctx.calls.filter((c) => c.name === "lineTo").length).toBe(2);
    });

    it("decimated path breaks at gaps (one moveTo per segment)", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8192, decimate: true, maxGapMs: 50 });
      const vp = new Viewport();
      vp.setSize(1000, 100, 1);
      vp.setBounds({ xMin: 0, xMax: 7000, yMin: -1, yMax: 1 });
      // Two dense bursts (1 ms apart, no internal gaps) separated by 1001 ms.
      const samples = new Float32Array(6000 * 2);
      for (let i = 0; i < 3000; i++) {
        samples[i * 2] = i;
        samples[i * 2 + 1] = Math.sin(i / 50);
      }
      for (let i = 0; i < 3000; i++) {
        samples[(3000 + i) * 2] = 4000 + i;
        samples[(3000 + i) * 2 + 1] = Math.sin(i / 50);
      }
      layer.setData(samples.buffer, samples.length, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      // Decimation active (6000 samples > 1000 px * 2) with exactly one
      // subpath per burst.
      expect(ctx.calls.filter((c) => c.name === "moveTo").length).toBe(2);
      const lineTos = ctx.calls.filter((c) => c.name === "lineTo").length;
      expect(lineTos).toBeGreaterThan(0);
      expect(lineTos).toBeLessThan(6000); // decimated, not per-sample
    });
  });

  describe("undersized-capacity warning", () => {
    /** Fill the ring past capacity with samples all inside [xMin, xMax]. */
    function fillBeyondCapacity(layer: LineChartLayer, cap: number, vp: Viewport) {
      const n = cap + 5;
      const arr = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        arr[i * 2] = 100 + i; // t, all >= xMin (0) and within window
        arr[i * 2 + 1] = Math.sin(i);
      }
      layer.setData(arr.buffer, arr.length, vp);
    }

    it("warns once when the full ring's oldest sample is still in-window", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8 });
      const vp = makeViewport();
      fillBeyondCapacity(layer, 8, vp);

      layer.scan(vp);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("ring capacity (8)");
      // Second scan must not warn again.
      layer.scan(vp);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("does not warn when the ring is not full", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 100 });
      const vp = makeViewport();
      layer.setData(new Float32Array([100, 0, 200, 1, 300, 2]).buffer, 6, vp);
      layer.scan(vp);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("does not warn when the oldest retained sample has scrolled out of the window", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 4 });
      const vp = makeViewport();
      // Window starts at 3000; fill a full ring whose oldest retained t < 3000.
      vp.setBounds({ xMin: 3000, xMax: 8000, yMin: -1, yMax: 1 });
      const arr = new Float32Array([100, 0, 200, 1, 300, 2, 400, 3, 500, 4, 600, 5]);
      layer.setData(arr.buffer, arr.length, vp);
      layer.scan(vp);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("re-arms the warning when capacity changes", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const layer = new LineChartLayer("l");
      layer.setConfig({ capacity: 8 });
      const vp = makeViewport();
      fillBeyondCapacity(layer, 8, vp);
      layer.scan(vp);
      expect(warn).toHaveBeenCalledTimes(1);

      // Still-too-small new capacity → can warn again after re-fill.
      layer.setConfig({ capacity: 6 });
      fillBeyondCapacity(layer, 6, vp);
      layer.scan(vp);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });

  describe("dashArray", () => {
    it("sets the dash before stroking and resets it after", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ dashArray: [6, 4] });
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 0.5, 200, -0.3]).buffer, 6, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);

      const names = ctx.calls.map((c) => c.name);
      const setDash = ctx.calls.filter((c) => c.name === "setLineDash");
      // One set (with the pattern) before stroke, one reset (to []) after.
      expect(setDash[0]!.args[0]).toEqual([6, 4]);
      expect(setDash[1]!.args[0]).toEqual([]);
      const firstSet = names.indexOf("setLineDash");
      const stroke = names.indexOf("stroke");
      const lastSet = names.lastIndexOf("setLineDash");
      expect(firstSet).toBeLessThan(stroke);
      expect(lastSet).toBeGreaterThan(stroke);
    });

    it("does not call setLineDash when no dash is configured (solid)", () => {
      const layer = new LineChartLayer("l");
      const vp = makeViewport();
      layer.setData(new Float32Array([0, 0, 100, 0.5]).buffer, 4, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.some((c) => c.name === "setLineDash")).toBe(false);
    });

    it("applies + resets the dash on the decimated draw path", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ decimate: true, capacity: 8000, dashArray: [3, 3] });
      // Narrow viewport so ring.length > widthPx * 2 triggers decimation.
      const vp = new Viewport();
      vp.setSize(10, 100, 1);
      vp.setBounds({ xMin: 0, xMax: 5000, yMin: -1, yMax: 1 });
      const n = 100;
      const arr = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        arr[i * 2] = i * 10;
        arr[i * 2 + 1] = Math.sin(i);
      }
      layer.setData(arr.buffer, arr.length, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const setDash = ctx.calls.filter((c) => c.name === "setLineDash");
      expect(setDash[0]!.args[0]).toEqual([3, 3]);
      expect(setDash.at(-1)!.args[0]).toEqual([]);
    });
  });

  describe("yOffset", () => {
    /** First (moveTo) py drawn for a layer with the given offset. */
    function firstPy(offset: number): number {
      const layer = new LineChartLayer("l");
      layer.setConfig({ yOffset: offset });
      const vp = makeViewport();
      layer.setData(new Float32Array([100, 0, 200, 0]).buffer, 4, vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const move = ctx.calls.find((c) => c.name === "moveTo")!;
      return move.args[1] as number;
    }

    it("shifts the drawn y by yToPx(y + offset)", () => {
      const vp = makeViewport(); // yMin -1, yMax 1, height 100 (no pad)
      const expected = vp.yToPx(0 + 0.5);
      expect(firstPy(0.5)).toBeCloseTo(expected);
      // A positive data offset moves the stroke UP (smaller py).
      expect(firstPy(0.5)).toBeLessThan(firstPy(0));
    });

    it("publishes the SHIFTED y to observedYMin/Max so auto-scale fits it", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ yOffset: 2 });
      const vp = makeViewport();
      vp.setBounds({ xMin: 0, xMax: 5000, yMin: -10, yMax: 10 });
      layer.setData(new Float32Array([100, 0.5, 200, -0.5]).buffer, 4, vp);
      vp.beginScan();
      layer.scan(vp);
      // Raw [-0.5, 0.5] + offset 2 → observed [1.5, 2.5].
      expect(vp.observedYMin).toBeCloseTo(1.5);
      expect(vp.observedYMax).toBeCloseTo(2.5);
    });

    it("offset 0 is identical to no offset", () => {
      expect(firstPy(0)).toBeCloseTo(firstPy(0));
      const vp = makeViewport();
      expect(firstPy(0)).toBeCloseTo(vp.yToPx(0));
    });
  });

  describe("lane mode", () => {
    function makeLaneVp() {
      const v = new Viewport();
      v.setSize(1000, 100, 1); // height 100, no pad
      v.setBounds({ xMin: 0, xMax: 5000, yMin: -1, yMax: 1 });
      return v;
    }

    /** Run scan+draw for a layer in lane (index/count), return drawn py values. */
    function laneDraw(laneIndex: number, laneCount: number, gap = 0) {
      const layer = new LineChartLayer("l");
      layer.setConfig({ laneIndex, laneCount, laneGapPx: gap });
      const vp = makeLaneVp();
      // y ramps 0 → 1 so the band spans its full height.
      layer.setData(new Float32Array([100, 0, 200, 0.5, 300, 1]).buffer, 6, vp);
      vp.beginScan();
      layer.scan(vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      return {
        vp,
        pys: ctx.calls
          .filter((c) => c.name === "moveTo" || c.name === "lineTo")
          .map((c) => c.args[1] as number),
      };
    }

    it("does NOT touch the shared observed range (per-layer normalization)", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ laneIndex: 0, laneCount: 2 });
      const vp = makeLaneVp();
      layer.setData(new Float32Array([100, 5, 200, 9]).buffer, 4, vp);
      vp.beginScan();
      layer.scan(vp);
      // Shared aggregate stays at the begin-scan sentinels.
      expect(vp.observedYMin).toBe(Number.POSITIVE_INFINITY);
      expect(vp.observedYMax).toBe(Number.NEGATIVE_INFINITY);
    });

    it("draws lane 0 into the TOP band and lane 1 into the BOTTOM band", () => {
      const top = laneDraw(0, 2);
      const bottom = laneDraw(1, 2);
      // height 100, 2 lanes → top band [0,50], bottom band [50,100].
      for (const py of top.pys) expect(py).toBeLessThanOrEqual(50.0001);
      for (const py of bottom.pys) expect(py).toBeGreaterThanOrEqual(49.9999);
    });

    it("normalizes the lane to the series' own range (min→band bottom, max→band top)", () => {
      const { pys } = laneDraw(0, 1); // single full-height lane, no gap
      // y went 0→0.5→1; min(0) maps to band bottom (~100), max(1) to top (~0).
      expect(Math.max(...pys)).toBeCloseTo(100, 0);
      expect(Math.min(...pys)).toBeCloseTo(0, 0);
    });

    it("a flat (constant) series does not divide by zero", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ laneIndex: 0, laneCount: 1 });
      const vp = makeLaneVp();
      layer.setData(new Float32Array([100, 7, 200, 7]).buffer, 4, vp);
      vp.beginScan();
      layer.scan(vp);
      const ctx = createFakeCtx();
      expect(() =>
        layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp),
      ).not.toThrow();
      const pys = ctx.calls
        .filter((c) => c.name === "moveTo" || c.name === "lineTo")
        .map((c) => c.args[1] as number);
      for (const py of pys) expect(Number.isFinite(py)).toBe(true);
    });

    it("lane mode ignores yOffset", () => {
      const a = laneDraw(0, 1, 0); // no offset
      const layer = new LineChartLayer("l");
      layer.setConfig({ laneIndex: 0, laneCount: 1, laneGapPx: 0, yOffset: 1000 });
      const vp = makeLaneVp();
      layer.setData(new Float32Array([100, 0, 200, 0.5, 300, 1]).buffer, 6, vp);
      vp.beginScan();
      layer.scan(vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const pys = ctx.calls
        .filter((c) => c.name === "moveTo" || c.name === "lineTo")
        .map((c) => c.args[1] as number);
      // Same as without offset — lane normalization is offset-independent.
      expect(pys).toEqual(a.pys);
    });

    it("maps into the band on the decimated draw path too", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ laneIndex: 1, laneCount: 2, laneGapPx: 0, decimate: true });
      const vp = new Viewport();
      vp.setSize(10, 100, 1); // tiny width forces decimation
      vp.setBounds({ xMin: 0, xMax: 5000, yMin: -1, yMax: 1 });
      const n = 100;
      const arr = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        arr[i * 2] = i * 10;
        arr[i * 2 + 1] = Math.sin(i);
      }
      layer.setData(arr.buffer, arr.length, vp);
      vp.beginScan();
      layer.scan(vp);
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      const ys = ctx.calls
        .filter((c) => c.name === "moveTo" || c.name === "lineTo")
        .map((c) => c.args[1] as number);
      // Lane 1 of 2 → bottom band [50, 100].
      for (const y of ys) expect(y).toBeGreaterThanOrEqual(49.999);
    });

    it("skips draw when the lane has no in-window samples this frame", () => {
      const layer = new LineChartLayer("l");
      layer.setConfig({ laneIndex: 0, laneCount: 2 });
      const vp = makeLaneVp();
      layer.setData(new Float32Array([0, 1, 100, 2]).buffer, 4, vp);
      vp.setBounds({ xMin: 5000, xMax: 6000, yMin: -1, yMax: 1 }); // all samples behind window
      vp.beginScan();
      layer.scan(vp); // scannedY* stay ±Infinity (nothing in window)
      const ctx = createFakeCtx();
      layer.draw(ctx as unknown as OffscreenCanvasRenderingContext2D, vp);
      expect(ctx.calls.some((c) => c.name === "stroke")).toBe(false);
    });
  });
});

describe("LineChartLayer.drawGl", () => {
  function makeGlr() {
    const drawLineStrip = vi.fn();
    return { glr: { drawLineStrip } as unknown as GlRenderer, drawLineStrip };
  }
  function makeViewport() {
    const v = new Viewport();
    v.setSize(1000, 100, 2);
    v.setBounds({ xMin: 0, xMax: 5000, yMin: -1, yMax: 1 });
    return v;
  }

  it("no-ops below 2 samples and when invisible", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setData(new Float32Array([0, 0]).buffer, 2, vp);
    layer.drawGl(glr, vp); // 1 sample
    layer.setData(new Float32Array([100, 1]).buffer, 2, vp);
    layer.setConfig({ visible: false });
    layer.drawGl(glr, vp); // 2 samples but hidden
    expect(drawLineStrip).not.toHaveBeenCalled();
  });

  it("streams raw [t, y] vertices with the dataToClip transform, parsed color, and dpr width", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setConfig({ color: "#4fc3f7", lineWidth: 1.5, opacity: 0.8, yOffset: 0.25 });
    layer.setData(new Float32Array([0, 0, 100, 0.5, 200, -0.5]).buffer, 6, vp);
    layer.drawGl(glr, vp);
    expect(drawLineStrip).toHaveBeenCalledTimes(1);
    const [verts, count, breaks, transform, color, opacity, widthPx] =
      drawLineStrip.mock.calls[0]!;
    expect(count).toBe(3);
    expect(Array.from((verts as Float32Array).subarray(0, 6))).toEqual([
      0, 0, 100, 0.5, 200, -0.5,
    ]);
    expect(breaks).toEqual([]);
    const expected = new Float32Array(6);
    dataToClip(vp, 0.25, expected as ClipTransform);
    expect(Array.from(transform as Float32Array)).toEqual(Array.from(expected));
    expect(color).toEqual([79 / 255, 195 / 255, 247 / 255, 1]);
    expect(opacity).toBe(0.8);
    expect(widthPx).toBe(3); // 1.5 CSS px × dpr 2
  });

  it("reuses the persistent vertex scratch across frames", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
    layer.drawGl(glr, vp);
    layer.setData(new Float32Array([200, 2]).buffer, 2, vp);
    layer.drawGl(glr, vp);
    const first = drawLineStrip.mock.calls[0]![0];
    const second = drawLineStrip.mock.calls[1]![0];
    expect(second).toBe(first); // same Float32Array instance
    expect(drawLineStrip.mock.calls[1]![1]).toBe(3);
  });

  it("skips the draw when fewer than 2 samples survive the xMin filter", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
    vp.setBounds({ xMin: 150, xMax: 5000, yMin: -1, yMax: 1 });
    layer.drawGl(glr, vp);
    expect(drawLineStrip).not.toHaveBeenCalled();
  });

  it("maps lane mode through laneToClip using its own scanned extent", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    vp.yPadPx = 8;
    const layer = new LineChartLayer("l");
    layer.setConfig({ laneIndex: 1, laneCount: 2, laneGapPx: 4 });
    layer.setData(new Float32Array([0, 2, 100, 6, 200, 4]).buffer, 6, vp);
    layer.scan(vp); // engine order: scan fills scannedYMin/Max before draw
    layer.drawGl(glr, vp);
    const transform = drawLineStrip.mock.calls[0]![3] as Float32Array;
    // Recompute the band exactly as yToBandPx does.
    const pad = 8;
    const usable = vp.plotHeight - pad * 2;
    const bandH = usable / 2;
    const top = pad + 1 * bandH + 2;
    const bottom = pad + 2 * bandH - 2;
    const expected = new Float32Array(6);
    laneToClip(vp, top, bottom, 2, 6, expected as ClipTransform);
    expect(Array.from(transform)).toEqual(Array.from(expected));
  });

  it("expands a flat lane extent by ±0.5 like the 2d band mapping", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setConfig({ laneIndex: 0, laneCount: 1 });
    layer.setData(new Float32Array([0, 3, 100, 3]).buffer, 4, vp);
    layer.scan(vp);
    layer.drawGl(glr, vp);
    const transform = drawLineStrip.mock.calls[0]![3] as Float32Array;
    const usable = vp.plotHeight;
    const expected = new Float32Array(6);
    laneToClip(vp, 3, usable - 3, 2.5, 3.5, expected as ClipTransform); // laneGapPx 6 default
    expect(Array.from(transform)).toEqual(Array.from(expected));
  });

  it("defers lane draws until scan has produced an extent", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setConfig({ laneIndex: 0, laneCount: 2 });
    layer.setData(new Float32Array([0, 1, 100, 2]).buffer, 4, vp);
    layer.drawGl(glr, vp); // no scan yet → scannedYMin is NaN
    expect(drawLineStrip).not.toHaveBeenCalled();
  });

  it("warns once for dashArray and draws solid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setConfig({ dashArray: [4, 2] });
    layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
    layer.drawGl(glr, vp);
    layer.drawGl(glr, vp);
    expect(drawLineStrip).toHaveBeenCalledTimes(2);
    const dashWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("dashArray"),
    );
    expect(dashWarns).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("falls back to opaque white when the color cannot be parsed", () => {
    const { glr, drawLineStrip } = makeGlr();
    const vp = makeViewport();
    const layer = new LineChartLayer("l");
    layer.setConfig({ color: "tomato" });
    layer.setData(new Float32Array([0, 0, 100, 1]).buffer, 4, vp);
    layer.drawGl(glr, vp);
    expect(drawLineStrip.mock.calls[0]![4]).toEqual([1, 1, 1, 1]);
  });
});
