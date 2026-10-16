import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(await realpath(path.join(root, "packages/fluxion-render/node_modules/tsup/package.json")));
const { build } = require("esbuild");
const output = path.join(root, ".cache/render-performance");
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, "packages/fluxion-render/src/shared/model/ring-buffer.ts")], outfile: path.join(output, "ring.mjs"), platform: "node", format: "esm", bundle: true });
const { RingBuffer } = await import(pathToFileURL(path.join(output, "ring.mjs")).href);
const ring = new RingBuffer(500_000, 2);
for (let i = 0; i < ring.capacity; i++) ring.push([i, i % 100]);
const from = 450_000, to = 451_000;
let visited = 0, indexedSum = 0, fullSum = 0;
ring.forEachRange(from, to, (data, offset) => { visited++; indexedSum += data[offset + 1]; });
ring.forEach((data, offset) => { if (data[offset] >= from && data[offset] <= to) fullSum += data[offset + 1]; });
assert.equal(indexedSum, fullSum); assert.equal(visited, to - from + 1);
let checksum = 0;
const full = () => ring.forEach((data, offset) => { if (data[offset] >= from && data[offset] <= to) checksum += data[offset + 1]; });
const indexed = () => ring.forEachRange(from, to, (data, offset) => { checksum += data[offset + 1]; });
function measure(fn) {
  for (let i = 0; i < 20; i++) fn();
  const runs = [];
  for (let run = 0; run < 7; run++) { const start = performance.now(); for (let i = 0; i < 100; i++) fn(); runs.push((performance.now() - start) / 100); }
  return runs.sort((a, b) => a - b)[3];
}
const fullScanMs = measure(full), visibleScanMs = measure(indexed);
const result = { node: process.version, retained: ring.length, visible: visited, fullScanMs, visibleScanMs, ratio: fullScanMs / visibleScanMs, checksum };
assert(visibleScanMs < fullScanMs, "visible-window traversal regressed to full-history cost");
await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
