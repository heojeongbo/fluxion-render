import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, "index.html"),
        reliability: path.resolve(__dirname, "reliability.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
  resolve: {
    alias: [
      // fluxion-replay: resolve from source so Vite can tree-shake and HMR
      {
        find: "@heojeongbo/fluxion-replay/react",
        replacement: path.resolve(
          __dirname,
          "../../packages/fluxion-replay/src/react.ts",
        ),
      },
      {
        find: "@heojeongbo/fluxion-replay",
        replacement: path.resolve(
          __dirname,
          "../../packages/fluxion-replay/src/index.ts",
        ),
      },
      // fluxion-render: must use pre-built dist so the Worker URL resolves correctly
      {
        find: "@heojeongbo/fluxion-render/react",
        replacement: path.resolve(
          __dirname,
          "../../packages/fluxion-render/dist/react.js",
        ),
      },
      {
        find: "@heojeongbo/fluxion-render/testing",
        replacement: path.resolve(
          __dirname,
          "../../packages/fluxion-render/dist/testing.js",
        ),
      },
      {
        find: "@heojeongbo/fluxion-render/worker",
        replacement: path.resolve(
          __dirname,
          "../../packages/fluxion-render/dist/worker.js",
        ),
      },
      {
        find: "@heojeongbo/fluxion-render",
        replacement: path.resolve(
          __dirname,
          "../../packages/fluxion-render/dist/index.js",
        ),
      },
    ],
  },
  server: {
    port: 5174,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
  },
});
