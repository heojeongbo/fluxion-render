import { type RefObject, useEffect, useRef } from "react";
import { observeResize, onDprChange } from "../../../shared/lib/resize-observer";

export interface ResizeInfo {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Observes element size (ResizeObserver) and devicePixelRatio changes
 * (matchMedia on the current DPR). Fires `onResize` whenever either changes.
 *
 * The size is read from the **ResizeObserver entry** the browser already
 * computed (`contentRect`), NOT a synchronous `getBoundingClientRect()`. That
 * matters when many charts mount in one commit: a per-mount layout READ
 * interleaved with each chart's canvas APPEND would force one reflow per chart
 * (layout thrashing). Reading from the entry lets the browser batch the
 * measurement, so a burst of mounts can't thrash. (The chart containers carry no
 * border/padding, so `contentRect` equals the old bounding-rect size.)
 *
 * `debounceMs` (default 100) batches rapid changes; the FIRST measurement fires
 * promptly so a chart sizes without waiting out the debounce.
 */
export function useResizeObserver(
  ref: RefObject<HTMLElement>,
  onResize: (info: ResizeInfo) => void,
  opts?: { debounceMs?: number },
): void {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const debounceMs = opts?.debounceMs ?? 100;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Cached from the latest ResizeObserver entry so a DPR change can re-fire
    // with the current size (DPR changes don't trigger the ResizeObserver).
    let lastWidth = 0;
    let lastHeight = 0;
    let measured = false;

    const emit = () => {
      if (cancelled || !measured) return;
      onResizeRef.current({
        width: lastWidth,
        height: lastHeight,
        dpr: window.devicePixelRatio || 1,
      });
    };

    const debouncedEmit =
      debounceMs > 0
        ? () => {
            clearTimeout(timer);
            timer = setTimeout(emit, debounceMs);
          }
        : emit;

    // Shared ResizeObserver + DPR watcher (one of each page-wide) instead of a
    // per-chart pair. The first measurement fires immediately; later ones and
    // DPR changes go through the debounce.
    const unobserve = observeResize(el, ({ width, height }) => {
      lastWidth = width;
      lastHeight = height;
      if (measured) {
        debouncedEmit();
      } else {
        measured = true;
        emit();
      }
    });
    const unwatchDpr = onDprChange(debouncedEmit);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unobserve();
      unwatchDpr();
    };
  }, [ref]);
}
