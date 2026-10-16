import type { RingBuffer } from "../model/ring-buffer";
import type { Viewport } from "../model/viewport";

/**
 * Sink for {@link forEachColumn}. Each visible x-pixel column that holds at
 * least one sample is reported once via `onColumn` with the column's first,
 * min-y, max-y and last sample (in time order within the column). A time gap
 * larger than `maxGapMs` closes the current column and fires `onGapBreak`
 * before the next column starts, so consumers can begin a fresh subpath.
 */
export interface ColumnSink {
  onColumn(
    colPx: number,
    firstY: number,
    minY: number,
    maxY: number,
    lastY: number,
  ): void;
  /** Optional: a time gap broke the series after the just-flushed column. */
  onGapBreak?(): void;
}

/**
 * Min/max-per-pixel-column reducer shared by the streaming layers' decimated
 * draw paths. Walks a stride-2 `[t, y]` ring in chronological order, buckets
 * samples by integer x-pixel, and reports one aggregate per column — turning an
 * O(samples) draw into O(visible pixels) while preserving every peak/trough at
 * display resolution.
 *
 * Pure orchestration: it performs no canvas work. Each layer's `onColumn`
 * decides how to render the aggregate (connected line, stair, filled area,
 * scattered points).
 *
 * @param ring     stride-2 ring of `[t, y]` records
 * @param viewport supplies `xToPx`
 * @param xMin     left edge of the visible time window; older samples are skipped
 * @param gap      max ms between consecutive samples before the series breaks
 *                 (undefined = never break)
 */
export function forEachColumn(
  ring: RingBuffer,
  viewport: Viewport,
  xMin: number,
  gap: number | undefined,
  sink: ColumnSink,
): void {
  let curCol = Number.NaN;
  let firstY = 0;
  let minY = 0;
  let maxY = 0;
  let lastY = 0;
  let prevT = Number.NaN;

  ring.forEachRange(
    xMin,
    viewport.bounds.xMax,
    (data, off) => {
      const t = data[off]!;
      const y = data[off + 1]!;

      // Gap: close the pre-gap column, then signal a subpath break so the next
      // emitted column starts fresh. Resetting curCol makes the column-change
      // branch below start a new column without a duplicate flush. curCol is
      // always set here — reaching this branch requires a prior in-window sample
      // (prevT non-NaN), which necessarily assigned curCol below.
      if (gap !== undefined && !Number.isNaN(prevT) && t - prevT > gap) {
        sink.onColumn(curCol, firstY, minY, maxY, lastY);
        curCol = Number.NaN;
        sink.onGapBreak?.();
      }

      const col = Math.floor(viewport.xToPx(t));
      if (col !== curCol) {
        if (!Number.isNaN(curCol)) sink.onColumn(curCol, firstY, minY, maxY, lastY);
        curCol = col;
        firstY = y;
        minY = y;
        maxY = y;
      } else {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      lastY = y;
      prevT = t;
    },
    true,
  );

  if (!Number.isNaN(curCol)) sink.onColumn(curCol, firstY, minY, maxY, lastY);
}
