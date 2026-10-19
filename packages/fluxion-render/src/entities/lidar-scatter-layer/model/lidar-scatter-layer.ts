import { intensityLUT } from "../../../shared/lib/color";
import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { LidarScatterConfig } from "../../../shared/model/layer-configs";

import type { LidarScatterConfig } from "../../../shared/model/layer-configs";

const LUT_BUCKETS = 256;

/**
 * Renders a point cloud as a 2D top-down scatter.
 * Expects Float32Array with layout [x, y, z, intensity, ...] (stride configurable).
 *
 * Fast path for 10k+ points: counting-sort by intensity-LUT bucket so each
 * color bucket issues one `beginPath / rect×N / fill` cycle. This reduces
 * fillStyle state changes from O(N) to at most 256 per frame, and collapses
 * all per-point fillRect calls into a single path fill per color.
 *
 * Scratch buffers (`sortedX`, `sortedY`, `bucketCount`) live as layer fields
 * and grow by 25% when the point budget expands, so steady-state pushes
 * allocate zero memory.
 */
export class LidarScatterLayer implements Layer {
  readonly id: string;
  private stride = 4;
  private pointSize = 2;
  private intensityMax = 1;
  private solidColor: [number, number, number] | null = null;
  private data: Float32Array | null = null;
  private length = 0;

  // Scratch buffers for counting-sort batching.
  private sortedX: Float32Array = new Float32Array(0);
  private sortedY: Float32Array = new Float32Array(0);
  private bucketCount: Uint32Array = new Uint32Array(LUT_BUCKETS);
  private bucketOffset: Uint32Array = new Uint32Array(LUT_BUCKETS);
  private scratchCapacity = 0;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as LidarScatterConfig;
    if (c.stride !== undefined) this.stride = Math.max(2, c.stride | 0);
    if (c.pointSize !== undefined) this.pointSize = Math.max(1, c.pointSize);
    if (c.intensityMax !== undefined) this.intensityMax = c.intensityMax;
    if (c.color !== undefined) this.solidColor = parseColor(c.color);
  }

  setData(buffer: ArrayBuffer, length: number, _viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.length = length;
  }

  resize(_viewport: Viewport): void {}

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    const data = this.data;
    if (!data || this.length < this.stride) return;

    const stride = this.stride;
    const size = this.pointSize;
    const half = size / 2;
    const count = (this.length / stride) | 0;

    if (this.solidColor) {
      this.drawSolid(ctx, viewport, data, stride, count, size, half);
      return;
    }

    this.ensureScratch(count);
    this.drawBucketed(ctx, viewport, data, stride, count, size, half);
  }

  private drawSolid(
    ctx: OffscreenCanvasRenderingContext2D,
    viewport: Viewport,
    data: Float32Array,
    stride: number,
    count: number,
    size: number,
    half: number,
  ): void {
    const [r, g, b] = this.solidColor as [number, number, number];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const px = viewport.xToPx(data[o]);
      const py = viewport.yToPx(data[o + 1]);
      ctx.rect(px - half, py - half, size, size);
    }
    ctx.fill();
  }

  private drawBucketed(
    ctx: OffscreenCanvasRenderingContext2D,
    viewport: Viewport,
    data: Float32Array,
    stride: number,
    count: number,
    size: number,
    half: number,
  ): void {
    const lut = intensityLUT();
    const invMax = 1 / (this.intensityMax || 1);
    const sortedX = this.sortedX;
    const sortedY = this.sortedY;
    const bucketCount = this.bucketCount;
    const bucketOffset = this.bucketOffset;

    // Reset bucket histograms.
    bucketCount.fill(0);

    // Pass 1: compute pixel coords + bucket index, fill histogram.
    // Stash bucket index in a parallel-ish way: we'll recompute in pass 2
    // to avoid a third scratch buffer. The cost is one extra intensity read.
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const intensity = stride >= 4 ? data[o + 3] : 1;
      let idx = (intensity * invMax * (LUT_BUCKETS - 1)) | 0;
      if (idx < 0) idx = 0;
      else if (idx >= LUT_BUCKETS) idx = LUT_BUCKETS - 1;
      bucketCount[idx]++;
    }

    // Prefix-sum: bucketOffset[b] = sum of bucketCount[0..b-1]
    let acc = 0;
    for (let b = 0; b < LUT_BUCKETS; b++) {
      bucketOffset[b] = acc;
      acc += bucketCount[b];
    }

    // Pass 2: scatter points into bucket-ordered scratch. We reuse
    // `bucketCount` as a write cursor by decrementing it back to 0.
    // Snapshot offsets first, then advance cursors from each offset.
    // Simpler: use bucketCount as an independent write cursor initialised to 0.
    const writeCursor = bucketCount; // reused, currently holds histogram
    // Restore to 0 now that bucketOffset has captured the prefix sum.
    for (let b = 0; b < LUT_BUCKETS; b++) writeCursor[b] = 0;

    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const intensity = stride >= 4 ? data[o + 3] : 1;
      let idx = (intensity * invMax * (LUT_BUCKETS - 1)) | 0;
      if (idx < 0) idx = 0;
      else if (idx >= LUT_BUCKETS) idx = LUT_BUCKETS - 1;
      const pos = bucketOffset[idx] + writeCursor[idx];
      writeCursor[idx]++;
      sortedX[pos] = viewport.xToPx(data[o]);
      sortedY[pos] = viewport.yToPx(data[o + 1]);
    }

    // Pass 3: emit one path per non-empty bucket.
    for (let b = 0; b < LUT_BUCKETS; b++) {
      const n = writeCursor[b];
      if (n === 0) continue;
      ctx.fillStyle = `rgb(${lut.r[b]},${lut.g[b]},${lut.b[b]})`;
      ctx.beginPath();
      const start = bucketOffset[b];
      const end = start + n;
      for (let i = start; i < end; i++) {
        ctx.rect(sortedX[i] - half, sortedY[i] - half, size, size);
      }
      ctx.fill();
    }
  }

  private ensureScratch(count: number): void {
    if (count <= this.scratchCapacity) {
      // Shrink when count drops below 25% of capacity, down to a 1024 floor.
      const shrinkThreshold = this.scratchCapacity >> 2;
      if (count < shrinkThreshold && this.scratchCapacity > 1024) {
        const next = Math.max(count * 2, 1024);
        this.sortedX = new Float32Array(next);
        this.sortedY = new Float32Array(next);
        this.scratchCapacity = next;
      }
      return;
    }
    const next = Math.max(count, Math.ceil(this.scratchCapacity * 1.25), 1024);
    this.sortedX = new Float32Array(next);
    this.sortedY = new Float32Array(next);
    this.scratchCapacity = next;
  }

  dispose(): void {
    this.data = null;
    this.sortedX = new Float32Array(0);
    this.sortedY = new Float32Array(0);
    this.scratchCapacity = 0;
  }
}

function parseColor(css: string): [number, number, number] {
  if (css.startsWith("#")) {
    const hex = css.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  return [255, 255, 255];
}
