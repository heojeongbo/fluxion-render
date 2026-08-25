import { type RefObject, useEffect, useRef } from "react";
import type { AxisTick } from "../../../shared/lib/axis-ticks";
import { currentDpr } from "../../../shared/lib/current-dpr";

export interface AxisCanvasOptions {
  /** Tick label + tick line color. Default "#666". */
  color?: string;
  /** Tick label font. Default "11px sans-serif". */
  font?: string;
  /** Length of tick marks in px. Default 6 (Recharts default). 0 to hide. */
  tickSize?: number;
  /** Gap between tick mark end and label text in px. Default 4. */
  tickMargin?: number;
}

const DEFAULT_COLOR = "#666";
const DEFAULT_FONT = "11px sans-serif";
const DEFAULT_TICK_SIZE = 6;
const DEFAULT_TICK_MARGIN = 4;

interface ResolvedOpts {
  color: string;
  font: string;
  tickSize: number;
  tickMargin: number;
}

function resolveOpts(o: AxisCanvasOptions = {}): ResolvedOpts {
  return {
    color: o.color ?? DEFAULT_COLOR,
    font: o.font ?? DEFAULT_FONT,
    tickSize: o.tickSize ?? DEFAULT_TICK_SIZE,
    tickMargin: o.tickMargin ?? DEFAULT_TICK_MARGIN,
  };
}

function redraw(
  canvas: HTMLCanvasElement,
  ticksRef: { current: AxisTick[] },
  optsRef: { current: ResolvedOpts },
  drawFn: (
    ctx: CanvasRenderingContext2D,
    ticks: AxisTick[],
    rect: DOMRect,
    opts: ResolvedOpts,
  ) => void,
): void {
  const dpr = currentDpr();
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  // Only reassign canvas.width/height when the size actually changes.
  // Reassigning always resets the context and is expensive.
  const sizeChanged = canvas.width !== targetW || canvas.height !== targetH;
  if (sizeChanged) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (sizeChanged) ctx.scale(dpr, dpr);
  drawFn(ctx, ticksRef.current ?? [], rect, optsRef.current);
}

/**
 * Draws y-axis tick labels + tick marks on a canvas (right-aligned).
 * Place to the LEFT of the chart with matching height.
 *
 * Layout within the canvas (left → right):
 *   [label text] [tickMargin] [tick line] |rightEdge
 *
 * Matches Recharts' CartesianAxis (orientation="left"):
 *   stroke #666, tickSize 6, tickMargin 4, labels right-aligned.
 */
export function useYAxisCanvas(
  ticks: AxisTick[],
  options: AxisCanvasOptions = {},
): RefObject<HTMLCanvasElement> {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resolved = resolveOpts(options);

  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const optsRef = useRef(resolved);
  optsRef.current = resolved;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => redraw(canvas, ticksRef, optsRef, drawY));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) redraw(canvas, ticksRef, optsRef, drawY);
  }, [ticks, resolved.color, resolved.font, resolved.tickSize, resolved.tickMargin]);

  return canvasRef;
}

/**
 * Draws x-axis tick labels + tick marks on a canvas (centered).
 * Place BELOW the chart with matching width.
 *
 * Layout within the canvas (top → bottom):
 *   topEdge| [tick line] [tickMargin] [label text]
 */
export function useXAxisCanvas(
  ticks: AxisTick[],
  options: AxisCanvasOptions = {},
): RefObject<HTMLCanvasElement> {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resolved = resolveOpts(options);

  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const optsRef = useRef(resolved);
  optsRef.current = resolved;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => redraw(canvas, ticksRef, optsRef, drawX));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) redraw(canvas, ticksRef, optsRef, drawX);
  }, [ticks, resolved.color, resolved.font, resolved.tickSize, resolved.tickMargin]);

  return canvasRef;
}

// Must match the `yPad` constant in FluxionCanvas so grid lines and
// tick labels are pixel-aligned.
const Y_PAD = 8;

function drawY(
  ctx: CanvasRenderingContext2D,
  ticks: AxisTick[],
  rect: DOMRect,
  opts: ResolvedOpts,
): void {
  const { width: w, height: h } = rect;
  ctx.clearRect(0, 0, w, h);
  const { color, font, tickSize, tickMargin } = opts;

  // Inset fraction mapping by Y_PAD at top and bottom — same padding the
  // chart canvas applies via CSS so tick marks align with grid lines.
  const usableH = h - Y_PAD * 2;

  // Tick marks
  if (tickSize > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const tick of ticks) {
      const y = Math.round(Y_PAD + (1 - tick.fraction) * usableH) + 0.5;
      ctx.moveTo(w - tickSize, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  // Labels
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const labelX = w - tickSize - tickMargin;
  for (const tick of ticks) {
    const y = Y_PAD + (1 - tick.fraction) * usableH;
    ctx.fillText(tick.label, labelX, y);
  }
}

function drawX(
  ctx: CanvasRenderingContext2D,
  ticks: AxisTick[],
  rect: DOMRect,
  opts: ResolvedOpts,
): void {
  const { width: w, height: h } = rect;
  ctx.clearRect(0, 0, w, h);
  const { color, font, tickSize, tickMargin } = opts;

  // Ticks span the full canvas width. (An older comment here claimed
  // `FluxionCanvas` widened this canvas with negative CSS margins so the
  // first/last labels wouldn't clip — it doesn't, and never did: the axis
  // canvas shares the chart's `1fr` grid column.)

  // Tick marks: short vertical lines at the top edge
  if (tickSize > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const tick of ticks) {
      const x = Math.round(tick.fraction * w) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, tickSize);
    }
    ctx.stroke();
  }

  // Labels: centered below tick mark
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelY = tickSize + tickMargin;
  for (const tick of ticks) {
    const x = tick.fraction * w;
    ctx.fillText(tick.label, x, labelY);
  }
}
