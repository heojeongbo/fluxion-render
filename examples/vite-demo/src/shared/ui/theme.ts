/**
 * Light-mode palette for the demo app.
 *
 * All colors are centralized here so every page/component imports from the
 * same source. Flip a value here and the whole app follows — the only other
 * place colors live is `index.html` for the initial page paint.
 *
 * The `chart.*` values are intended to be passed to the library (both to
 * `FluxionHostOptions.bgColor` and to `AxisGridConfig` {gridColor, axisColor,
 * labelColor}), so canvas content is consistent with surrounding UI.
 *
 * Series data colors (#4fc3f7, #80ffa0, #ffb060) are still set per-layer in
 * each demo — they're bright accents that read well on any background.
 */
export const THEME = {
  page: {
    background: "#f8f9fb",
    border: "#e3e6ec",
    textPrimary: "#1b1f2a",
    textSecondary: "#5a6a80",
    textMuted: "#8592a8",
  },
  button: {
    background: "#4a6db8",
    text: "#ffffff",
    border: "#4a6db8",
    inactiveBackground: "transparent",
    inactiveText: "#1b1f2a",
    inactiveBorder: "#e3e6ec",
  },
  panel: {
    background: "#ffffff",
    border: "#e3e6ec",
  },
  chart: {
    canvasBg: "#ffffff",
    gridColor: "#cccccc",
    axisColor: "#666666",
    labelColor: "#666666",
  },
} as const;

/**
 * Same SHAPE as {@link THEME}, but every colour widened to `string`.
 *
 * `THEME` is `as const`, so `typeof THEME` gives literal types ("#f8f9fb" &c.)
 * — a `DemoTheme` could then only ever hold the light palette's exact values,
 * and `THEME_DARK` below wouldn't type-check. Vite doesn't type-check on build,
 * so this went unnoticed until the examples were added to `pnpm typecheck`.
 */
export type DemoTheme = {
  readonly [Section in keyof typeof THEME]: {
    readonly [Token in keyof (typeof THEME)[Section]]: string;
  };
};

/**
 * Dark counterpart to {@link THEME}, same shape. The `chart.*` values are what
 * you'd hand the library on a dark theme; because worker-rendered canvas pixels
 * can't read CSS, you switch these JS values (or resolve your CSS tokens on the
 * main thread) and pass them to `FluxionHostOptions.bgColor` / `<FluxionCanvas
 * axisColor>` / the `axis-grid` layer config — see the Theme Switch demo. Series
 * colors (#4fc3f7…) stay identical across themes: they're identity accents.
 */
export const THEME_DARK: DemoTheme = {
  page: {
    background: "#0b0d12",
    border: "#20242e",
    textPrimary: "#e6e9ef",
    textSecondary: "#9aa6ba",
    textMuted: "#6b7688",
  },
  button: {
    background: "#4a6db8",
    text: "#ffffff",
    border: "#4a6db8",
    inactiveBackground: "transparent",
    inactiveText: "#e6e9ef",
    inactiveBorder: "#20242e",
  },
  panel: {
    background: "#12151c",
    border: "#20242e",
  },
  chart: {
    canvasBg: "#0f1218",
    gridColor: "#2a2f3a",
    axisColor: "#8592a8",
    labelColor: "#8592a8",
  },
} as const;
