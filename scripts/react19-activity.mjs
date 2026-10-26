/**
 * React 19 consumer check, run by package-smoke.mjs from a scratch directory
 * whose node_modules holds the PACKED fluxion tarballs, react@19, react-dom@19
 * and happy-dom (it is copied there; bare imports must resolve from that dir).
 *
 * <Activity mode="hidden"> runs effect cleanups but keeps memoized state, so a
 * pool owned by a hook is disposed while hidden. Revealing must hand out a
 * live replacement — the package tests run React 18, which has no Activity.
 */
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "Element", "Event", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  const value = win[key];
  globalThis[key] = key === "window" ? win : typeof value === "function" && /^[a-z]/.test(key) ? value.bind(win) : value;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
win.HTMLCanvasElement.prototype.transferControlToOffscreen = () => ({ width: 1, height: 1 });
class FakeWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }
globalThis.Worker = FakeWorker;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDisposableResource, useWorkerPool } = await import("@heojeongbo/fluxion-worker/react");
const { FluxionCanvas, FluxionWorkerPool, useFluxionWorkerPool, useHostRecyclePool } = await import("@heojeongbo/fluxion-render/react");
assert.equal(React.version.split(".")[0], "19", "this check needs React 19");
assert.equal(typeof React.Activity, "symbol", "React.Activity is required");
const h = React.createElement;
const { act } = React;

async function hideAndReveal(label, Component, strict = false) {
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(`console.error: ${String(args[0]).slice(0, 120)}`);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onCaughtError: (e) => errors.push(`caught: ${e?.message}`),
    onUncaughtError: (e) => errors.push(`uncaught: ${e?.message}`),
  });
  const tree = (mode) => {
    const activity = h(React.Activity, { mode }, h(Component));
    return strict ? h(React.StrictMode, null, activity) : activity;
  };
  try {
    await act(async () => root.render(tree("visible")));
    const mounted = Component.current();
    await act(async () => root.render(tree("hidden")));
    await act(async () => { await Promise.resolve(); });
    assert.equal(mounted.isDisposed, true, `${label}: hiding must release the resource`);
    await act(async () => root.render(tree("visible")));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const revealed = Component.current();
    assert.equal(revealed.isDisposed, false, `${label}: revealed a disposed resource`);
    assert.notEqual(revealed, mounted, `${label}: reveal must hand out a fresh instance`);
    assert.deepEqual(errors, [], `${label}: errors after reveal`);
    await act(async () => root.unmount());
  } finally {
    console.error = consoleError;
  }
  console.log(`PASS React ${React.version} <Activity>: ${label}${strict ? " (StrictMode)" : ""}`);
}

function component(useResource, withCanvas) {
  let last;
  const Component = () => {
    last = useResource();
    return withCanvas ? h(FluxionCanvas, { hostOptions: { pool: last }, layers: [] }) : null;
  };
  Component.current = () => last;
  return Component;
}
const workerFactory = () => new FakeWorker();
const scenarios = [
  ["useWorkerPool", component(() => useWorkerPool({ size: 1, workerFactory }), false)],
  ["useFluxionWorkerPool + FluxionCanvas", component(() => useFluxionWorkerPool({ size: 1, workerFactory }), true)],
  ["useHostRecyclePool", component(() => useHostRecyclePool(), false)],
  // No start() effect: FluxionCanvas's disposed-pool guard used to re-render forever.
  ["useDisposableResource(FluxionWorkerPool) + FluxionCanvas", component(() => useDisposableResource(() => new FluxionWorkerPool({ size: 1, workerFactory })), true)],
];
for (const [label, Component] of scenarios) await hideAndReveal(label, Component);
await hideAndReveal("useFluxionWorkerPool + FluxionCanvas", scenarios[1][1], true);
process.exit(0);
