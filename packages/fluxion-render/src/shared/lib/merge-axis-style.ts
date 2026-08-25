import type { AxisStyle } from "../protocol";

/**
 * Layer {@link AxisStyle} fragments, later ones winning per FIELD.
 *
 * `axisStyle` is the one host option that must MERGE rather than replace.
 * Everything else in `FluxionHostOptions` is a scalar, so the usual
 * `{ ...defaults, ...theme, ...hostOptions }` spread is right for it — but for
 * a nested object that spread makes the last writer erase the whole thing.
 * `<FluxionCanvas>` builds an `axisStyle` from its four `axis*` props on every
 * render, so it ALWAYS supplies the key — all-`undefined` when the caller
 * passed no axis props. A plain spread therefore erased a
 * `FluxionThemeProvider`'s palette outright, and since the engine skips
 * `undefined` fields the worker just kept its built-in #666: a light/dark
 * toggle changed `bgColor` and nothing else.
 *
 * `undefined` fields are skipped rather than assigned, so a partial override
 * (`axisColor` alone) keeps the theme's remaining fields. Returns `undefined`
 * when no fragment contributed anything, so callers can leave the key off
 * entirely instead of posting an all-`undefined` style.
 */
export function mergeAxisStyle(
  ...parts: (AxisStyle | undefined)[]
): AxisStyle | undefined {
  let out: AxisStyle | undefined;
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (v === undefined) continue;
      out ??= {};
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
