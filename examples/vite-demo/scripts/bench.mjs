/**
 * Bench runner: drives the /bench page (see src/pages/bench-demo) in a real
 * headed browser via Playwright and prints per-run + median results.
 *
 * Headed on purpose — this benchmark is compositor-bound (many OffscreenCanvas
 * presents per frame) and headless compositing is not representative.
 *
 * Usage (from examples/vite-demo, after `pnpm build`):
 *   pnpm bench --browser firefox
 *   pnpm bench --browser chromium --charts 60 --rate 25 --runs 3
 *
 * Prints one JSON line per run and a `median` summary line, so output can be
 * captured and diffed across builds.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";

const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const opts = {
  browser: arg("browser", "firefox"),
  charts: Number(arg("charts", "60")),
  rate: Number(arg("rate", "25")),
  duration: Number(arg("duration", "15000")),
  warmup: Number(arg("warmup", "5000")),
  runs: Number(arg("runs", "3")),
  port: Number(arg("port", "4361")),
  maxFps: Number(arg("maxFps", "0")), // 0 = library default (uncapped)
  emitBounds: arg("emitBounds", "1"), // "0" silences BOUNDS_UPDATE traffic
  axes: arg("axes", "1"), // "0" drops the external axis canvases
  labels: arg("labels", "1"), // "0" turns off tick labels
  grid: arg("grid", "1"), // "0" turns off grid lines
};

const browserType = { firefox, chromium }[opts.browser];
if (!browserType) {
  console.error(`unknown --browser "${opts.browser}" (use firefox|chromium)`);
  process.exit(1);
}
if (!existsSync(path.join(demoDir, "dist", "index.html"))) {
  console.error("dist/ not found — run `pnpm build` in examples/vite-demo first");
  process.exit(1);
}

/** Start `vite preview` and resolve once it responds. */
async function startPreview() {
  const child = spawn(
    "node",
    ["node_modules/vite/bin/vite.js", "preview", "--port", String(opts.port), "--strictPort"],
    { cwd: demoDir, stdio: "ignore" },
  );
  const url = `http://localhost:${opts.port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return { child, url };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill();
  throw new Error("vite preview did not come up");
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const { child: preview, url } = await startPreview();
const benchUrl =
  `${url}/bench?charts=${opts.charts}&rate=${opts.rate}` +
  `&duration=${opts.duration}&warmup=${opts.warmup}` +
  `&maxFps=${opts.maxFps}&emitBounds=${opts.emitBounds}` +
  `&axes=${opts.axes}&labels=${opts.labels}&grid=${opts.grid}`;

const results = [];
try {
  for (let run = 1; run <= opts.runs; run++) {
    // Fresh browser per run: clean worker pool, no cross-run warmup effects.
    const browser = await browserType.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(benchUrl);
    await page.bringToFront();
    await page.waitForFunction(() => window.__benchResult !== undefined, undefined, {
      timeout: opts.warmup + opts.duration + 60_000,
    });
    const result = await page.evaluate(() => window.__benchResult);
    await browser.close();
    results.push(result);
    console.log(JSON.stringify({ run, browser: opts.browser, ...flat(result) }));
  }
} finally {
  preview.kill();
}

function flat(r) {
  return {
    meanFps: round(r.main.meanFps),
    p50Ms: round(r.main.p50Ms),
    p95Ms: round(r.main.p95Ms),
    p99Ms: round(r.main.p99Ms),
    maxMs: round(r.main.maxMs),
    jankPct: round(r.main.jankRatio * 100),
    workerRendersPerSec: round(r.worker.rendersPerSec),
    workerBusyMsPerSec: round(r.worker.busyMsPerSec),
    frames: r.main.frames,
    statsReports: r.worker.statsReports,
    dpr: r.dpr,
  };
}

function round(v) {
  return Math.round(v * 10) / 10;
}

const flats = results.map(flat);
const summary = {};
for (const key of Object.keys(flats[0])) {
  summary[key] = round(median(flats.map((f) => f[key])));
}
console.log(
  JSON.stringify({ median: true, browser: opts.browser, runs: opts.runs, ...summary }),
);
