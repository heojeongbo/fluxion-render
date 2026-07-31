/**
 * Scroll-grid bench: measures the worker render savings from `pauseWhenOffscreen`.
 *
 * Drives /scroll-grid in a real headed browser, scrolls so most charts are
 * off-screen, and reports the aggregate worker busy-ms/sec (summed across every
 * host's RENDER_STATS) with the option ON vs OFF. A paused off-screen engine
 * stops rendering, so it drops out of the total — the delta is the pure render
 * saving (data keeps flowing to every chart in both cases via one shared feed).
 *
 * Usage (from examples/vite-demo, after `pnpm build`):
 *   pnpm scroll-bench --browser chromium --charts 60
 *   pnpm scroll-bench --browser firefox  --charts 200 --runs 3
 *
 * Standing convention: run BOTH chromium and firefox for any perf claim.
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
  browser: arg("browser", "chromium"),
  charts: Number(arg("charts", "60")),
  warmup: Number(arg("warmup", "3000")),
  measure: Number(arg("measure", "6000")),
  runs: Number(arg("runs", "3")),
  port: Number(arg("port", "4362")),
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
const round = (n) => Math.round(n * 10) / 10;

/** One measurement: load, scroll most charts off-screen, sample the aggregate. */
async function measureOnce(url, pause) {
  const browser = await browserType.launch({ headless: false });
  const page = await (
    await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
  ).newPage();
  await page.goto(`${url}/scroll-grid?charts=${opts.charts}&pause=${pause ? 1 : 0}`);
  await page.bringToFront();
  await page.waitForFunction(() => typeof window.__scrollBench === "function", undefined, {
    timeout: 30_000,
  });
  // Scroll to the bottom so the top charts fall off-screen.
  await page.$eval('[data-testid="scroll-container"]', (el) => {
    el.scrollTop = 10_000_000;
  });
  await page.waitForTimeout(opts.warmup);
  await page.evaluate(() => window.__scrollBenchReset());
  await page.waitForTimeout(opts.measure);
  const r = await page.evaluate(() => window.__scrollBench());
  await browser.close();
  return r;
}

const { child: preview, url } = await startPreview();
const on = [];
const off = [];
try {
  for (let run = 1; run <= opts.runs; run++) {
    const rOn = await measureOnce(url, true);
    on.push(rOn);
    console.log(JSON.stringify({ run, browser: opts.browser, pause: "on", ...fmt(rOn) }));
    const rOff = await measureOnce(url, false);
    off.push(rOff);
    console.log(JSON.stringify({ run, browser: opts.browser, pause: "off", ...fmt(rOff) }));
  }
} finally {
  preview.kill();
}

const onBusy = median(on.map((r) => r.busyMsPerSec));
const offBusy = median(off.map((r) => r.busyMsPerSec));
console.log(
  JSON.stringify({
    median: true,
    browser: opts.browser,
    charts: opts.charts,
    busyMsPerSec_off: round(offBusy),
    busyMsPerSec_on: round(onBusy),
    reductionPct: round((1 - onBusy / offBusy) * 100),
    rendersPerSec_off: round(median(off.map((r) => r.rendersPerSec))),
    rendersPerSec_on: round(median(on.map((r) => r.rendersPerSec))),
    mainFps_off: round(median(off.map((r) => r.mainFps))),
    mainFps_on: round(median(on.map((r) => r.mainFps))),
    jankPct_off: round(median(off.map((r) => r.jankPct))),
    jankPct_on: round(median(on.map((r) => r.jankPct))),
  }),
);

function fmt(r) {
  return {
    busyMsPerSec: round(r.busyMsPerSec),
    rendersPerSec: round(r.rendersPerSec),
    mainFps: round(r.mainFps),
    jankPct: round(r.jankPct),
    total: r.total,
  };
}
