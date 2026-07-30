/**
 * CSS color string → straight-alpha `[r, g, b, a]` floats in [0, 1], for the
 * WebGL backend (clear color, line/grid color uniforms). Supports the color
 * forms this library actually emits or documents: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb(r, g, b)`, `rgba(r, g, b, a)`. Anything else returns
 * `null` — the caller decides the fallback (the GlRenderer warns once and
 * paints opaque white).
 *
 * Results are memoized per input string (charts re-parse the same handful of
 * colors every frame); the cache is capped so adversarial dynamic strings
 * can't grow it unboundedly.
 */

export type Rgba = readonly [r: number, g: number, b: number, a: number];

const MAX_CACHE = 256;
const cache = new Map<string, Rgba | null>();

const RGB_FN =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/;

function parse(s: string): Rgba | null {
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16) / 255;
      const g = Number.parseInt(hex[1]! + hex[1]!, 16) / 255;
      const b = Number.parseInt(hex[2]! + hex[2]!, 16) / 255;
      const a = hex.length === 4 ? Number.parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
      const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
      const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    return null;
  }
  const m = RGB_FN.exec(s);
  if (!m) return null;
  const r = Number(m[1]) / 255;
  const g = Number(m[2]) / 255;
  const b = Number(m[3]) / 255;
  const a = m[4] !== undefined ? Number(m[4]) : 1;
  if (r > 1 || g > 1 || b > 1 || !(a >= 0 && a <= 1)) return null;
  return [r, g, b, a];
}

/** Parse a CSS color into straight-alpha RGBA floats; `null` when unsupported. */
export function parseColor(s: string): Rgba | null {
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  const parsed = parse(s.trim());
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(s, parsed);
  return parsed;
}

/** Test-only: drop the memo cache. */
export function resetParseColorCache(): void {
  cache.clear();
}
