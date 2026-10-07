/** Headed, sequential A/B runs: do not run other workloads alongside this. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
const exec = promisify(execFile);
const results = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const browser of ["chromium", "firefox"]) {
  const samples = { 0: [], 1: [] };
  for (let run = 0; run < 3; run++) {
    for (const currentTime of run % 2 ? [1, 0] : [0, 1]) {
      const { stdout } = await exec(process.execPath, ["scripts/bench.mjs", "--browser", browser, "--charts", "60", "--rate", "25", "--duration", "8000", "--warmup", "3000", "--runs", "1", "--currentTime", String(currentTime)], { timeout: 90000 });
      const sample = stdout.trim().split("\n").map((line) => JSON.parse(line)).find((v) => v.run === 1);
      assert(sample.statsReports > 0 && sample.workerRendersPerSec > 0, "benchmark must receive worker renders");
      sample.run = run + 1;
      samples[currentTime].push(sample);
      console.log(JSON.stringify({ browser, currentTime, run: run + 1, ...sample }));
    }
  }
  const summarize = (rows) => ({
    meanFps: median(rows.map((r) => r.meanFps)),
    p95Ms: median(rows.map((r) => r.p95Ms)),
    jankPct: median(rows.map((r) => r.jankPct)),
    workerMsPerRender: median(rows.map((r) => r.workerBusyMsPerSec / r.workerRendersPerSec)),
  });
  const off = summarize(samples[0]);
  const on = summarize(samples[1]);
  const checks = {
    mainFps: on.meanFps >= off.meanFps * 0.85,
    mainP95: on.p95Ms <= off.p95Ms * 1.5 + 3,
    jank: on.jankPct <= off.jankPct + 5,
    workerCost: on.workerMsPerRender <= off.workerMsPerRender * 1.5 + 0.05,
  };
  results.push({ browser, charts: 60, rateHz: 25, runs: 3, warmupMs: 3000, durationMs: 8000, off, on, checks, samples });
}
await mkdir("../../.cache/current-time-perf", { recursive: true });
await writeFile("../../.cache/current-time-perf/results.json", `${JSON.stringify(results, null, 2)}\n`);
for (const result of results) {
  console.log(JSON.stringify({ browser: result.browser, off: result.off, on: result.on, checks: result.checks }));
  assert(Object.values(result.checks).every(Boolean), `${result.browser}: performance regression (see .cache/current-time-perf/results.json)`);
}
