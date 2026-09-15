import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@heojeongbo/fluxion-render/react",
        replacement: path.resolve(__dirname, "../fluxion-render/src/react.ts"),
      },
      {
        find: "@heojeongbo/fluxion-render",
        replacement: path.resolve(__dirname, "../fluxion-render/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "happy-dom",
    globals: false,
    // One budget for the whole package instead of `{ timeout: 20_000 }` hand-
    // applied per test. The old scheme was applied to 9 of 831 tests and was
    // already incomplete — two tests in the very file that kept failing
    // (scenario 09's A4 and B1) never got the option and silently sat on
    // vitest's 5 s default. This is the same 20 s budget, just uniform, so a
    // new scenario test inherits it instead of needing someone to remember.
    // It is a hang detector, not a perf budget: the slowest test in the package
    // is ~2.5 s locally, and the scenario suite runs in ~1 s.
    testTimeout: 20_000,
    teardownTimeout: 10000,
    include: ["src/**/*.test.{ts,tsx}"],
    // Bench files are picked up by `vitest bench` only. Exclude here so a
    // plain `vitest run` doesn't try to execute them as regular tests.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.bench.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    benchmark: {
      include: ["src/**/*.bench.{ts,tsx}"],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.bench.{ts,tsx}",
        "src/test/**",
        "src/scenarios/_helpers.ts",
        // Test-only doubles (imported solely by *.test/*.bench). Not shipped.
        "src/**/*-fixtures.tsx",
        "src/index.ts",
        "src/react.ts",
      ],
      // Set to the measured floor, not an aspiration — the previous gates sat
      // ~9 points under actual coverage, so a sizeable regression could land
      // without CI noticing. Measured 99.03/96.73/97.32/100, stable across runs.
      thresholds: {
        lines: 100,
        statements: 99,
        branches: 96,
        functions: 97,
      },
    },
  },
});
