import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AxisStyle } from "../../../shared/protocol";

/**
 * The subset of host options a theme controls. Both are already reactively
 * reconciled to a live host (see `use-fluxion-canvas`), so changing the theme
 * re-themes every mounted chart WITHOUT a remount. Extend cautiously — only add
 * fields the host applies at runtime, not construction-fixed ones.
 */
export interface FluxionTheme {
  /** Canvas background, filled every frame before layers draw. */
  bgColor?: string;
  /** External / inline axis tick + label styling. */
  axisStyle?: AxisStyle;
}

export type FluxionThemeMode = "light" | "dark" | "system";
type ResolvedMode = "light" | "dark";

/** Built-in dark preset — its bgColor matches the engine's own default. */
export const darkTheme: FluxionTheme = {
  bgColor: "#0b0d12",
  axisStyle: { color: "#8a8f98", bgColor: "#0b0d12" },
};

/** Built-in light preset — the counterpart used on a light/dark toggle. */
export const lightTheme: FluxionTheme = {
  bgColor: "#ffffff",
  axisStyle: { color: "#555b66", bgColor: "#ffffff" },
};

export interface FluxionThemeContextValue {
  /** The resolved theme object charts consume (merged preset + overrides). */
  theme: FluxionTheme;
  /** The current mode setting (may be "system"). */
  mode: FluxionThemeMode;
  /** The concrete light/dark this resolves to (never "system"). */
  resolvedMode: ResolvedMode;
  /** Switch modes — the batteries-included way to build a theme toggle. */
  setMode: (mode: FluxionThemeMode) => void;
}

const FluxionThemeContext = createContext<FluxionThemeContextValue | null>(null);

/**
 * The full theme control surface. Throws outside a {@link FluxionThemeProvider}
 * so a missing provider is a loud mistake, not a silent no-op.
 */
export function useFluxionTheme(): FluxionThemeContextValue {
  const ctx = useContext(FluxionThemeContext);
  if (!ctx) {
    throw new Error("useFluxionTheme must be used within a <FluxionThemeProvider>");
  }
  return ctx;
}

/**
 * Internal: the resolved theme object, or `null` when no provider is mounted.
 * Read by `useFluxionCanvas` as the option-merge base — null-safe so charts
 * outside a provider behave exactly as before (no theme layer).
 */
export function useFluxionThemeValueOrNull(): FluxionTheme | null {
  return useContext(FluxionThemeContext)?.theme ?? null;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Read the OS color-scheme preference; defaults to light where unavailable (SSR). */
function systemPrefersDark(): boolean {
  /* v8 ignore start -- the no-matchMedia (SSR) arm is unreachable in the DOM test env */
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  /* v8 ignore stop */
  return window.matchMedia(DARK_QUERY).matches;
}

export interface FluxionThemeProviderProps {
  children: ReactNode;
  /**
   * Initial mode. `"system"` (default) follows the OS `prefers-color-scheme`
   * and updates live when it changes. `setMode` switches at runtime.
   */
  defaultMode?: FluxionThemeMode;
  /**
   * Override the built-in presets. A partial merges OVER the matching built-in,
   * so `{ dark: { bgColor: "#101418" } }` keeps the default dark axis style.
   */
  themes?: { light?: Partial<FluxionTheme>; dark?: Partial<FluxionTheme> };
  /** Notified whenever the mode changes (toggle or a live system change). */
  onModeChange?: (mode: FluxionThemeMode) => void;
}

/**
 * App-wide chart theming. The first React Context in the library: supplies
 * `bgColor` + `axisStyle` as the option-merge BASE for every {@link FluxionCanvas}
 * underneath it (precedence: theme < per-chart `hostOptions` < axis props), so a
 * dark/light switch re-themes all charts at once without threading colors through
 * each one. Because those two fields are reactively reconciled, no chart remounts.
 *
 * Batteries included: `defaultMode="system"` tracks `prefers-color-scheme` and
 * follows OS changes live; `setMode` (from {@link useFluxionTheme}) drives a
 * manual toggle. Supply `themes` to customize the palettes.
 */
export function FluxionThemeProvider({
  children,
  defaultMode = "system",
  themes,
  onModeChange,
}: FluxionThemeProviderProps): ReactNode {
  const [mode, setModeState] = useState<FluxionThemeMode>(defaultMode);
  // Tracks the live OS preference; only consulted while mode === "system".
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    /* v8 ignore start -- SSR / ancient-browser arm unreachable in the DOM test env */
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    /* v8 ignore stop */
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystemDark(mql.matches);
    onChange(); // resync in case the preference changed before this effect ran
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const setMode = useMemo(
    () => (next: FluxionThemeMode) => {
      setModeState(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  const value = useMemo<FluxionThemeContextValue>(() => {
    const resolvedMode: ResolvedMode =
      mode === "system" ? (systemDark ? "dark" : "light") : mode;
    const base = resolvedMode === "dark" ? darkTheme : lightTheme;
    const override = resolvedMode === "dark" ? themes?.dark : themes?.light;
    // Deep-merge axisStyle so an override that sets only `color` keeps the
    // preset's `bgColor` (both built-in presets always carry an axisStyle).
    const theme: FluxionTheme = override
      ? { ...base, ...override, axisStyle: { ...base.axisStyle, ...override.axisStyle } }
      : base;
    return { theme, mode, resolvedMode, setMode };
  }, [mode, systemDark, themes, setMode]);

  return (
    <FluxionThemeContext.Provider value={value}>{children}</FluxionThemeContext.Provider>
  );
}
