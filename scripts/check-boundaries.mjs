import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const violations = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (/\.tsx?$/.test(file) && !/\.(test|bench)\./.test(file)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
        if (!match[1].startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), match[1]);
        if (/\/src\/(entities|features|widgets|app)\//.test(resolved)) violations.push(`${path.relative(root, file)} → ${match[1]}`);
      }
    }
  }
}
for (const slug of ["render", "replay"]) {
  const dir = path.join(root, "packages", `fluxion-${slug}`, "src", "shared");
  await visit(dir);
}
assert.deepEqual(violations, [], "Shared contracts must not import higher layers");
console.log("PASS shared-layer dependency boundaries (render, replay)");
