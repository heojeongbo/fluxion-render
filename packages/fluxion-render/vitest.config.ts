import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/test/**",
        "src/index.ts",
        "src/react.ts",
        "src/app/worker/fluxion-worker.ts",
        // Browser-only Worker factory (`new URL(import.meta.url)`) — untestable in node.
        "src/app/worker/create-worker-factory.ts",
      ],
      // Regression suites exercise every measured statement, branch, function and line.
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
});
