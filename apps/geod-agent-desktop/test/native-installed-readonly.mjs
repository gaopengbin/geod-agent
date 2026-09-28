import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Windows WebView2 is required");
const exe = resolve(process.argv[2] || "");
const jobId = process.argv[3];
if (!existsSync(exe) || !/^[0-9a-f-]{36}$/i.test(jobId || "")) {
  throw new Error("Usage: node native-installed-readonly.mjs <installed-exe> <approved-completed-job-id>");
}

const port = 9231;
let app;
let socket;
let serial = 0;
const pending = new Map();

async function portIsFree() {
  await new Promise((done, fail) => {
    const probe = connect(port, "127.0.0.1");
    probe.once("connect", () => { probe.destroy(); fail(new Error(`Debug port ${port} is in use`)); });
    probe.once("error", () => done());
    probe.setTimeout(1000, () => { probe.destroy(); fail(new Error(`Cannot check debug port ${port}`)); });
  });
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app?.exitCode !== null) throw new Error(`Installed app exited before ${label}: ${app.exitCode}`);
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function command(method, params = {}) {
  const id = ++serial;
  return new Promise((done, fail) => {
    const timeout = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { done, fail, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function invoke(name, args = {}) {
  const expression = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`;
  const value = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
  return value.result.value;
}

try {
  await portIsFree();
  app = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
    windowsHide: true,
  });
  const page = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return null;
      return (await response.json()).find(item => item.title === "GeoD Agent");
    } catch { return null; }
  }, "GeoD Agent WebView2");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
  socket.addEventListener("message", event => {
    const result = JSON.parse(event.data);
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    clearTimeout(request.timeout);
    result.error ? request.fail(new Error(result.error.message)) : request.done(result.result);
  });
  await command("Runtime.enable");

  const auth = await invoke("auth_status");
  assert.match(auth.state, /^(unconfigured|disconnected|waiting|connected)$/);
  const job = await invoke("jobs_get", { jobId });
  assert.equal(job?.state, "completed");
  const manifest = await invoke("artifacts_inspect", { jobId });
  assert.equal(manifest.quality.status, "complete");
  assert.equal(manifest.quality.missingTiles, 0);
  assert.ok(manifest.assets.some(asset => asset.mimeType === "image/tiff" && asset.width === 30 && asset.height === 38));
  assert.ok(manifest.assets.some(asset => asset.mimeType === "application/vnd.mbtiles"));
  const preview = await invoke("artifact_preview", { jobId });
  assert.match(preview?.dataUrl || "", /^data:image\/png;base64,/);
  console.log(JSON.stringify({ installedExe: exe, authState: auth.state, jobId, jobState: job.state, assets: manifest.assets.length, missingTiles: manifest.quality.missingTiles, preview: "verified PNG" }));
} finally {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.fail(new Error("Smoke test closed")); }
  pending.clear();
  socket?.close();
  app?.kill();
}
