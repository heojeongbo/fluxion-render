import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  darkTheme,
  FluxionThemeProvider,
  type FluxionThemeProviderProps,
  lightTheme,
  useFluxionTheme,
  useFluxionThemeValueOrNull,
} from "./theme-context";

// A controllable prefers-color-scheme matchMedia stub.
let systemDark: boolean;
let mediaListeners: Array<() => void>;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  systemDark = false;
  mediaListeners = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    // Live getter — real `.matches` reflects the current preference, not a snapshot.
    get matches() {
      return query.includes("dark") ? systemDark : false;
    },
    media: query,
    addEventListener: (_t: string, cb: () => void) => mediaListeners.push(cb),
    removeEventListener: (_t: string, cb: () => void) => {
      mediaListeners = mediaListeners.filter((l) => l !== cb);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

/** Flip the OS preference and fire the registered media listeners. */
function setSystemDark(next: boolean) {
  systemDark = next;
  act(() => {
    for (const l of [...mediaListeners]) l();
  });
}

function wrapper(props: Omit<FluxionThemeProviderProps, "children">) {
  return ({ children }: { children: ReactNode }) => (
    <FluxionThemeProvider {...props}>{children}</FluxionThemeProvider>
  );
}

describe("FluxionThemeProvider / useFluxionTheme", () => {
  it("throws when used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useFluxionTheme())).toThrow(/FluxionThemeProvider/);
    spy.mockRestore();
  });

  it("useFluxionThemeValueOrNull is null with no provider, the theme within", () => {
    const { result: outside } = renderHook(() => useFluxionThemeValueOrNull());
    expect(outside.current).toBeNull();

    const { result: inside } = renderHook(() => useFluxionThemeValueOrNull(), {
      wrapper: wrapper({ defaultMode: "dark" }),
    });
    expect(inside.current).toEqual(darkTheme);
  });

  it("supplies the dark/light preset for an explicit mode", () => {
    const dark = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({ defaultMode: "dark" }),
    });
    expect(dark.result.current.resolvedMode).toBe("dark");
    expect(dark.result.current.theme).toEqual(darkTheme);

    const light = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({ defaultMode: "light" }),
    });
    expect(light.result.current.resolvedMode).toBe("light");
    expect(light.result.current.theme).toEqual(lightTheme);
  });

  it("resolves 'system' from prefers-color-scheme and follows live changes", () => {
    systemDark = true;
    const { result } = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({ defaultMode: "system" }),
    });
    expect(result.current.mode).toBe("system");
    expect(result.current.resolvedMode).toBe("dark");
    expect(result.current.theme).toEqual(darkTheme);

    setSystemDark(false);
    expect(result.current.resolvedMode).toBe("light");
    expect(result.current.theme).toEqual(lightTheme);
  });

  it("setMode switches and fires onModeChange", () => {
    const onModeChange = vi.fn();
    const { result } = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({ defaultMode: "light", onModeChange }),
    });
    expect(result.current.resolvedMode).toBe("light");
    act(() => result.current.setMode("dark"));
    expect(result.current.mode).toBe("dark");
    expect(result.current.resolvedMode).toBe("dark");
    expect(result.current.theme).toEqual(darkTheme);
    expect(onModeChange).toHaveBeenCalledWith("dark");
  });

  it("a 'system' resolver ignores OS changes once switched to an explicit mode", () => {
    const { result } = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({ defaultMode: "system" }),
    });
    act(() => result.current.setMode("light"));
    setSystemDark(true); // OS goes dark, but we're pinned to light
    expect(result.current.resolvedMode).toBe("light");
  });

  it("merges a partial theme override over the preset (deep axisStyle)", () => {
    const { result } = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({
        defaultMode: "dark",
        themes: { dark: { bgColor: "#101418", axisStyle: { color: "#abc" } } },
      }),
    });
    expect(result.current.theme.bgColor).toBe("#101418"); // overridden
    // axisStyle deep-merges: overridden color, preset bgColor retained.
    expect(result.current.theme.axisStyle).toEqual({
      color: "#abc",
      bgColor: darkTheme.axisStyle?.bgColor,
    });
  });

  it("an override without axisStyle keeps the preset axisStyle", () => {
    const { result } = renderHook(() => useFluxionTheme(), {
      wrapper: wrapper({
        defaultMode: "light",
        themes: { light: { bgColor: "#fafafa" } },
      }),
    });
    expect(result.current.theme.bgColor).toBe("#fafafa");
    expect(result.current.theme.axisStyle).toEqual(lightTheme.axisStyle);
  });

  it("renders its children", () => {
    const { getByText } = render(
      <FluxionThemeProvider defaultMode="dark">
        <span>themed child</span>
      </FluxionThemeProvider>,
    );
    expect(getByText("themed child")).toBeTruthy();
  });
});
