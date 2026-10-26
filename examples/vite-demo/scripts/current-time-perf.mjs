/**
 * Headed, sequential A/B runs: do not run other workloads alongside this.
 *
 * Main-thread frame statistics come from the raw rAF intervals pooled across
 * runs. Intervals are quantized to whole vsync periods, so a percentile or a
 * fixed-ms cut-off that sits on a period multiple flips between buckets on
 * noise alone: CI Firefox measured p95 17.6 vs 33.2 ms on identical runs, and
 * a 33.4 ms jank cut-off counts a 2-frame interval at 34.2 ms but not at
 * 33.3 ms. The gate therefore uses continuous statistics:
 *   - tail5Ms    mean of the slowest 5% of intervals
 *   - droppedPct share of intervals that missed a vsync (> 1.5 periods, the
 *                middle of a bucket, so jitter cannot move an interval across)
 *
 * Single-run drop rates vary 0-7% on identical runs, so each arm pools RUNS
 * runs. A/A splits at the noisiest boundary load measured: 3 runs per arm →
 * 0.7% false failures / 92% detection of a real load regression; 5 → 0% / 99.7%.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
const exec = promisify(execFile);
const RUNS = 5;
const results = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
for (const browser of ["chromium", "firefox"]) {
  const samples = { 0: [], 1: [] };
  for (let run = 0; run < RUNS; run++) {
    for (const currentTime of run % 2 ? [1, 0] : [0, 1]) {
      const { stdout } = await exec(process.execPath, ["scripts/bench.mjs", "--browser", browser, "--charts", "60", "--rate", "25", "--duration", "8000", "--warmup", "3000", "--runs", "1", "--currentTime", String(currentTime), "--intervals", "1"], { timeout: 90000 });
      const sample = stdout.trim().split("\n").map((line) => JSON.parse(line)).find((v) => v.run === 1);
      assert(sample.statsReports > 0 && sample.workerRendersPerSec > 0, "benchmark must receive worker renders");
      assert(sample.intervals.length > 0, "benchmark must record frame intervals");
      sample.run = run + 1;
      samples[currentTime].push(sample);
      const { intervals, ...summary } = sample;
      console.log(JSON.stringify({ browser, currentTime, run: run + 1, ...summary }));
    }
  }
  // One vsync period on this browser/display: the median interval of both arms.
  const periodMs = median([...samples[0], ...samples[1]].flatMap((r) => r.intervals));
  const summarize = (rows) => {
    const intervals = rows.flatMap((r) => r.intervals);
    const sorted = [...intervals].sort((a, b) => a - b);
    return {
      meanFps: 1000 / mean(intervals),
      tail5Ms: mean(sorted.slice(Math.floor(sorted.length * 0.95))),
      droppedPct: (100 * intervals.filter((v) => v > periodMs * 1.5).length) / intervals.length,
      // Reported for comparison with older runs only — quantized, never gated.
      p95Ms: sorted[Math.round(0.95 * (sorted.length - 1))],
      workerMsPerRender: median(rows.map((r) => r.workerBusyMsPerSec / r.workerRendersPerSec)),
    };
  };
  const off = summarize(samples[0]);
  const on = summarize(samples[1]);
  const checks = {
    mainFps: on.meanFps >= off.meanFps * 0.85,
    frameTail: on.tail5Ms <= off.tail5Ms * 1.5 + periodMs / 2,
    droppedFrames: on.droppedPct <= off.droppedPct + 5,
    workerCost: on.workerMsPerRender <= off.workerMsPerRender * 1.5 + 0.05,
  };
  results.push({ browser, charts: 60, rateHz: 25, runs: RUNS, warmupMs: 3000, durationMs: 8000, periodMs, off, on, checks, samples });
}
await mkdir("../../.cache/current-time-perf", { recursive: true });
await writeFile("../../.cache/current-time-perf/results.json", `${JSON.stringify(results, null, 2)}\n`);
for (const result of results) {
  console.log(JSON.stringify({ browser: result.browser, periodMs: result.periodMs, off: result.off, on: result.on, checks: result.checks }));
  assert(Object.values(result.checks).every(Boolean), `${result.browser}: performance regression (see .cache/current-time-perf/results.json)`);
}
