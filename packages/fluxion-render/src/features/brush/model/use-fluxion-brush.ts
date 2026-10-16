import { useCallback, useEffect, useRef, useState } from "react";
import type { FluxionHost } from "../../host";

export interface BrushSelection {
  /** Host-relative ms of selection start. */
  tStart: number;
  /** Host-relative ms of selection end. */
  tEnd: number;
}

export interface UseFluxionBrushOptions {
  host: FluxionHost | null;
  /** Called when user finishes dragging a selection. */
  onSelect?: (selection: BrushSelection) => void;
}

export interface UseFluxionBrushResult {
  /** Attach to the overlay element (e.g. an SVG). */
  brushRef: React.RefObject<SVGSVGElement>;
  /** Current selection, or null if no selection. */
  selection: BrushSelection | null;
  /** Clear the current selection. */
  clearSelection: () => void;
}

/**
 * Adds a drag-to-select brush over a FluxionCanvas.
 *
 * Mount an SVG overlay on top of the canvas and pass its ref as brushRef.
 * The hook converts pixel positions to host-relative time using x tick fractions
 * received from the worker.
 *
 * ```tsx
 * const { brushRef, selection } = useFluxionBrush({ host, onSelect });
 * <div style={{ position: "relative" }}>
 *   <FluxionCanvas ... />
 *   <FluxionBrush brushRef={brushRef} selection={selection} width={w} height={h} />
 * </div>
 * ```
 */
export function useFluxionBrush(opts: UseFluxionBrushOptions): UseFluxionBrushResult {
  const { host, onSelect } = opts;
  const brushRef = useRef<SVGSVGElement>(null!);
  const [selection, setSelection] = useState<BrushSelection | null>(null);

  // Latest x ticks from worker — used for pixel→time conversion.
  const xTicksRef = useRef<{ value: number; fraction: number }[]>([]);

  // Drag state (not React state — no re-render needed mid-drag).
  const dragRef = useRef<{ startPx: number; width: number } | null>(null);

  useEffect(() => {
    if (!host) return;
    return host.onTickUpdate((xTicks) => {
      xTicksRef.current = xTicks.map((t) => ({ value: t.value, fraction: t.fraction }));
    });
  }, [host]);

  const pxToTime = useCallback((px: number, containerWidth: number): number => {
    const ticks = xTicksRef.current;
    if (ticks.length < 2) return 0;
    const fraction = px / containerWidth;
    // Linear interpolation between bracketing ticks.
    for (let i = 0; i < ticks.length - 1; i++) {
      const a = ticks[i];
      const b = ticks[i + 1];
      if (fraction >= a.fraction && fraction <= b.fraction) {
        const t = (fraction - a.fraction) / (b.fraction - a.fraction);
        return a.value + t * (b.value - a.value);
      }
    }
    // Extrapolate past edges.
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    if (fraction < first.fraction) {
      const range = last.value - first.value;
      const fractionRange = last.fraction - first.fraction;
      return first.value + ((fraction - first.fraction) / fractionRange) * range;
    }
    const range = last.value - first.value;
    const fractionRange = last.fraction - first.fraction;
    return last.value + ((fraction - last.fraction) / fractionRange) * range;
  }, []);

  useEffect(() => {
    const svg = brushRef.current;
    if (!svg) return;

    const onMouseDown = (e: MouseEvent) => {
      const rect = svg.getBoundingClientRect();
      dragRef.current = { startPx: e.clientX - rect.left, width: rect.width };
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const rect = svg.getBoundingClientRect();
      const endPx = e.clientX - rect.left;
      const { startPx, width } = dragRef.current;
      dragRef.current = null;

      const x0 = Math.min(startPx, endPx);
      const x1 = Math.max(startPx, endPx);
      if (x1 - x0 < 4) {
        // Too small — treat as click, clear selection.
        setSelection(null);
        return;
      }

      const tStart = pxToTime(x0, width);
      const tEnd = pxToTime(x1, width);
      const sel = { tStart, tEnd };
      setSelection(sel);
      onSelect?.(sel);
    };

    svg.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      svg.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [pxToTime, onSelect]);

  const clearSelection = useCallback(() => setSelection(null), []);

  return { brushRef, selection, clearSelection };
}
