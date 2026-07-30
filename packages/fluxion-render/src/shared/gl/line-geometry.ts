/**
 * CPU side of the WebGL line path: walk a stride-2 `[t, y]` ring
 * chronologically into a caller-owned vertex scratch, filtering samples left
 * of the visible window and splitting the strip at time gaps (`maxGapMs`).
 * Pure and closure-free — an indexed loop over the ring's public backing.
 */
import type { RingBuffer } from "../model/ring-buffer";

/**
 * Fill `out` with visible `[t, y]` pairs and `breaks` with the vertex indices
 * that START a new strip (index 0 is implicit and never included). Returns the
 * vertex count written. `out` must hold `ring.capacity * 2` floats; `breaks`
 * is cleared and refilled.
 */
export function buildLineVertices(
  ring: RingBuffer,
  xMin: number,
  maxGapMs: number | undefined,
  out: Float32Array,
  breaks: number[],
): number {
  breaks.length = 0;
  const { data, capacity, stride, start, length } = ring;
  let n = 0;
  let prevT = Number.NaN;
  for (let i = 0; i < length; i++) {
    const off = ((start + i) % capacity) * stride;
    const t = data[off]!;
    if (t < xMin) continue;
    if (maxGapMs !== undefined && !Number.isNaN(prevT) && t - prevT > maxGapMs && n > 0) {
      breaks.push(n);
    }
    out[n * 2] = t;
    out[n * 2 + 1] = data[off + 1]!;
    prevT = t;
    n++;
  }
  return n;
}
