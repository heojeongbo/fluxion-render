/**
 * Release guard: fail if the fluxion-render major version has drifted outside
 * the range replay declares in peerDependencies. (This caught the ">=0.14.0 <1"
 * vs render 1.x mismatch that ERESOLVE-failed consumer installs.)
 * Wired into replay's release-it `before:init`.
 */
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const render = JSON.parse(readFileSync(new URL("../../fluxion-render/package.json", here)));
const replay = JSON.parse(readFileSync(new URL("../package.json", here)));

const range = replay.peerDependencies?.["@heojeongbo/fluxion-render"];
const major = Number(render.version.split(".")[0]);
const upper = range?.match(/<\s*(\d+)/);
const lower = range?.match(/>=\s*(\d+)/);
const ok = (!upper || major < Number(upper[1])) && (!lower || major >= Number(lower[1]));

if (!range || !ok) {
  console.error(
    `[release guard] fluxion-render ${render.version} (major ${major}) is outside replay's ` +
      `declared peer range "${range}". Update packages/fluxion-replay/package.json ` +
      `peerDependencies["@heojeongbo/fluxion-render"] before releasing.`,
  );
  process.exit(1);
}
console.log(`[release guard] render major ${major} satisfies replay peer "${range}" ✓`);
