/**
 * CPU-side geometry for the WebGL grid/axis path: an append-only CSS-px line
 * SEGMENT list (drawn as gl.LINES) plus the pixel-centering snap shared with
 * the 2d stroke path.
 */

/**
 * Center a 1px-class line on the pixel grid — EXACTLY the 2d path's
 * `Math.round(px) + 0.5`, so GL grid/tick lines land on the same pixels the
 * canvas2d stroke covers.
 */
export function snapCenter(px: number): number {
  return Math.round(px) + 0.5;
}

/**
 * Reusable [x1,y1,x2,y2]* segment accumulator. `seg()` appends one segment
 * (two gl.LINES vertices); the backing store doubles on demand and is reused
 * across frames (call `reset()` per frame; capacity never shrinks).
 */
export class LineListBuilder {
  verts = new Float32Array(64);
  /** Vertex count (2 per segment) — pass to `drawLineList`. */
  count = 0;

  reset(): void {
    this.count = 0;
  }

  seg(x1: number, y1: number, x2: number, y2: number): void {
    const need = (this.count + 2) * 2;
    if (need > this.verts.length) {
      const grown = new Float32Array(Math.max(need, this.verts.length * 2));
      grown.set(this.verts);
      this.verts = grown;
    }
    const off = this.count * 2;
    this.verts[off] = x1;
    this.verts[off + 1] = y1;
    this.verts[off + 2] = x2;
    this.verts[off + 3] = y2;
    this.count += 2;
  }
}
