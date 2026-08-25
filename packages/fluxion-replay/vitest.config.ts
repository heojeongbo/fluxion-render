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
