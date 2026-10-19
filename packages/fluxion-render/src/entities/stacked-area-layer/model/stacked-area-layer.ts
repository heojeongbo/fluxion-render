import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export type { StackedAreaConfig } from "../../../shared/model/layer-configs";

import type { StackedAreaConfig } from "../../../shared/model/layer-configs";

const DEFAULT_COLORS = ["#4fc3f7", "#80ffa0", "#ffb060", "#ff5252", "#b388ff", "#ffd54f"];

/**
 * Stacked area layer — several series accumulated into bands so the top edge is
 * their running sum (e.g. CPU per-core, power draw by subsystem).
 *
 * Data layout: Float32Array `[t, y0, y1, …, y_{k-1}, …]` stride=`seriesCount+1`,
 * `t` host-relative ms. Series are stacked bottom-up; with `normalize` each
 * sample's bands sum to 1. Contrast `lineLayer` lanes, which separate series
 * instead of summing them.
 */
export class StackedAreaLayer implements Layer {
  readonly id: string;
  private seriesCount = 1;
  private colors: string[] = DEFAULT_COLORS;
  private fillOpacity = 0.85;
  private lineWidth = 0;
  private normalize = false;
  private visible = true;
  private ring: RingBuffer;
  // Reused per-draw scratch: visible-sample x pixels and the flat cumulative
  // tops (`topsScratch[i*sc + s]`). Grown on demand, never per-frame allocated.
  private xsScratch = new Float64Array(0);
  private topsScratch = new Float64Array(0);

  constructor(id: string) {
    this.id = id;
    this.ring = new RingBuffer(2048, 2);
  }

  private get stride(): number {
    return this.seriesCount + 1;
  }

  setConfig(config: unknown): void {
    const c = config as StackedAreaConfig;
    let resized = false;
    if (c.seriesCount !== undefined) {
      const sc = Math.max(1, Math.floor(c.seriesCount));
      if (sc !== this.seriesCount) {
        this.seriesCount = sc;
        resized = true;
      }
    }
    if (c.colors !== undefined && c.colors.length > 0) this.colors = c.colors;
    if (c.fillOpacity !== undefined) this.fillOpacity = c.fillOpacity;
    if (c.lineWidth !== undefined) this.lineWidth = Math.max(0, c.lineWidth);
    if (c.normalize !== undefined) this.normalize = c.normalize;
    if (c.visible !== undefined) this.visible = c.visible;
    const newCapacity = computeRingCapacity(c);
    const cap = newCapacity ?? this.ring.capacity;
    if (resized || (newCapacity !== undefined && newCapacity !== this.ring.capacity)) {
      this.ring = new RingBuffer(cap, this.stride);
    }
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    if (length < this.stride) return;
    const arr = new Float32Array(buffer, 0, length);
    this.ring.pushMany(arr);
    const t = arr[length - this.stride];
    if (t > viewport.latestT) viewport.latestT = t;
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;
    const xMin = viewport.bounds.xMin;
    let localMin = viewport.observedYMin;
    let localMax = viewport.observedYMax;
    const sc = this.seriesCount;
    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      let sum = 0;
      for (let s = 0; s < sc; s++) sum += Math.max(0, data[off + 1 + s]!);
      const top = this.normalize ? 1 : sum;
      if (top > localMax) localMax = top;
      if (0 < localMin) localMin = 0;
    });
    viewport.observedYMin = localMin;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;

    const sc = this.seriesCount;
    const xMin = viewport.bounds.xMin;
    const norm = this.normalize;

    // Collect visible samples once into reused scratch: x pixel + the flat
    // cumulative tops (`tops[i*sc + s]`). `ring.length` bounds the visible count.
    const cap = this.ring.length;
    if (this.xsScratch.length < cap) this.xsScratch = new Float64Array(cap);
    if (this.topsScratch.length < cap * sc) this.topsScratch = new Float64Array(cap * sc);
    const xs = this.xsScratch;
    const tops = this.topsScratch;
    let vis = 0;
    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      let total = 0;
      for (let s = 0; s < sc; s++) total += Math.max(0, data[off + 1 + s]!);
      const scale = norm ? (total > 0 ? 1 / total : 0) : 1;
      const base = vis * sc;
      let acc = 0;
      for (let s = 0; s < sc; s++) {
        acc += Math.max(0, data[off + 1 + s]!) * scale;
        tops[base + s] = acc;
      }
      xs[vis] = viewport.xToPx(t);
      vis++;
    });

    if (vis === 0) return;

    ctx.globalAlpha = this.fillOpacity;
    for (let s = 0; s < sc; s++) {
      const color = this.colors[s % this.colors.length]!;
      ctx.fillStyle = color;
      ctx.beginPath();
      // Upper edge of band s, left → right.
      for (let i = 0; i < vis; i++) {
        const py = viewport.yToPx(tops[i * sc + s]!);
        if (i === 0) ctx.moveTo(xs[i]!, py);
        else ctx.lineTo(xs[i]!, py);
      }
      // Lower edge (top of band s-1, or baseline for s=0), right → left.
      for (let i = vis - 1; i >= 0; i--) {
        const lower = s === 0 ? 0 : tops[i * sc + (s - 1)]!;
        ctx.lineTo(xs[i]!, viewport.yToPx(lower));
      }
      ctx.closePath();
      ctx.fill();
      if (this.lineWidth > 0) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = this.lineWidth;
        ctx.stroke();
        ctx.globalAlpha = this.fillOpacity;
      }
    }
    ctx.globalAlpha = 1;
  }

  clearData(): void {
    this.ring.clear();
  }

  dispose(): void {
    this.ring.clear();
  }
}
