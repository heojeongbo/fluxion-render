import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, firefox } from "playwright";
const perf = process.argv.includes("--perf");
const port = 4363;
const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(port), "--strictPort"], { cwd: "../fluxion-replay-demo", stdio: "pipe" });
let startupError = ""; preview.stderr.on("data", chunk => { startupError += chunk; });
const artifacts = "../../.cache/reliability-e2e"; await mkdir(artifacts, { recursive: true });
const results = []; let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await fetch(`http://localhost:${port}/reliability.html`).then(r => r.ok).catch(() => false);
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `preview failed: ${startupError}`);
  for (const [name, type] of Object.entries({ chromium, firefox })) {
    browser = await type.launch({ headless: true }); const page = await browser.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://localhost:${port}/reliability.html`);
    await page.waitForFunction(() => Boolean(window.reliability));
    await page.bringToFront();
    if (perf) {
      assert.equal(await page.evaluate(() => document.visibilityState), "visible", "storage benchmark must run in a foreground page");
      results.push({ browser: name, performance: await page.evaluate(() => window.reliability.storagePerformance()) });
    } else {
      const scenarios = await page.evaluate(() => Object.keys(window.reliability.scenarios));
      for (const scenario of scenarios) {
        await page.evaluate(name => window.reliability.scenarios[name](), scenario);
        results.push({ browser: name, scenario, passed: true }); console.log(`PASS ${name}: ${scenario}`);
      }
      assert.equal(results.filter(r => r.browser === name).length, scenarios.length);
    }
    assert.deepEqual(errors, [], "uncaught browser errors");
    await page.screenshot({ path: `${artifacts}/${name}.png` }); await browser.close(); browser = null;
  }
} finally {
  await writeFile(`${artifacts}/${perf ? "performance" : "results"}.json`, JSON.stringify(results, null, 2));
  await browser?.close(); preview.kill();
}
