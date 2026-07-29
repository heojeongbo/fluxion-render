# Changelog

## [1.0.3](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v1.0.2...fluxion-render-v1.0.3) (2026-07-29)


### Features

* **examples:** bench cost-attribution params (axes/labels/grid) ([6faa83e](https://github.com/HeoJeongBo/fluxion-render/commit/6faa83ed606ab3392addf63166c8111127c0ebe5))


### Performance Improvements

* **render:** label-sprite cache — raster each label once, blit per frame ([439b66f](https://github.com/HeoJeongBo/fluxion-render/commit/439b66fa438457eed6a9a3aff52001bac12a7ce6))
* **render:** x-tick cache, external-axis label dedupe, draw-path allocs ([be42a3a](https://github.com/HeoJeongBo/fluxion-render/commit/be42a3a4bed77ced94b96993be8e7c1b5b23db98))

## [1.0.2](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v1.0.1...fluxion-render-v1.0.2) (2026-07-29)


### Features

* **examples:** automated many-chart bench page + playwright runner ([c7d4786](https://github.com/HeoJeongBo/fluxion-render/commit/c7d4786ac2720a134643d43e6c2d4ac5154f7ee9))


### Performance Improvements

* **render:** cadence-signal load shedding for compositor overload ([4bb2ebb](https://github.com/HeoJeongBo/fluxion-render/commit/4bb2ebb221fa7a1d1e26939f87a75e499f553cd5))
* **render:** per-worker frame loop with load governor, shared flush ([69e27e7](https://github.com/HeoJeongBo/fluxion-render/commit/69e27e73ad859324c80953f63975ef75168caf83))

## [1.0.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v1.0.0...fluxion-render-v1.0.1) (2026-07-24)


### Bug Fixes

* **render:** send Op.DISPOSE before flipping `disposed` so pool hosts tear down ([37394c9](https://github.com/HeoJeongBo/fluxion-render/commit/37394c962a422628b4ea8dc8e9e8f0ec6dbefeca))

# [1.0.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.24.0...fluxion-render-v1.0.0) (2026-07-06)


### Bug Fixes

* **render:** declare @heojeongbo/fluxion-worker as a runtime dependency ([056391c](https://github.com/HeoJeongBo/fluxion-render/commit/056391ccddb81792a7423c83fbd4da4a2a1a3555))

# [0.24.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.23.0...fluxion-render-v0.24.0) (2026-07-06)


### Bug Fixes

* **render:** defer recycle-overflow and pool-teardown disposes through the frame queue ([0946ce2](https://github.com/HeoJeongBo/fluxion-render/commit/0946ce23af6ab71b85baf4112e24fb6ead2c9e7c))
* **render:** forward emitRenderStats in pool mode; add getLifecycleStats ([95dded1](https://github.com/HeoJeongBo/fluxion-render/commit/95dded1fb15d771c5fb8d9435c1fc8bc0dbaf10d))
* **render:** harden burst fixes — recycle key emitRenderStats, budget validation, idle-shrink clamps, hidden-tab drain ([6ed299b](https://github.com/HeoJeongBo/fluxion-render/commit/6ed299b80e3667a8b5aaaec4436a359362ffab2f))


### Features

* **examples:** light/dark Theme Switch demo showing live chart re-theming ([f3a1583](https://github.com/HeoJeongBo/fluxion-render/commit/f3a15831f1b707eac639b1e2576db2e2a396a540))
* **examples:** surface replay video-write errors as a storage-full badge ([cb80dc4](https://github.com/HeoJeongBo/fluxion-render/commit/cb80dc44f91e6b8c81b7187ba13e3edc0194c591))
* **render:** frame-budgeted, latest-wins resize scheduling ([f455a1f](https://github.com/HeoJeongBo/fluxion-render/commit/f455a1fbca0be5a250b8bbf73d2cb38c55dd0516))
* **render:** idle shrink of parked host backings ([3f632e9](https://github.com/HeoJeongBo/fluxion-render/commit/3f632e9990394ce75f861e027934c8c0f5aae226))
* **render:** recycle-pool overflow stats + working-set warning ([252e18d](https://github.com/HeoJeongBo/fluxion-render/commit/252e18d905886e1e8bc412c489934fc4bb610765)), closes [hi#water](https://github.com/hi/issues/water)
* **render:** runtime setAxisStyle + declarative bg/axis reconcile for live theming ([e8d6448](https://github.com/HeoJeongBo/fluxion-render/commit/e8d6448155eeed343d954b65620a9cd32d1f161d))
* **replay:** OPFS-aware eviction with graceful quota handling ([c4c0f45](https://github.com/HeoJeongBo/fluxion-render/commit/c4c0f450e78343e2b56a36bf4d80e2e5ca151ce2))

# [0.23.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.22.0...fluxion-render-v0.23.0) (2026-06-29)


### Features

* **examples:** churn demo reveal toggle + main/worker CPU HUD ([caf6d5f](https://github.com/HeoJeongBo/fluxion-render/commit/caf6d5fb6f67b1a5c11100fd7baf3fa6034f245c))
* **render:** staggered-list reveal + worker render-load reporting ([6cc7b63](https://github.com/HeoJeongBo/fluxion-render/commit/6cc7b6381a138c8c116a04403a96438b427b9346))

# [0.22.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.21.0...fluxion-render-v0.22.0) (2026-06-27)


### Features

* **examples:** mount/unmount churn stress demo with recycle toggle ([f6b6ec0](https://github.com/HeoJeongBo/fluxion-render/commit/f6b6ec0e60c48e41a9552dcea766f3f20533b2d2))
* **render:** host recycle pool + mount/unmount lifecycle hardening ([2aa643b](https://github.com/HeoJeongBo/fluxion-render/commit/2aa643b2a2cee8397cf1cfd719a6e36685b05faa))

# [0.21.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.20.0...fluxion-render-v0.21.0) (2026-06-26)


### Bug Fixes

* **render:** warn on layer-handle arity mismatch; guard degenerate bounds, ticker leak, non-monotonic extent ([191286f](https://github.com/HeoJeongBo/fluxion-render/commit/191286f475a706daedb85960b04b64c876947ed1))


### Features

* **render:** staggered mount on by default with safe mount/dispose lifecycle ([a6cc029](https://github.com/HeoJeongBo/fluxion-render/commit/a6cc02984d488e20999cadf1e2cf0c44c2d2467c))


### Performance Improvements

* **render:** cache heatmap-stream autoscale, reuse stacked-area scratch, memoize clock labels ([0f22390](https://github.com/HeoJeongBo/fluxion-render/commit/0f22390c8eb6d86ef05af32ce308ec8ada4ee97c))

# [0.20.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.19.1...fluxion-render-v0.20.0) (2026-06-26)


### Features

* **examples:** stagger broadcast mounts and backfill late charts on ready ([e86f9f5](https://github.com/HeoJeongBo/fluxion-render/commit/e86f9f56b5f6f2c966dc385654562c602a323855))
* **render:** staggerMount to spread a burst of mounts across frames ([573912f](https://github.com/HeoJeongBo/fluxion-render/commit/573912f6cd4bdc81647927db5f7e3faf2305a0e1))


### Performance Improvements

* **render:** cache colormap rgb() strings per LUT entry ([a58a09a](https://github.com/HeoJeongBo/fluxion-render/commit/a58a09aa2a29d7d8cb4df9b95a60660477ff4b03))
* **render:** opaque context, skip no-op resize, reuse decimation scratch, inline axis ticks ([df96a63](https://github.com/HeoJeongBo/fluxion-render/commit/df96a63056c7b6baf18ef0adab0d319ef9f86861))
* **render:** sliding-window y-extent for streaming-layer scan ([5ed1bb3](https://github.com/HeoJeongBo/fluxion-render/commit/5ed1bb3a87fc930f45b605ef59b05824e3603dd1))

## [0.19.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.19.0...fluxion-render-v0.19.1) (2026-06-25)


### Bug Fixes

* **render:** release OffscreenCanvas GPU backing on dispose ([fb6a9b8](https://github.com/HeoJeongBo/fluxion-render/commit/fb6a9b81283043f2e9fb73eb7d59dc7e2553b698))

# [0.19.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.18.0...fluxion-render-v0.19.0) (2026-06-25)


### Performance Improvements

* **render,worker,replay:** coalesce pushes, decimate draws, grow pool, harden loops ([a344ae4](https://github.com/HeoJeongBo/fluxion-render/commit/a344ae43bc0c8d1c6e2cabd5e255d00953ceec69))

# [0.18.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.17.1...fluxion-render-v0.18.0) (2026-06-19)


### Bug Fixes

* **render:** track absolute-epoch guard per layer ([14d4007](https://github.com/HeoJeongBo/fluxion-render/commit/14d4007db993112d7249121d3d0403943765d912))
* **replay:** un-wedge scrubber DVR-entry guard on lost pointer release ([713f692](https://github.com/HeoJeongBo/fluxion-render/commit/713f692c9e40a0f3075d2a32b4c2fce1bc4350cd))


### Features

* **examples:** add demos for the new robot & distribution layers ([bb479ff](https://github.com/HeoJeongBo/fluxion-render/commit/bb479ff7ac250c3aede9776ad68e7859b95bbf14))
* **examples:** add helpers and axis-format demos, lane/overlay toggle ([b22278e](https://github.com/HeoJeongBo/fluxion-render/commit/b22278e69dd0e601f6e2af3b2a64777d80e8e17b))
* **examples:** route vite-demo pages with TanStack Router ([8a13c48](https://github.com/HeoJeongBo/fluxion-render/commit/8a13c48568a2faa2d5eec25088b5d92d77f4f1d1))
* **render:** add box-plot layer and spectrogram preset ([9b28e63](https://github.com/HeoJeongBo/fluxion-render/commit/9b28e63f603b2cd69fe4364cbf0789e8e266c2f1))
* **render:** add dash palette and lane (small-multiples) mode for overlapping series ([684581d](https://github.com/HeoJeongBo/fluxion-render/commit/684581db52a7b657058134e565661d7ab9c391e7))
* **render:** add histogram layer with internal binning ([adffeb6](https://github.com/HeoJeongBo/fluxion-render/commit/adffeb61a5db42cb147ce422608d6a5256d899d6))
* **render:** add maxGapMs gap-breaking to line/area/step layers ([4f8aa30](https://github.com/HeoJeongBo/fluxion-render/commit/4f8aa30beece2f24db77fc709273036564a2d116))
* **render:** add polar/radar layer ([a462f75](https://github.com/HeoJeongBo/fluxion-render/commit/a462f75f4d0db5518649b06b5f728da2006b7af3))
* **render:** add stacked-area layer for composition over time ([6425893](https://github.com/HeoJeongBo/fluxion-render/commit/6425893ee559d29c4367864264d5d710a19de4f1))
* **render:** add trajectory and occupancy-grid layers for robot dashboards ([109d91b](https://github.com/HeoJeongBo/fluxion-render/commit/109d91b6fb655960541f06f4258d66c68358e0ae))
* **render:** batch config, shared ticker, pool crosshair & layer opts ([a52f9cf](https://github.com/HeoJeongBo/fluxion-render/commit/a52f9cfd9c4f1268d4dc672c0c7e1045d4b4d215))
* **render:** bundle hover cache and overrides into useFluxionCrosshairFromLayers ([d2e5f4c](https://github.com/HeoJeongBo/fluxion-render/commit/d2e5f4c6eafd716ae9b8b9f7739022f4cdf0a4f3)), closes [hi#rate](https://github.com/hi/issues/rate)
* **render:** DX helpers — crosshair overlay, legend-from-layers, capacity check ([d39d161](https://github.com/HeoJeongBo/fluxion-render/commit/d39d1614b288e61dbbdde33f24c7f9de511cbe19))
* **render:** follow-clock stabilization, DX helpers, and 100% coverage ([0fb1b1c](https://github.com/HeoJeongBo/fluxion-render/commit/0fb1b1c1f3ea0bf96a2dd0e0a96a97c9c5fcaf1a))
* **render:** host.getMetrics() diagnostics and absolute-epoch push guard ([517d21e](https://github.com/HeoJeongBo/fluxion-render/commit/517d21e416893f0651c1336666da5560ad408243))
* **render:** reconcile layer configs in useFluxionCanvas when layers change ([28e55a7](https://github.com/HeoJeongBo/fluxion-render/commit/28e55a77a482658321ff10194e88dbe0d4932464))
* **render:** reconcile structural layer changes without a key remount ([da30fb2](https://github.com/HeoJeongBo/fluxion-render/commit/da30fb2d117f66e9c6cef9d194b2a1b2a1f97fc5))
* **render:** table enhancements — sparklines, badges, sortable & sticky headers ([837670b](https://github.com/HeoJeongBo/fluxion-render/commit/837670b8d238bc11de32e104a362ad52ac901850))
* **render:** virtual row scrolling for FluxionTable ([ab5e11c](https://github.com/HeoJeongBo/fluxion-render/commit/ab5e11ca2841417166c03dd76f0dfcfd004bb8c2))
* **replay:** add onOtherFrame passthrough to useVideoReplayer ([6a43f42](https://github.com/HeoJeongBo/fluxion-render/commit/6a43f42097d7515cd9cec3f1030110d12e69d1ad))
* **replay:** add useReplayFrameLog hook ([5bd53ed](https://github.com/HeoJeongBo/fluxion-render/commit/5bd53ed3bfd9acfa74e13e80c1bd23d5032896ac))
* **replay:** thread snapMs into DvrScrubber step and guard concurrent enterReplay ([50a0200](https://github.com/HeoJeongBo/fluxion-render/commit/50a02001f4be8ed3c4474ab2950e3c62cbb29ffd))


### Performance Improvements

* **render:** cache axis y-ticks and formatClock date per frame ([9666ce0](https://github.com/HeoJeongBo/fluxion-render/commit/9666ce0028542e591dac0b718ea9d73f7636b398))
* **render:** dirty-gate y-axis canvas and add table scroll throttle ([401258a](https://github.com/HeoJeongBo/fluxion-render/commit/401258a5d678d0fce757b2ab3007e0dc7c0e73c4)), closes [hi#refresh](https://github.com/hi/issues/refresh)
* **replay:** read getTimeRange bounds in a single transaction ([a658123](https://github.com/HeoJeongBo/fluxion-render/commit/a6581235a84e6496a2d06310f85a1123326043b9))

## [0.17.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.17.0...fluxion-render-v0.17.1) (2026-06-12)


### Bug Fixes

* **render,replay:** widen pre-1.0 peer ranges to >=X <1 ([68f27c3](https://github.com/HeoJeongBo/fluxion-render/commit/68f27c380d84a2ed09a370fffd70e46e30cb08e1))

# [0.17.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.16.0...fluxion-render-v0.17.0) (2026-06-12)


### Bug Fixes

* **replay:** cancel stale DVR enter on return-to-live scrub release ([54de418](https://github.com/HeoJeongBo/fluxion-render/commit/54de418ac8540107f4dfcf16117fd7ab7039caba))
* **replay:** fix bugs, improve perf, and expand test coverage ([844c71a](https://github.com/HeoJeongBo/fluxion-render/commit/844c71ac933330abbbfd224520efc18d0f8a0f7e))


### Features

* **render,examples:** add followClock for wall-clock axis scrolling ([3ea8346](https://github.com/HeoJeongBo/fluxion-render/commit/3ea8346b1a18b97f5db065ea90d6607d4028c11a))

# [0.16.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.15.0...fluxion-render-v0.16.0) (2026-06-05)


### Features

* **replay,render,examples:** DVR scrub perf + entry fix, draw decimation, coverage ([b120d61](https://github.com/HeoJeongBo/fluxion-render/commit/b120d61f678024f7ff685dcf565f4e2ef694ddb4)), closes [hi#rate](https://github.com/hi/issues/rate)

# [0.15.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.14.0...fluxion-render-v0.15.0) (2026-06-04)


### Bug Fixes

* **replay:** remove dead pendingGetTimeRangeResolvers causing TS2339 type error ([c4241cc](https://github.com/HeoJeongBo/fluxion-render/commit/c4241cc596ece5e23a133b214986e6b6cec37dab))


### Features

* **replay,examples:** add DVR controller/format/producer hooks, fix video seek, tailwind demo ([d23d31c](https://github.com/HeoJeongBo/fluxion-render/commit/d23d31cef7237fb2f5eb9386d73677245a09394f))
* **replay,examples:** add worker fan-out replay demo and fix prefetch boundary duplicate ([99d290e](https://github.com/HeoJeongBo/fluxion-render/commit/99d290e4c3233b000c18e3e2ff17485e4fb5cbfc))
* **replay,examples:** fix dvr re-entry/freeze bugs, add useScrubberControls and DvrScrubber ([b1c87f7](https://github.com/HeoJeongBo/fluxion-render/commit/b1c87f78d3137a5699793da9d5964cc67760ab7d))

# [0.14.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.13.0...fluxion-render-v0.14.0) (2026-06-01)


### Features

* **render,examples:** add yAutoMinSpan to axis-grid and Friday 0x0001 packet demo ([57de13a](https://github.com/HeoJeongBo/fluxion-render/commit/57de13aaef63f4c331768021b3ed69b57340442b))


### Reverts

* **examples:** remove Friday packet demo and restore pool fan-out stream demo ([b50a308](https://github.com/HeoJeongBo/fluxion-render/commit/b50a308eed99c882d4ca34565b0eead9870d684d))

# [0.13.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.12.1...fluxion-render-v0.13.0) (2026-06-01)


### Features

* **render:** add useTimeOrigin, extend useSyncedTimeWindow with timeOrigin, fix broadcastStream grouping ([75f163f](https://github.com/HeoJeongBo/fluxion-render/commit/75f163fb52aa41709717e7820535e61065751496))

## [0.12.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.12.0...fluxion-render-v0.12.1) (2026-06-01)

# [0.12.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.11.0...fluxion-render-v0.12.0) (2026-06-01)


### Bug Fixes

* **render,worker:** fix "WorkerPool has been disposed" in React StrictMode ([75bd076](https://github.com/HeoJeongBo/fluxion-render/commit/75bd0762f3d66a52dc1150108a63420c1e78a1da))


### Features

* **render,worker,examples:** add pool-level fan-out stream API ([6342d1b](https://github.com/HeoJeongBo/fluxion-render/commit/6342d1b564533e7334626884fcbbe8b04936269e))

# [0.11.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.10.1...fluxion-render-v0.11.0) (2026-06-01)


### Features

* **render,worker,examples:** add custom worker stream pattern and stream mode ([952aba3](https://github.com/HeoJeongBo/fluxion-render/commit/952aba389ced294b4ff488dfcef02c73e7589b07))

## [0.10.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.10.0...fluxion-render-v0.10.1) (2026-06-01)


### Bug Fixes

* **replay:** correct test array type annotation in dvr-metric-buffer.test.ts ([586d5ac](https://github.com/HeoJeongBo/fluxion-render/commit/586d5ac121b1565f8a9808c12bb597a8189e854d))
* **replay:** suppress React act() teardown race and upgrade vitest to 4.1.7 ([322baab](https://github.com/HeoJeongBo/fluxion-render/commit/322baab0102ad308caeb296ef54f0e9101dd6c07))


### Features

* **replay,examples:** add auto-eviction, storage logging, and user scenario tests ([1a9e862](https://github.com/HeoJeongBo/fluxion-render/commit/1a9e8620b5f479e7dcbb2d74be16e5983cb53f4e))
* **replay:** maximize test coverage and add chart replay perf optimizations ([cadb2eb](https://github.com/HeoJeongBo/fluxion-render/commit/cadb2eb0506b4e4910d673859c620dbdbdde9f29))

# [0.10.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.9.0...fluxion-render-v0.10.0) (2026-05-24)


### Features

* **render,replay,examples:** DX overhaul + bridge hook + testing utils ([48e5185](https://github.com/HeoJeongBo/fluxion-render/commit/48e5185f26c2139d7b6ebfe928e6694a24ce5a4d))

# [0.9.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.8.2...fluxion-render-v0.9.0) (2026-05-24)


### Bug Fixes

* **examples:** auto-play on DVR entry and fix scrubber drag-lock ([8a8b30e](https://github.com/HeoJeongBo/fluxion-render/commit/8a8b30ef6b153c3fa2523dfc0a46be5fe3cd91d0))
* **examples:** freeze timeline latest on DVR entry for correct scrubber behavior ([bd2e7ec](https://github.com/HeoJeongBo/fluxion-render/commit/bd2e7ec2c51f21053c2d64ebe5087f1389d95789))
* **examples:** move storage capacity bar above timeline scrubber ([c1c8c1c](https://github.com/HeoJeongBo/fluxion-render/commit/c1c8c1c4af74412c8b243288a906b880c03f231b))
* **examples:** snap scrubber to next segment on gap and fix DVR page overflow ([e6fd8de](https://github.com/HeoJeongBo/fluxion-render/commit/e6fd8deabca1e9c9c876001bcce8e0582da6686c))
* **replay,examples:** fix VP8 decoder dimension mismatch on Retina displays ([79b2b32](https://github.com/HeoJeongBo/fluxion-render/commit/79b2b3297275dd4d75fbaea12b517c9a68678636))
* **replay,examples:** revert seenKeyframe guard and fix timeline overflow ([6908302](https://github.com/HeoJeongBo/fluxion-render/commit/69083025f9bf185c76b2f97aa3170e563769f9a4))
* **replay:** add codedWidth/codedHeight to VideoChannel round-trip tests ([fd279c2](https://github.com/HeoJeongBo/fluxion-render/commit/fd279c29dd192e178cc641b924b0550f982364a1))
* **replay:** extend seek lookback to 3s to guarantee keyframe before decode ([3427a49](https://github.com/HeoJeongBo/fluxion-render/commit/3427a4938f6a3708519767a927e9cace4c81a213))


### Features

* **examples:** auto-return to live when replay reaches the live edge ([82521b2](https://github.com/HeoJeongBo/fluxion-render/commit/82521b2fbd96eff2c972176fc88671168af3da70))
* **render,replay,examples:** add useChartReplay for time-travel line charts ([6993fa9](https://github.com/HeoJeongBo/fluxion-render/commit/6993fa9f2cdec01783e54a61569c2810a748ba10))
* **replay,examples,render:** chart-replay DVR with scrub-then-play UX ([98e4544](https://github.com/HeoJeongBo/fluxion-render/commit/98e45444567349ec36049d13e6212c9f5546bd16))
* **replay,examples:** add @heojeongbo/fluxion-replay package with demo ([516aa01](https://github.com/HeoJeongBo/fluxion-render/commit/516aa0192d8fc6912302d5f20ca0f9bbb5cf4a69))
* **replay,examples:** add DVR time-travel demo and extend useReplayTimeline ([e7f089f](https://github.com/HeoJeongBo/fluxion-render/commit/e7f089ff4ee0ed9e8113bba05eefe75bfe03f5da))
* **replay,examples:** add perf fixes, DX improvements, storage API, and new hooks ([f43ac1c](https://github.com/HeoJeongBo/fluxion-render/commit/f43ac1c5c59dad150705515502d6998a93d30465))
* **replay,examples:** recording segments, gap visualization, and video fix ([29bd089](https://github.com/HeoJeongBo/fluxion-render/commit/29bd089fc67256bde3da13f217c62f35620ea0d3))

## [0.8.2](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.8.1...fluxion-render-v0.8.2) (2026-05-19)


### Features

* **render,examples:** add FluxionPieChart and classNames CSS injection support ([96f1c77](https://github.com/HeoJeongBo/fluxion-render/commit/96f1c771bd6d9de361d89011dbd02e4aeaf83027))
* **render,examples:** add pie chart enter/update animations and fix StrictMode bug ([cb19933](https://github.com/HeoJeongBo/fluxion-render/commit/cb19933110dcd62496eb0c49648b1d79cfb69e1a))

## [0.8.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.8.0...fluxion-render-v0.8.1) (2026-05-19)


### Features

* **render,examples:** add reference-line and pose-arrow layers ([7a0cc92](https://github.com/HeoJeongBo/fluxion-render/commit/7a0cc92ae4784e19e31ab5bbd1fc406c8a2dd6b6))

# [0.8.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.7.3...fluxion-render-v0.8.0) (2026-05-18)


### Features

* **render,examples:** add robot visualization layers and demo dashboard ([438aca2](https://github.com/HeoJeongBo/fluxion-render/commit/438aca2a3432276f1d0ba5dbd73b88faa2a7fd30))

## [0.7.3](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.7.2...fluxion-render-v0.7.3) (2026-05-18)


### Features

* **render,examples:** add crosshair + tooltip hover interaction ([eb2e4db](https://github.com/HeoJeongBo/fluxion-render/commit/eb2e4dba1df2a8f45add0f2bd759a258e2d747a3))
* **worker,examples:** add /react subpath with hooks and React Hooks demo tab ([ff9f04a](https://github.com/HeoJeongBo/fluxion-render/commit/ff9f04a14bde8eb5b0c8735378d1ecb491a3085b))

## [0.7.2](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.7.1...fluxion-render-v0.7.2) (2026-05-13)


### Features

* **render,examples:** dx improvements — factory fn exports, FluxionCanvas cleanup, null-host warning ([40d7ac6](https://github.com/HeoJeongBo/fluxion-render/commit/40d7ac6ab77fb3eb09ff42dd1f322be76e0fde67))

## [0.7.1](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.7.0...fluxion-render-v0.7.1) (2026-05-13)


### Features

* **render,examples:** add area, step, bar, candlestick, heatmap chart layers ([3ec63bd](https://github.com/HeoJeongBo/fluxion-render/commit/3ec63bd70ae625e1cbcab056fafb43c618f215c6))

# [0.7.0](https://github.com/HeoJeongBo/fluxion-render/compare/fluxion-render-v0.6.0...fluxion-render-v0.7.0) (2026-05-11)


### Bug Fixes

* monorepo publish ([18304eb](https://github.com/HeoJeongBo/fluxion-render/commit/18304eb4adc29f2fd37e4facda51eada72ae352e))

# [0.6.0](https://github.com/HeoJeongBo/fluxion-render/compare/v0.5.0...fluxion-render-v0.6.0) (2026-05-08)


### Bug Fixes

* npm publish warn issue ([00fcd91](https://github.com/HeoJeongBo/fluxion-render/commit/00fcd91648443d77e64cc65ff2a453ca33e004ce))
* publish setting ([89a7097](https://github.com/HeoJeongBo/fluxion-render/commit/89a70970c049e95ffef08470e80072b9cdc80f9d))
* registry setting ([4e956e6](https://github.com/HeoJeongBo/fluxion-render/commit/4e956e643024759b1565705fad545fa8aa73bd63))
* release-it ([b2507c3](https://github.com/HeoJeongBo/fluxion-render/commit/b2507c3541e4d9cc3464f3b087d2dac38496f14b))
* **worker:** abort pending requests on pool-backed dispose, remove handle from set on release ([e3576a6](https://github.com/HeoJeongBo/fluxion-render/commit/e3576a63942b52d3fac869eaaedc89527cc534bb))


### Features

* add fluxion worker package ([b74be40](https://github.com/HeoJeongBo/fluxion-render/commit/b74be4021d3bec77c760bf2b664ec09a31f0b45a))
* add standalone onMessage ([c586841](https://github.com/HeoJeongBo/fluxion-render/commit/c58684100a07006547dd48a625e949cd8f0b1bf1))
* **render,examples:** add streaming scatter chart layer ([afdab3a](https://github.com/HeoJeongBo/fluxion-render/commit/afdab3ae89996948ce7acd3ad440e7e81abd9ab2))
* update md ([d7e49db](https://github.com/HeoJeongBo/fluxion-render/commit/d7e49dbd217c44e3e7dfa9f405aad5538436eb39))
* worker publish setting ([6ed8ef1](https://github.com/HeoJeongBo/fluxion-render/commit/6ed8ef18fdcc3f5884aef7871ff8423ca3b6f823))
* **worker,examples:** add dispatch, dispose, WorkerTimeoutError.is ([4afcf1d](https://github.com/HeoJeongBo/fluxion-render/commit/4afcf1dd45e092ec9592d88e2aaa973124586626))
* **worker,examples:** add request, stats, onError, defineWorkerWithState ([239db37](https://github.com/HeoJeongBo/fluxion-render/commit/239db37768d606b078878eae6c8a9305a0f00267))
* **worker:** add isTerminated getter, strip hostId from onMessage, fix WorkerLike, safe subclass override ([e8508c4](https://github.com/HeoJeongBo/fluxion-render/commit/e8508c4fb18f0fa5e0aab9a2925ffbb52668c85e))
* **worker:** preserve worker stack, harden dispose race, immutable postMessage ([c547afe](https://github.com/HeoJeongBo/fluxion-render/commit/c547afec63be6ce0c359c2452480bb5f4569c0e0))

# 0.5.0 (2026-04-24)


### Bug Fixes

* minor performance issue ([5af3285](https://github.com/HeoJeongBo/fluxion-render/commit/5af3285fbe89514ca0699e4094dc942b8cf21577))


### Features

* axis to worker ([b3abe11](https://github.com/HeoJeongBo/fluxion-render/commit/b3abe11e4c6f4b2bc4ac46f4f2f775ab6e56f395))

## 0.4.1 (2026-04-21)


### Bug Fixes

* xAxis performance issue ([fb96608](https://github.com/HeoJeongBo/fluxion-render/commit/fb96608e8864db3d9e16713cf863e12c2151e9a5))
* xAxis tick test ([bf93bf2](https://github.com/HeoJeongBo/fluxion-render/commit/bf93bf2bbd98205b51486231b8e0b0dde8750961))

# 0.4.0 (2026-04-21)


### Bug Fixes

* type issue ([61ad0db](https://github.com/HeoJeongBo/fluxion-render/commit/61ad0dbc5dba7af6dc05e0d13b6c2a041d98f822))


### Features

* add fluxion table ([93d94be](https://github.com/HeoJeongBo/fluxion-render/commit/93d94be093b20b2f415f5cabb6bde2c54b9f88b1))

## 0.3.6 (2026-04-21)


### Features

* minor updates ([ae039ba](https://github.com/HeoJeongBo/fluxion-render/commit/ae039ba69b67903758626a16c8760c80f48ce163))

## 0.3.5 (2026-04-21)


### Features

* add line filter ([93fe677](https://github.com/HeoJeongBo/fluxion-render/commit/93fe677a8fb670097088df902f39c01f887f94a7))

## 0.3.4 (2026-04-21)


### Features

* add retention ms & historical ([2017777](https://github.com/HeoJeongBo/fluxion-render/commit/2017777342e0a561f810878b1f0898d3037fcc03))

## 0.3.3 (2026-04-21)


### Bug Fixes

* xAxis performance issue ([8a1af5a](https://github.com/HeoJeongBo/fluxion-render/commit/8a1af5ab93439af7f84d2a458f1c0a5b77ea57bd))

## 0.3.2 (2026-04-20)


### Features

* external axes performance ([0e7dc6b](https://github.com/HeoJeongBo/fluxion-render/commit/0e7dc6b550441a35e9df409b69cbc64fe031a11e))

## 0.3.1 (2026-04-18)


### Features

* recharts style ([d91b7dc](https://github.com/HeoJeongBo/fluxion-render/commit/d91b7dc93dcf54603da8728b4ddd6f0bf7a2a094))

# 0.3.0 (2026-04-17)


### Features

* add external axis ([5c21bc6](https://github.com/HeoJeongBo/fluxion-render/commit/5c21bc68c71dab64e6e39d0f2962ceae86d99a42))

## 0.2.4 (2026-04-16)


### Features

* debounce on resize ([7e660ce](https://github.com/HeoJeongBo/fluxion-render/commit/7e660cee2671a859c0fed401e86843f30a8d5b36))

## 0.2.3 (2026-04-16)


### Features

* update md ([d825cb6](https://github.com/HeoJeongBo/fluxion-render/commit/d825cb608c8d657e16a064ad247c4eb7a4640329))

## 0.2.2 (2026-04-16)


### Features

* add worker pool ([b84c72a](https://github.com/HeoJeongBo/fluxion-render/commit/b84c72ae1431674e7320114098d1da89119884cd))

## 0.2.1 (2026-04-11)


### Features

* color set option ([792bd66](https://github.com/HeoJeongBo/fluxion-render/commit/792bd66ff860f50877c6404c458a2ff79f2ac4a9))

# 0.2.0 (2026-04-11)


### Features

* add react utils & hooks ([3be2612](https://github.com/HeoJeongBo/fluxion-render/commit/3be2612cd756340d52da3c3ce1082c6a95c73025))
* iniitial commit ([6d3b2b7](https://github.com/HeoJeongBo/fluxion-render/commit/6d3b2b7ace2f33a1e2d285e342c5df8971f830cb))
* releaes setting ([3185abc](https://github.com/HeoJeongBo/fluxion-render/commit/3185abc2a22c0f6e9dc8f7b320a4172ac1f2a5fe))

# [0.5.0](https://github.com/HeoJeongBo/fluxion-render/compare/v0.4.1...v0.5.0) (2026-04-24)


### Bug Fixes

* minor performance issue ([5af3285](https://github.com/HeoJeongBo/fluxion-render/commit/5af3285fbe89514ca0699e4094dc942b8cf21577))


### Features

* axis to worker ([b3abe11](https://github.com/HeoJeongBo/fluxion-render/commit/b3abe11e4c6f4b2bc4ac46f4f2f775ab6e56f395))

## [0.4.1](https://github.com/HeoJeongBo/fluxion-render/compare/v0.4.0...v0.4.1) (2026-04-21)


### Bug Fixes

* xAxis performance issue ([fb96608](https://github.com/HeoJeongBo/fluxion-render/commit/fb96608e8864db3d9e16713cf863e12c2151e9a5))
* xAxis tick test ([bf93bf2](https://github.com/HeoJeongBo/fluxion-render/commit/bf93bf2bbd98205b51486231b8e0b0dde8750961))

# [0.4.0](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.6...v0.4.0) (2026-04-21)


### Bug Fixes

* type issue ([61ad0db](https://github.com/HeoJeongBo/fluxion-render/commit/61ad0dbc5dba7af6dc05e0d13b6c2a041d98f822))


### Features

* add fluxion table ([93d94be](https://github.com/HeoJeongBo/fluxion-render/commit/93d94be093b20b2f415f5cabb6bde2c54b9f88b1))

## [0.3.6](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.5...v0.3.6) (2026-04-21)


### Features

* minor updates ([ae039ba](https://github.com/HeoJeongBo/fluxion-render/commit/ae039ba69b67903758626a16c8760c80f48ce163))

## [0.3.5](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.4...v0.3.5) (2026-04-21)


### Features

* add line filter ([93fe677](https://github.com/HeoJeongBo/fluxion-render/commit/93fe677a8fb670097088df902f39c01f887f94a7))

## [0.3.4](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.3...v0.3.4) (2026-04-21)


### Features

* add retention ms & historical ([2017777](https://github.com/HeoJeongBo/fluxion-render/commit/2017777342e0a561f810878b1f0898d3037fcc03))

## [0.3.3](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.2...v0.3.3) (2026-04-21)


### Bug Fixes

* xAxis performance issue ([8a1af5a](https://github.com/HeoJeongBo/fluxion-render/commit/8a1af5ab93439af7f84d2a458f1c0a5b77ea57bd))

## [0.3.2](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.1...v0.3.2) (2026-04-20)


### Features

* external axes performance ([0e7dc6b](https://github.com/HeoJeongBo/fluxion-render/commit/0e7dc6b550441a35e9df409b69cbc64fe031a11e))

## [0.3.1](https://github.com/HeoJeongBo/fluxion-render/compare/v0.3.0...v0.3.1) (2026-04-18)


### Features

* recharts style ([d91b7dc](https://github.com/HeoJeongBo/fluxion-render/commit/d91b7dc93dcf54603da8728b4ddd6f0bf7a2a094))

# [0.3.0](https://github.com/HeoJeongBo/fluxion-render/compare/v0.2.4...v0.3.0) (2026-04-17)


### Features

* add external axis ([5c21bc6](https://github.com/HeoJeongBo/fluxion-render/commit/5c21bc68c71dab64e6e39d0f2962ceae86d99a42))

## [0.2.4](https://github.com/HeoJeongBo/fluxion-render/compare/v0.2.3...v0.2.4) (2026-04-16)


### Features

* debounce on resize ([7e660ce](https://github.com/HeoJeongBo/fluxion-render/commit/7e660cee2671a859c0fed401e86843f30a8d5b36))

## [0.2.3](https://github.com/HeoJeongBo/fluxion-render/compare/v0.2.2...v0.2.3) (2026-04-16)


### Features

* update md ([d825cb6](https://github.com/HeoJeongBo/fluxion-render/commit/d825cb608c8d657e16a064ad247c4eb7a4640329))

## [0.2.2](https://github.com/HeoJeongBo/fluxion-render/compare/v0.2.1...v0.2.2) (2026-04-16)


### Features

* add worker pool ([b84c72a](https://github.com/HeoJeongBo/fluxion-render/commit/b84c72ae1431674e7320114098d1da89119884cd))

## [0.2.1](https://github.com/HeoJeongBo/fluxion-render/compare/v0.2.0...v0.2.1) (2026-04-11)


### Features

* color set option ([792bd66](https://github.com/HeoJeongBo/fluxion-render/commit/792bd66ff860f50877c6404c458a2ff79f2ac4a9))

# 0.2.0 (2026-04-11)


### Features

* add react utils & hooks ([3be2612](https://github.com/HeoJeongBo/fluxion-render/commit/3be2612cd756340d52da3c3ce1082c6a95c73025))
* iniitial commit ([6d3b2b7](https://github.com/HeoJeongBo/fluxion-render/commit/6d3b2b7ace2f33a1e2d285e342c5df8971f830cb))
* releaes setting ([3185abc](https://github.com/HeoJeongBo/fluxion-render/commit/3185abc2a22c0f6e9dc8f7b320a4172ac1f2a5fe))
