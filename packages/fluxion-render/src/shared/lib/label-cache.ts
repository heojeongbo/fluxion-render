/**
 * Label-sprite cache: render each label string ONCE onto a tiny OffscreenCanvas
 * and blit it with `drawImage` on subsequent frames, instead of re-rasterizing
 * the text with `fillText` every frame. Canvas text rasterization is the
 * dominant per-render cost for axis labels in Firefox (attribution-bench:
 * the external-axis subsystem ≈ 43% of worker busy at 60 charts × 25 Hz);
 * a canvas→canvas blit is the accelerated path.
 *
 * Correctness properties:
 * - The requested `textBaseline` is baked INTO the sprite raster, so the
 *   browser's own font-metric baseline math is captured — the blit is a pure
 *   translation and vertical placement is exact for top/middle/bottom.
 * - Horizontal center/right alignment reproduces fillText's advance-width
 *   offset using the same `measureText` number.
 * - Blit positions snap to the device-pixel grid so the sprite lands 1:1
 *   (no bilinear resample blur); labels step whole device pixels under
 *   scroll instead of AA-smearing. Quantization ≤ 0.5 device px.
 * - On ANY sprite-path failure (no OffscreenCanvas, null/throwing context)
 *   the call degrades to a verbatim `ctx.fillText(text, x, y)` — pixel-
 *   identical to the pre-sprite rendering — and sprite support latches off
 *   for this worker's lifetime (safe direction: correct but slower).
 *
 * Bounded memory: style buckets (font|color|baseline|dpr) hold per-text LRUs.
 * A streaming clock axis mints ~1 new label string per second; the per-style
 * LRU evicts the oldest label at the cap, and rarely-used style buckets are
 * evicted wholesale at the bucket cap. Realistic steady state is well under
 * 2 MB of sprite backing. The cache is module-level and deliberately survives
 * engine RESET (recycled hosts with the same style reuse warm sprites —
 * same lifetime model as the colormap LUT caches).
 */

export interface LabelOpts {
  /**
   * Must equal the target ctx's CURRENT `font`/`fillStyle` — call sites keep
   * setting ctx state exactly as before, and the fillText fallback relies on
   * it to stay pixel-identical to the pre-sprite rendering.
   */
  font: string;
  color: string;
  align: "left" | "center" | "right";
  baseline: "top" | "middle" | "bottom";
  /** Device pixel ratio; non-positive values are treated as 1. */
  dpr: number;
}

interface Sprite {
  canvas: OffscreenCanvas;
  textW: number;
  cssW: number;
  cssH: number;
  /** y of the text anchor inside the sprite, in CSS px (baseline-dependent). */
  yAnchor: number;
}

/** Horizontal/vertical outer padding around the glyphs, CSS px. */
export const LABEL_PAD = 1;
/** Per-style LRU capacity (a scrolling clock axis mints ~1 label/sec). */
export const MAX_LABELS_PER_STYLE = 128;
/** Style-bucket cap — each distinct font|color|baseline|dpr combination. */
export const MAX_STYLE_BUCKETS = 16;

const buckets = new Map<string, Map<string, Sprite>>();
const meta = new WeakMap<object, { text: string; yAnchor: number }>();
// Latched false on the first sprite-creation failure: after that every call
// goes straight to the fillText fallback with no per-call ctor attempts.
let spriteSupport = true;

function makeSprite(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  opts: LabelOpts,
  dpr: number,
): Sprite | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  // measureText on the TARGET ctx — the contract guarantees its font is
  // already set, and identical font strings yield identical metrics.
  const textW = ctx.measureText(text).width;
  const fontPx = Number(/(\d+(?:\.\d+)?)px/.exec(opts.font)?.[1] ?? 11);
  // Em box + headroom beyond it in both directions so no font's ascender or
  // descender can clip; forced even so the "middle" anchor is integral.
  const extra = Math.ceil(fontPx * 0.25);
  let boxH = Math.ceil(fontPx * 1.4);
  if (boxH % 2 === 1) boxH += 1;
  const cssH = boxH + 2 * (LABEL_PAD + extra);
  const cssW = textW + 2 * LABEL_PAD;
  try {
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.ceil(cssW * dpr)),
      Math.max(1, Math.ceil(cssH * dpr)),
    );
    const sctx = canvas.getContext("2d");
    if (!sctx) return null;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.font = opts.font;
    sctx.fillStyle = opts.color;
    sctx.textAlign = "left";
    sctx.textBaseline = opts.baseline;
    const yAnchor =
      opts.baseline === "top"
        ? LABEL_PAD + extra
        : opts.baseline === "middle"
          ? cssH / 2
          : cssH - LABEL_PAD - extra;
    sctx.fillText(text, LABEL_PAD, yAnchor);
    const sprite: Sprite = { canvas, textW, cssW, cssH, yAnchor };
    meta.set(canvas as unknown as object, { text, yAnchor });
    return sprite;
  } catch {
    return null;
  }
}

/**
 * Draw `text` anchored at CSS-px (x, y) with fillText-equivalent placement.
 * Looks up (or rasterizes once) the sprite for (font, color, baseline, dpr,
 * text) and blits it; on sprite failure falls back to a verbatim
 * `ctx.fillText(text, x, y)` inheriting the caller's ctx state.
 * Never mutates the target ctx state.
 */
export function drawLabel(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: LabelOpts,
): void {
  if (!spriteSupport) {
    ctx.fillText(text, x, y);
    return;
  }
  const dpr = opts.dpr > 0 ? opts.dpr : 1;
  const styleKey = `${dpr}|${opts.baseline}|${opts.font}|${opts.color}`;
  let bucket = buckets.get(styleKey);
  if (bucket) {
    // Bucket LRU: refresh recency on access.
    buckets.delete(styleKey);
    buckets.set(styleKey, bucket);
  } else {
    bucket = new Map<string, Sprite>();
    if (buckets.size >= MAX_STYLE_BUCKETS) {
      buckets.delete(buckets.keys().next().value as string);
    }
    buckets.set(styleKey, bucket);
  }
  let sprite = bucket.get(text);
  if (sprite) {
    // Per-text LRU: re-insert on hit.
    bucket.delete(text);
    bucket.set(text, sprite);
  } else {
    const made = makeSprite(ctx, text, opts, dpr);
    if (!made) {
      spriteSupport = false;
      ctx.fillText(text, x, y);
      return;
    }
    sprite = made;
    if (bucket.size >= MAX_LABELS_PER_STYLE) {
      bucket.delete(bucket.keys().next().value as string);
    }
    bucket.set(text, sprite);
  }
  const dxRaw =
    x -
    LABEL_PAD -
    (opts.align === "center"
      ? sprite.textW / 2
      : opts.align === "right"
        ? sprite.textW
        : 0);
  const dyRaw = y - sprite.yAnchor;
  // Device-grid snap: a 1:1 device-pixel copy, crisper than a resampled blit.
  const dx = Math.round(dxRaw * dpr) / dpr;
  const dy = Math.round(dyRaw * dpr) / dpr;
  ctx.drawImage(sprite.canvas, dx, dy, sprite.cssW, sprite.cssH);
}

/** Test seam: the label text a sprite canvas was rasterized with. */
export function labelOf(canvas: object): string | undefined {
  return meta.get(canvas)?.text;
}

/** Test seam: sprite meta (text + anchor y) for reconstructing anchor coords. */
export function labelMetaOf(
  canvas: object,
): { text: string; yAnchor: number } | undefined {
  return meta.get(canvas);
}

/** Test-only: drop every sprite and re-arm sprite support. */
export function resetLabelCache(): void {
  buckets.clear();
  spriteSupport = true;
}
