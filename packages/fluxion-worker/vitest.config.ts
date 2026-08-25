import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/index.ts", "src/react.ts"],
      // Set to the measured floor, not an aspiration: a gate below actual
      // coverage lets a regression through silently. Measured 100/95.05/100/100
      // and stable across runs, so `branches` sits one point under to absorb
      // v8's phantom "implicit else" on `if` without `else` (same reason
      // render's branch gate is 98, see its config).
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 95,
        statements: 100,
      },
    },
  },
});
