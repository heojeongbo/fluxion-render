/** Actual worker/canvas pixels, replay controls and live clock in both browsers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, firefox } from "playwright";

const port = 4362;
const preview = spawn("node", ["node_modules/vite/bin/vite.js", "preview", "--port", String(port), "--strictPort"], { stdio: "pipe" });
const url = `http://localhost:${port}`;
let startupError = "";
preview.stderr.on("data", (chunk) => { startupError += chunk; });
const artifacts = "../../.cache/current-time-e2e";
await mkdir(artifacts, { recursive: true });

async function pixels(chart, screenshot = false) {
  const png = screenshot ? await chart.screenshot({ animations: "disabled" }) : null;
  return chart.evaluate(async (element, base64) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (base64) {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } else {
      // Firefox's screenshot protocol can wait 10s for a continuously painted
      // surface. Read the actual worker-produced canvas bitmaps immediately so
      // a live 10s window cannot expire while the driver captures the image.
      const rect = element.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      for (const source of element.querySelectorAll("canvas")) {
        const bounds = source.getBoundingClientRect();
        ctx.drawImage(source, (bounds.x - rect.x) * dpr, (bounds.y - rect.y) * dpr, bounds.width * dpr, bounds.height * dpr);
      }
    }
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const columns = new Array(canvas.width).fill(0);
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] > 180 && data[i + 1] < 145 && data[i + 2] < 145) {
          columns[x]++;
          maxY = Math.max(maxY, y);
        }
      }
    }
    const peak = Math.max(...columns);
    return { x: columns.indexOf(peak), peak, maxY, width: canvas.width, height: canvas.height };
  }, png?.toString("base64") ?? null);
}

async function poll(fn, accept, message) {
  let last;
  const started = Date.now();
  const samples = [];
  for (let i = 0; i < 30; i++) {
    last = await fn();
    if (accept(last)) return last;
    samples.push({ elapsedMs: Date.now() - started, value: last });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${message}: ${JSON.stringify(samples)}`);
}

let browser;
try {
  await poll(async () => fetch(url).then(() => true).catch(() => false), Boolean, `preview failed ${startupError}`);
  for (const [name, browserType] of Object.entries({ chromium, firefox })) {
    browser = await browserType.launch({ headless: true });
    for (const renderer of ["2d", "webgl"]) {
      for (const axes of ["inline", "external", "bare"]) {
        // External canvases are unsupported by the engine's GL backend.
        if (renderer === "webgl" && axes === "external") continue;
        for (const dpr of [1, 2]) {
          console.log(`RUN ${name} ${renderer} ${axes} DPR=${dpr}`);
          const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: dpr });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("console", (m) => { if (m.type() === "error" || /no WebGL draw path|render error/.test(m.text())) errors.push(m.text()); });
          await page.goto(`${url}/current-time?renderer=${renderer}&axes=${axes}`);
          await page.getByTestId("ready").filter({ hasText: "ready" }).waitFor();
          const chart = page.getByTestId("current-time-chart");
          const read = () => pixels(chart);
          const inset = axes === "bare" ? 0 : 40 * dpr;
          const bottom = axes === "bare" ? 0 : 24 * dpr;
          const at = (fraction) => poll(read, (p) => p.peak > p.height * 0.7 && Math.abs(p.x - (inset + (p.width - inset) * fraction)) <= 4 * dpr, `playhead at ${fraction}`);
          await at(0.25);
          const slider = page.getByRole("slider", { name: "Playback time" });
          await slider.fill("7500");
          const p = await at(0.75);
          assert(p.maxY < p.height - bottom + 1, "bar painted into x-axis strip");
          await slider.fill("0");
          await at(0);
          await slider.fill("10000");
          await at(1);
          await page.getByRole("checkbox", { name: "Show current time" }).uncheck();
          await poll(read, (p) => p.peak === 0, "hidden bar");
          await page.getByRole("checkbox", { name: "Show current time" }).check();
          await slider.fill("2500");
          await page.getByRole("button", { name: "Play", exact: true }).click();
          await poll(async () => Number(await slider.inputValue()), (t) => t > 3000, "replay advances");
          await page.getByRole("button", { name: "Pause", exact: true }).click();
          // Wait for React to commit the pause before sampling its controlled input.
          await page.getByRole("button", { name: "Play", exact: true }).waitFor();
          const held = await slider.inputValue();
          await new Promise((r) => setTimeout(r, 150));
          assert.equal(await slider.inputValue(), held, "pause holds");
          await page.getByRole("button", { name: "Live clock" }).click();
          await page.getByRole("button", { name: "Live clock", pressed: true }).waitFor();
          // A click can finish before the worker replaces the paused frame.
          // Start from the reset live window, leaving room to observe motion.
          const first = await poll(read, (p) => p.peak > p.height * 0.7 && p.x >= inset && p.x < inset + (p.width - inset) * 0.5, "live bar resets into the first half of the plot");
          await poll(read, (p) => p.x > first.x + 20 * dpr, `live clock advances without data from ${JSON.stringify(first)}`);
          await slider.fill("5000");
          await at(0.5);
          await page.setViewportSize({ width: 1000, height: 700 });
          const actual = await at(0.5);
          const captured = await pixels(chart, true);
          assert(captured.peak > captured.height * 0.7 && Math.abs(captured.x - actual.x) <= 4 * dpr, "canvas pixels match the browser screenshot");
          await chart.screenshot({ path: `${artifacts}/${name}-${renderer}-${axes}-${dpr}.png` });
          assert.deepEqual(errors, [], "browser errors");
          console.log(`PASS ${name} ${renderer} ${axes} DPR=${dpr}: seek, boundaries, hide, play, pause, live, resize`);
          await context.close();
        }
      }
    }
    await browser.close();
    browser = null;
  }
} finally {
  await browser?.close();
  preview.kill();
}
