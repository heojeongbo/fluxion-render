# fluxion-render — dev guide

pnpm monorepo. Three published packages (dependency order: worker ← render ← replay):

- `packages/fluxion-worker` — worker pool / messaging primitives
- `packages/fluxion-render` — OffscreenCanvas chart engine + React hooks (`/react`, `/testing`, `/worker` subpath exports)
- `packages/fluxion-replay` — recording / DVR time-travel on top of render
- `examples/vite-demo`, `examples/fluxion-replay-demo` — demo apps (workspace-linked; they resolve packages through `dist/`, so **rebuild after changing package source** or types/runtime will be stale)

Source layout is FSD-ish: `src/{app,entities,features,widgets,shared}` with colocated `*.test.ts(x)`.

## Commands (repo root)

```bash
pnpm build       # all packages, dependency-ordered — run BEFORE test (tests resolve workspace deps via dist)
pnpm test        # vitest per package (happy-dom; fake OffscreenCanvas in src/test/setup.ts)
pnpm typecheck   # tsc --noEmit per package
pnpm dev         # vite-demo
pnpm dev:replay  # fluxion-replay-demo
pnpm lint:fix    # biome check --write . (formatter + import sort; linter disabled)

# Perf bench (headed Playwright, from examples/vite-demo after `pnpm build` there):
#   pnpm bench --browser firefox|chromium --charts 60 --rate 25 --runs 3
#   levers: --maxFps N --emitBounds 0 --axes inline|0 --labels 0 --grid 0
# Or open /bench?charts=60&rate=25 manually — results render on-page + window.__benchResult.
```

## Conventions

- Conventional commits with package scope: `feat(render): …`, `fix(replay): …`, multi-scope `feat(render,examples): …`. `examples`-only commits never trigger a release.
- Draw-path tests use the `createFakeCtx()` call-recording pattern (assert `moveTo`/`lineTo`/`stroke` counts), `renderHook` + fake timers for hooks.
- Data timestamps are host-relative ms (`Date.now() - timeOrigin`); never push absolute epoch ms (Float32 quantization).
- WebGL backend (`renderer:'webgl'`, Firefox-targeted): layers implement optional `drawGl(glr, viewport)`; `GlRenderer`/programs/transforms live in render's `src/shared/gl/`. GL draw tests use `createFakeGl()` (call-recording, `failCompile`/`failLink` knobs) via `FakeOffscreenCanvas.getContext("webgl")`; grid/label parity is asserted against the 2d path's `moveTo`/`drawImage` coordinates (shared `snapCenter`/`labelBlitPos` math — keep them in sync). `AxisGridLayer.finalizeBounds()` must run before anything reads bounds on BOTH paths. Chromium caps ~16 live WebGL contexts — never recommend `'webgl'` there for many charts.
- Worker frame loop: ONE `FrameDriver` rAF per worker (shared by all engines' `Scheduler`s), idle-stop + load governors (JS-budget stride, rAF-cadence stride); main-thread coalesce flush is a shared frame in `shared/lib/flush-scheduler.ts` with its own pressure governor. Axis labels render via the `shared/lib/label-cache.ts` sprite cache (`drawImage`, not per-frame `fillText`).
- Axis modes: `externalAxes` (separate axis canvases), `inlineAxes` (margins inside the main canvas — one surface; viewport `insetLeft/insetBottom` plot rect), or neither (React-side ticks via TICK_UPDATE). In-plot labels auto-suppress when either axis mode renders labels.

## Testing & coverage

- Coverage runs per package (no root script): `cd packages/<pkg> && pnpm vitest run --coverage`. Build render first (`pnpm --filter @heojeongbo/fluxion-render build`) so replay resolves it.
- Enforced thresholds (`vitest.config.ts`): render = 100% stmts/funcs/lines, 98% branches; worker = 100% stmts/funcs/lines, 90% branches; replay = 100% lines (binding).
- Patterns: `createFakeCtx()` (`src/test/setup.ts`) for canvas draw tests; a stub host whose `line(id)` returns a handle with a spyable `push` (see `use-simple-chart.test.tsx` `makeStubHost`) for stream-hook tests; `labelDraws(ctx)` (setup.ts) to assert label text/anchor coords from sprite `drawImage` blits — labels are NOT `fillText` on the target ctx anymore.
- Module singletons (frame driver, flush scheduler, label cache) are reset by a global `afterEach` in setup.ts; file-local afterEach hooks that reset them must run BEFORE `vi.useRealTimers()` (a fake-timer rAF handle cancelled under real timers wedges the singleton).
- Frame-count-exact tests: happy-dom/sinon rAF due-times don't align with arbitrary `advanceTimersByTime` steps — step frames with `vi.advanceTimersToNextTimer()` (it fires ALL timers due at that tick, in registration order). Governor tests drive time via `vi.spyOn(performance, "now")` with a manual clock (advance BEFORE the frame for arrival gaps, INSIDE onFrame for busy).
- React component tests run with vitest `globals:false` → testing-library auto-cleanup is OFF. Add `afterEach(cleanup)` or scope queries to the returned `container`, or you'll hit "Found multiple elements" across tests.
- v8-ignore: `/* v8 ignore next */` does NOT suppress cond-expr (`a?b:c`), binary-expr (`a??b`), or `if`-statement branches — use `/* v8 ignore start */ … /* v8 ignore stop */` for those, always with `-- reason`. The render branch gate is 98 (not 100) because v8 emits an untargetable phantom "implicit else" on every `if` without an `else`.
- replay `scenarios/09-*.test.ts` is timing-flaky ONLY under `--coverage` (v8 slowdown) — it carries per-test `testTimeout: 20_000`; don't touch VirtualClock/ReplayPlayer to "fix" it.

## Release

Per-package release-it via root scripts: `release[:worker|:replay][:patch|:minor|:major][:dry]`.
Pipeline: typecheck → test → build → version bump → CHANGELOG → tag (`fluxion-<pkg>-v<semver>`) → GitHub release → npm publish. Use the `release` skill.

**Caveats:**
- `release-it --dry-run` runs `npm version` FOR REAL — the `:dry` scripts auto-restore `package.json` afterward, but never trust a dirty tree after a dry-run; a leftover bump skews the next computed version.
- The plain `:dry` previews the DEFAULT (minor) bump — use `release:<pkg>:patch:dry` etc. to preview the level you actually intend.
- release-it requires a clean tree and branch `main`; `.env` must provide `GITHUB_TOKEN`.
