/**
 * CPU side of the WebGL line path: walk a stride-2 `[t, y]` ring
 * chronologically into a caller-owned vertex scratch, filtering samples left
 * of the visible window and splitting the strip at time gaps (`maxGapMs`).
 * Pure and closure-free — an indexed loop over the ring's public backing.
 */
import type { RingBuffer } from "../model/ring-buffer";

/**
 * Fill `out` with visible `[t - xMin, y]` pairs and `breaks` with the vertex
 * indices that START a new strip (index 0 is implicit and never included).
 * Returns the vertex count written. `out` must hold `ring.capacity * 2` floats;
 * `breaks` is cleared and refilled.
 *
 * The x coordinate is stored as a **delta from `xMin`**, not raw `t`. All kept
 * samples satisfy `t >= xMin`, so the delta is in `[0, window]` (tens of
 * thousands of ms at most) and survives the fp32 VBO cast at full precision —
 * whereas a raw `t` in the millions (host-relative ms of a long-lived page)
 * loses sub-ms detail to fp32, and the shader's `aPos - uOrigin` subtraction of
 * two near-equal large values cannot recover it. The paired transform
 * (`dataToClip`/`laneToClip`) sets its x-origin to 0 to match, so the final clip
 * position is algebraically identical to the raw form — only precision changes.
 * The gap split still compares raw `t` (an absolute-ms interval, origin-free).
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
    out[n * 2] = t - xMin; // xMin-relative delta — keeps fp32 precision (see above)
    out[n * 2 + 1] = data[off + 1]!;
    prevT = t;
    n++;
  }
  return n;
}
