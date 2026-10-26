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
pnpm dev         # build, then worker/render watch + vite-demo
pnpm dev:replay  # build, then all package watchers + fluxion-replay-demo
pnpm lint:fix    # biome check --write . (formatter + import sort + safe lint fixes)

# Release gate = what release-it's before:init runs (~7 min; headed browsers — run nothing else alongside):
pnpm verify:release  # build → typecheck → test:coverage → lint → test:architecture → test:package → test:perf:cpu → test:e2e → test:perf
#   test:package = replay's render-peer guard + packed-tarball consumer smoke (imports + tsc)
#   test:e2e / test:perf = Chromium AND Firefox (needs `pnpm -C examples/vite-demo exec playwright install chromium firefox`)

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
- App-wide default host options: `configureFluxionDefaults(Partial<FluxionHostOptions>)` (module singleton in `features/host/model/fluxion-defaults.ts`, mirrors `configureDefaultPool`). Merged `{ ...defaults, ...hostOptions }` in the hook at a SINGLE point BEFORE the recycle key is derived (else a default renderer/maxFps desyncs bucketing), and again (idempotently) in the `FluxionHost` constructor for non-React users. Also fixes the light-mode black first frame — a default `bgColor` reaches INIT so the opaque 2d backing is filled synchronously (see `clearBacking`). `resetFluxionDefaults()` in the global test afterEach.
- Viewability gating: the engine renders only while `visible && onScreen` (page visibility via `SET_VISIBLE`; per-chart scroll via `SET_ON_SCREEN`, driven by the `pauseWhenOffscreen` opt-in's shared `shared/lib/onscreen-observer.ts` IntersectionObserver). `Scheduler.setPaused` hard-suspends the render loop but NEVER gates data — `Op.DATA` keeps filling the ring while paused, so a chart scrolled back into view repaints full history in one frame. Only rendering pauses; ingestion/flush are untouched.
- Axis modes: `externalAxes` (separate axis canvases), `inlineAxes` (margins inside the main canvas — one surface; viewport `insetLeft/insetBottom` plot rect), or neither (React-side ticks via TICK_UPDATE). In-plot labels auto-suppress when either axis mode renders labels.

## Testing & coverage

- Run `pnpm build` then `pnpm test:coverage` at the root; all three packages resolve workspace dependencies through `dist`.
- All three packages enforce 100% statements, branches, functions and lines within their configured coverage scope. Coverage is unit/integration instrumentation, not browser E2E coverage. Do not add exclusions just to satisfy the gate.
- CI runs ALL THREE packages WITH `--coverage` in one `build-test` job, so every threshold gates every PR. (replay used to sit in a separate schedule-only `coverage` job because its run took 40s and timed out; that was a `ReplayPlayer` bug, not v8 — see below. It is ~11s now and the job is gone.) Steps use `pnpm -C packages/<pkg> run <script>`, never `pnpm --filter`: the filtered form exits **0** when the filter matches nothing or the script is missing, which is a green check that ran nothing.
- Biome's **linter is enabled** (`biome.json`) — `pnpm lint` fails on errors only. `noExplicitAny`, `useExhaustiveDependencies`, and the a11y rules are set to `warn`: they carry real signal but need a dedicated cleanup pass, so they're visible without blocking. `noArrayIndexKey` / `useIterableCallbackReturn` / `noNonNullAssertion` are off (style-only in this codebase); `useHookAtTopLevel` is off under `shared/gl/` where it false-positives on `gl.useProgram()`; `noAssignInExpressions` is off in tests.
- Patterns: `createFakeCtx()` (`src/test/setup.ts`) for canvas draw tests; a stub host whose `line(id)` returns a handle with a spyable `push` (see `use-simple-chart.test.tsx` `makeStubHost`) for stream-hook tests; `labelDraws(ctx)` (setup.ts) to assert label text/anchor coords from sprite `drawImage` blits — labels are NOT `fillText` on the target ctx anymore.
- Module singletons (frame driver, flush scheduler, label cache) are reset by a global `afterEach` in setup.ts; file-local afterEach hooks that reset them must run BEFORE `vi.useRealTimers()` (a fake-timer rAF handle cancelled under real timers wedges the singleton).
- Frame-count-exact tests: happy-dom/sinon rAF due-times don't align with arbitrary `advanceTimersByTime` steps — step frames with `vi.advanceTimersToNextTimer()` (it fires ALL timers due at that tick, in registration order). Governor tests drive time via `vi.spyOn(performance, "now")` with a manual clock (advance BEFORE the frame for arrival gaps, INSIDE onFrame for busy).
- React component tests run with vitest `globals:false` → testing-library auto-cleanup is OFF. Add `afterEach(cleanup)` or scope queries to the returned `container`, or you'll hit "Found multiple elements" across tests.
- v8-ignore: `/* v8 ignore next */` does NOT suppress cond-expr (`a?b:c`), binary-expr (`a??b`), or `if`-statement branches — use `/* v8 ignore start */ … /* v8 ignore stop */` for those, always with `-- reason`. An implicit else is a reachable false condition; exercise it with a boundary test.
- Timeouts live in `vitest.config.ts` (`testTimeout`), once per package — never as a per-test `timeout:` option. The old per-test scheme was applied to 9 of replay's 831 tests and had already missed two tests in the very file that kept failing.
- replay `scenarios/09-*.test.ts` was NOT "coverage flakiness". `ReplayPlayer._onTick` re-queried IndexedDB on every rAF tick (`_prefetch` set `_prefetchedUpTo = currentT + prefetchMs`, so the next 16ms tick was already behind the horizon), making cost scale with simulated playback time — 4,064 `getFrames` calls and 98% of wall clock for a 65s playback. Fixed with refill hysteresis (`REFILL_AT`); the file went 5.3s→1.0s plain, the coverage suite 40s→11s. VirtualClock is innocent — don't change it or the fake-timer stepping to chase a slow test.
- Browser perf gates must use continuous statistics. rAF intervals are quantized to whole vsync periods, so a percentile or a fixed-ms cut-off near a period multiple flips buckets on noise alone: CI Firefox measured p95 17.6 vs 33.2 ms on identical runs (one release failed on it), and the bench's 33.4 ms `jankPct` never counts a 33.3 ms Chromium 2-frame drop. `current-time-perf.mjs` pools raw intervals (`bench.mjs --intervals 1`) and gates on mean fps, `tail5Ms` (mean of the slowest 5%) and `droppedPct` (> 1.5 periods); storage-perf gates on the sustained (second-half median) backlog, not the single-sample peak. Prove a new gate with an A/A run (identical arms, random 3v3 splits) before trusting it.

## Release

Per-package release-it via root scripts: `release[:worker|:replay][:patch|:minor|:major][:dry]`.
Use the `release` skill.

**The publish happens in CI, not on your machine.** Split of responsibilities:
- **release-it (local)** — verifies, bumps the version, writes CHANGELOG, commits, tags `fluxion-<pkg>-v<semver>`, pushes, creates the GitHub release. It does **not** publish.
- **`.github/workflows/release.yml`** — triggered by that tag. Re-installs from the lockfile, runs the same gates as `verify:release` over the whole workspace (build → typecheck → coverage → lint → architecture → package → perf:cpu → browser E2E → browser perf under `xvfb-run`), then `pnpm pack` + `npm publish --provenance`.

Why split that way: `pnpm pack` is the only half that rewrites `workspace:^` to a real range (`fluxion-render` depends on `fluxion-worker` that way, so a plain `npm publish` would ship an uninstallable package.json), and `npm publish` is the only half that emits provenance. The workflow packs with one and publishes the tarball with the other, and hard-fails if any `workspace:` range survives into the tarball — across all four dependency maps, since worker and replay have no `dependencies` at all and a `dependencies`-only check passed them vacuously.

**Caveats:**
- `release-it --dry-run` runs `npm version` FOR REAL — the `:dry` scripts auto-restore `package.json` afterward, but never trust a dirty tree after a dry-run; a leftover bump skews the next computed version.
- The bare `release` / `:dry` scripts pass NO level, so `@release-it/conventional-changelog` (angular) computes one — and angular's `whatBump` returns **major** for any commit carrying a note, which is how 1.6.0 picked up a bogus `BREAKING CHANGES` block from the words "breaking change" in a body. Always use the explicit `release:<pkg>:patch|minor|major[:dry]` scripts.
- release-it requires a clean tree and branch `main`; `.env` must provide `GITHUB_TOKEN`. The npm token now lives only in the `NPM_TOKEN` Actions secret — there is no longer a reason to keep one in a local `.npmrc`.
- `before:init` runs `pnpm -w run verify:release` — the **whole workspace** plus the headed browser gates, not just the package being released. `fluxion-replay` peer-depends on any `fluxion-render` 1.x and imports its source in tests, so a render-only gate could ship a render change that breaks replay.
- A failed publish caused by the **environment** does not need a new version: re-run via `workflow_dispatch` with the existing tag. The dispatch checks out the TAG's code and tests but runs `main`'s workflow file, so workflow/container fixes apply on re-dispatch — a fix to code or tests needs a new patch version. (That is why render 1.7.1 / replay 0.13.3 are tagged but were never published.)

## CI

`ci.yml` runs on `pull_request` / `workflow_dispatch` / weekly — **not** on push to main. `main` has no branch protection and the repo has never used a PR, so a post-push check gates nothing; the checks that protect users run in `release.yml` and in release-it's `before:init` instead. What CI still covers is the clean-environment sweep local dev never does: frozen-lockfile install, dependency-ordered build, examples typecheck, all three packages' coverage thresholds, and the same architecture/package/browser E2E/perf gates as release, in a single `build-test` job.

Both workflows run inside the digest-pinned `mcr.microsoft.com/playwright:v1.62.0-noble` image (browsers + OS libs preinstalled; apt mirrors made the gates time out) — bump it together with the lockfile's Playwright version. Container gotchas, each of which failed a run: `defaults.run.shell: bash` (container jobs default to `sh`, which rejects `set -o pipefail`), `NODE_OPTIONS=--dns-result-order=ipv4first` (vite preview and Node `fetch` resolved `localhost` to different families), and `chown "$HOME"` before browsers (Firefox refuses a home owned by another uid).

Dependabot watches github-actions only, **grouped into one PR** (`.github/dependabot.yml`) — ungrouped it opened three separate green PRs that then sat unmerged for three weeks. `directory: /` covers both workflows.
