import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), "fluxion-consumer-"));
const packages = ["worker", "render", "replay"];
try {
  const modules = path.join(scratch, "node_modules");
  await mkdir(path.join(modules, "@heojeongbo"), { recursive: true });
  await writeFile(path.join(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  for (const slug of packages) {
    const output = path.join(scratch, `pack-${slug}`);
    await mkdir(output);
    execFileSync("pnpm", ["pack", "--pack-destination", output], { cwd: path.join(root, "packages", `fluxion-${slug}`), stdio: "pipe" });
    const tarballs = (await readdir(output)).filter(name => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const destination = path.join(modules, "@heojeongbo", `fluxion-${slug}`);
    await mkdir(destination);
    execFileSync("tar", ["-xzf", path.join(output, tarballs[0]), "--strip-components=1", "-C", destination]);
    const manifest = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"));
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
      for (const version of Object.values(manifest[section] ?? {})) assert(!version.startsWith("workspace:"), `${slug}: unpublished workspace range`);
    }
    if (slug === "render") {
      assert.equal(manifest.dependencies["@heojeongbo/fluxion-worker"], "^0.6.2", "render must reject worker 0.6.1, which lacks useDisposableResource");
    }
    if (slug === "worker") {
      const [major, minor, patch] = manifest.version.split(".").map(Number);
      assert(major > 0 || minor > 6 || (minor === 6 && patch >= 2), "worker must include the 0.6.2 resource lifecycle API");
    }
    const targets = Object.values(manifest.exports).flatMap(value => Object.values(value));
    for (const target of targets) await readFile(path.join(destination, target));
  }
  for (const dependency of ["react", "react-dom"]) await symlink(await realpath(path.join(root, "packages/fluxion-render/node_modules", dependency)), path.join(modules, dependency), "dir");
  await mkdir(path.join(modules, "@types"));
  for (const dependency of ["react", "react-dom"]) await symlink(await realpath(path.join(root, "packages/fluxion-render/node_modules/@types", dependency)), path.join(modules, "@types", dependency), "dir");
  const imports = packages.flatMap(slug => [`@heojeongbo/fluxion-${slug}`, `@heojeongbo/fluxion-${slug}/react`]).concat(["@heojeongbo/fluxion-render/testing", "@heojeongbo/fluxion-render/worker"]);
  await writeFile(path.join(scratch, "runtime.mjs"), `for (const name of ${JSON.stringify(imports)}) { const exported = await import(name); if (!Object.keys(exported).length) throw new Error(name); }\n`);
  execFileSync(process.execPath, ["runtime.mjs"], { cwd: scratch, stdio: "inherit" });
  await writeFile(path.join(scratch, "consumer.ts"), `
import { WorkerPool } from '@heojeongbo/fluxion-worker';
import { useWorkerPool } from '@heojeongbo/fluxion-worker/react';
import { FluxionHost, createFluxionWorkerFactory } from '@heojeongbo/fluxion-render';
import { FluxionCanvas, useFluxionWorkerPool, useHostRecyclePool } from '@heojeongbo/fluxion-render/react';
import { ReplayStore, ReplayPlayer, ReplaySession, createReplaySession, type FrameReader, type ReplayStorage } from '@heojeongbo/fluxion-replay';
const factory = createFluxionWorkerFactory();
const pool = new WorkerPool({ workerFactory: factory }); pool.dispose();
const reader: FrameReader = new ReplayStore();
const defaultStore: ReplayStore = new ReplaySession({ channels: [] }).store;
const adapter: ReplayStorage = new ReplayStore();
const customSession = createReplaySession({ channels: [], store: adapter });
const customStore: ReplayStorage = customSession.store;
void defaultStore; void customStore;
new ReplayPlayer({ store: reader, channels: new Map(), timeRange: { earliest: 0, latest: 100 } });
function Consumer() { useWorkerPool({ workerFactory: factory }).stats(); useFluxionWorkerPool({ size: 1, workerFactory: factory }).stats(); useHostRecyclePool().dispose(); return FluxionCanvas; }
void Consumer; void FluxionHost;
`);
  execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--lib", "ES2022,DOM", "consumer.ts"], { cwd: scratch, stdio: "inherit" });
  console.log(`PASS tarball consumer: ${imports.length} runtime entrypoints + TypeScript public APIs`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
