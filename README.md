# fluxion-render

[![CI](https://github.com/heojeongbo/fluxion-render/actions/workflows/ci.yml/badge.svg)](https://github.com/heojeongbo/fluxion-render/actions/workflows/ci.yml)

High-performance OffscreenCanvas rendering engine for real-time data visualization — with time-travel replay built in.

Built for robotics and sensor systems: streaming line charts, LiDAR point clouds, high-frequency data pipelines up to 120Hz+, and in-browser recording/replay of any data stream. Rendering runs entirely in Web Workers — the main thread is never blocked.

> "Data is binary. Rendering is layered. UI is optional."

---

## Install

```bash
npm install @heojeongbo/fluxion-render        # core rendering (React hooks + vanilla)
npm install @heojeongbo/fluxion-replay        # optional: time-travel recording / DVR
# fluxion-worker is a dependency of fluxion-render — install it directly only for standalone worker pools
```

React is a peer dependency (`>=18`). See each package's README for a quick start.

---

## Packages

Dependency order: **fluxion-worker ← fluxion-render ← fluxion-replay**.

| Package | Version | Description |
|---------|---------|-------------|
| [`packages/fluxion-worker`](packages/fluxion-worker) | `0.6.0` | Generic worker pool infrastructure — [`@heojeongbo/fluxion-worker`](https://www.npmjs.com/package/@heojeongbo/fluxion-worker) |
| [`packages/fluxion-render`](packages/fluxion-render) | `1.6.0` | Core rendering library — [`@heojeongbo/fluxion-render`](https://www.npmjs.com/package/@heojeongbo/fluxion-render) |
| [`packages/fluxion-replay`](packages/fluxion-replay) | `0.13.1` | Time-travel replay engine — [`@heojeongbo/fluxion-replay`](https://www.npmjs.com/package/@heojeongbo/fluxion-replay) |
| [`examples/vite-demo`](examples/vite-demo) | — | Rendering demo — a route per public layer type (line/area/step/bar/scatter/scatter-colored/candlestick/heatmap/heatmap-stream/histogram/box-plot/polar/stacked-area/event-marker/reference-line/lidar/pose-arrow/trajectory/occupancy-grid + SVG gauge/pie), DX helpers, axis formatters, crosshair/brush/export, and infrastructure routes (LiDAR 30k, 300-chart broadcast pool) |
| [`examples/fluxion-replay-demo`](examples/fluxion-replay-demo) | — | Replay demo — DVR/screen capture, metrics, logs, time-travel scrubber, plus a multi-chart DVR route with scrub-then-play UX |

---

## Architecture

```
Main Thread                          Worker Thread(s)
───────────────                      ──────────────────────────
FluxionHost × N                      FluxionWorkerPool (adaptive, auto-growing)
  │                                    │
  │──POOL_INIT (OffscreenCanvas)──────►│  Engine (one per host)
  │──ADD_LAYER ──────────────────────►│    LayerStack
  │──DATA (Float32Array transfer) ───►│      LineChartLayer
  │──RESIZE ──────────────────────────►│      LidarScatterLayer
  │──DISPOSE ─────────────────────────►│      AxisGridLayer
                                       │
                                       │  FrameDriver (ONE rAF per worker,
                                       │    idle-stop + load governors)
                                       │    scan → draw → OffscreenCanvas

Replay (main thread)
────────────────────────────────────────────────────────
ReplayRecorder ──► IndexedDB (frames, 500ms batch)
                   OPFS      (video chunks, WebCodecs)
ReplayPlayer   ──► VirtualClock (RAF) → prefetch → onFrame()
```

- All rendering runs in workers — main thread is never blocked
- `ArrayBuffer` is **transferred** (not copied) on every data push
- Charts share an **adaptive** worker pool that starts small and grows on demand toward a hardware-bound cap
- Scales to hundreds of simultaneous high-rate charts: per-frame push **coalescing**, automatic draw **decimation** (min/max envelope), cached axis ticks + label sprites, and an optional render-FPS cap (`maxFps`)
- **Load-sheds automatically under saturation**: each worker's shared frame loop throttles on JS-budget overrun or degraded rAF delivery, and the main-thread flush frame sheds data cadence under compositor pressure — skipped frames keep data latched, nothing is dropped
- One rAF loop per worker (not per chart) that stops entirely when idle; renders only when data changes (dirty flag)
- `inlineAxes` mode draws axes into main-canvas margins — ONE compositor surface per chart instead of up to three
- `renderer: 'webgl'` backend bypasses Firefox's fixed ~1 ms/render worker-canvas2d cost with GPU line/grid/label programs (Firefox-targeted)
- `pauseWhenOffscreen` stops rendering scrolled-out charts (shared IntersectionObserver) while data keeps buffering — scrolling back shows full history; −80 % to −94 % worker render time in a scroll grid
- `configureFluxionDefaults()` sets app-wide default host options (bgColor, maxFps, renderer, …) once; charts inherit them and per-chart props override — a `bgColor` default also paints the correct background on the first frame (no black flash on light themes)
- Replay stores up to 10 minutes of any stream in IndexedDB + OPFS

---

## Development

```bash
pnpm install

# Build all packages
pnpm build

# Run the rendering demo
pnpm --filter vite-demo dev

# Run the replay demo
pnpm dev:replay

# Typecheck + test all packages
pnpm typecheck
pnpm test

# Performance benchmark (headed Playwright; run `pnpm build` in examples/vite-demo first)
cd examples/vite-demo
pnpm bench --browser firefox --charts 60 --rate 25   # also: chromium; --axes inline|0; --labels 0; --maxFps N
```

---

## Testing

Each package is tested with [Vitest](https://vitest.dev) (happy-dom + a fake
OffscreenCanvas in `src/test/setup.ts`). `pnpm test` runs every package's suite.

Coverage runs **per package** (there is no root aggregate script) — build
`fluxion-render` first so `fluxion-replay` resolves it via `dist/`:

```bash
pnpm --filter @heojeongbo/fluxion-render build
cd packages/<pkg> && pnpm vitest run --coverage
```

Enforced thresholds (the authoritative source is each package's `vitest.config.ts`).
Each is set to the **measured floor**, not an aspiration — a gate below actual
coverage lets a regression through silently:

| Package | lines | statements | functions | branches |
|---------|:-----:|:----------:|:---------:|:--------:|
| `fluxion-worker` | 100 | 100 | 100 | 95 |
| `fluxion-render` | 100 | 100 | 100 | 98 |
| `fluxion-replay` | 100 | 99 | 97 | 96 |

Branch gates sit a point or two under 100 because the v8 provider emits an
untargetable phantom "implicit-else" branch on every `if` without an `else`.

`fluxion-render` and `fluxion-worker` run with coverage on every CI run (+1s
measured). `fluxion-replay` does not: v8 instrumentation triples its runtime
(12s → 40s) and that slowdown is what makes its long `scenarios/*` tests
timing-sensitive, so its coverage runs on the weekly sweep instead.

---

## Release

### fluxion-render

```bash
pnpm release:patch
pnpm release:minor
pnpm release:major
pnpm release:dry
```

### fluxion-worker

```bash
pnpm release:worker:patch
pnpm release:worker:minor
pnpm release:worker:major
pnpm release:worker:dry
```

### fluxion-replay

```bash
pnpm release:replay:patch
pnpm release:replay:minor
pnpm release:replay:major
pnpm release:replay:dry
```

**The publish happens in CI, not on your machine.** `release-it` verifies the
**whole workspace** (build → typecheck → test → lint — `fluxion-replay` imports
`fluxion-render`'s source, so a package-only gate isn't enough), bumps the
version, writes the CHANGELOG, and pushes a `fluxion-<pkg>-v<semver>` tag. That
tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which re-verifies from the lockfile and then publishes with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

It packs with pnpm and publishes with npm on purpose: only `pnpm pack` rewrites
`workspace:` ranges to real versions (`fluxion-render` depends on
`fluxion-worker` that way), and only `npm publish` emits provenance. The
workflow fails hard if a `workspace:` range survives into the tarball.

If a publish fails, the tag is still good — re-run it without re-tagging:

```bash
gh workflow run release.yml -f tag=fluxion-render-v1.6.0
```

---

## License

MIT
