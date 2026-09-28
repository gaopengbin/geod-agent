import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Windows WebView2 is required");
const exe = resolve(process.argv[2] || "");
const specPath = resolve(process.argv[3] || "");
const descriptorPath = resolve(process.argv[4] || "");
const approvedHash = process.argv[5];
if (!existsSync(exe) || !existsSync(specPath) || !existsSync(descriptorPath) || !/^[0-9a-f]{64}$/.test(approvedHash || "")) {
  throw new Error("Usage: node native-approved-job.mjs <installed-exe> <task-spec.json> <source-descriptor.json> <approved-plan-hash>");
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const source = JSON.parse(readFileSync(descriptorPath, "utf8"));
const output = resolve(spec.outputDirectory);
assert.equal(source.id, spec.sourceId);
assert.equal(source.bulkDownloadAllowed, true);
assert.equal(source.configRevision, "4f3d31417c9374032d2fb96a4bf84f7fdc5131476bd7ed35ccd6eaf35983d489");
assert.deepEqual(spec.bounds, [-77.05, 38.85, -77.04, 38.86]);
assert.deepEqual(spec.zoomLevels, [18]);
assert.deepEqual(spec.outputFormats, ["geotiff", "mbtiles"]);
assert.equal(spec.sourceId, "usgs-naip-plus-conus");
assert.ok(output.endsWith("native-approved-usgs-z18-20260928"));

const port = 9232;
const toolExecutionId = `user-approved-z18-20260928-${approvedHash.slice(0, 16)}`;
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
  for (let attempt = 0; attempt < 120; attempt++) {
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
    const timeout = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 20_000);
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
    windowsHide: false,
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

  const sources = await invoke("sources_list");
  const registered = sources.find(item => item.id === source.id);
  assert.ok(registered, "Approved source is no longer registered");
  assert.equal(registered.configRevision, source.configRevision, "Approved source revision changed");

  const stored = await invoke("plans_create", { spec, toolExecutionId });
  assert.equal(stored.plan.planHash, approvedHash, "Plan changed from the user's approved parameters");
  assert.equal(stored.plan.totalTiles, 90);
  assert.equal(stored.plan.requiredFreeDiskBytes, 114098176);
  assert.equal(resolve(stored.plan.spec.outputDirectory), output);
  console.log(JSON.stringify({ phase: "planned", planId: stored.planId, planHash: stored.plan.planHash, tiles: stored.plan.totalTiles, appPid: app.pid }));

  let job = await invoke("jobs_for_plan", { planId: stored.planId });
  if (!job) {
    assert.ok(!existsSync(output), "Output directory already exists; no download started");
    assert.ok(Date.parse(stored.plan.expiresAt) > Date.now(), "Plan expired before approval");
    const approval = await invoke("approvals_grant", { planId: stored.planId, planHash: approvedHash });
    assert.equal(approval.planHash, approvedHash);
    job = await invoke("jobs_start", { planId: stored.planId, planHash: approvedHash, approvalId: approval.approvalId, idempotencyKey: toolExecutionId });
  }
  writeFileSync(resolve(specPath, "..", "z18-job-id.txt"), `${job.jobId}\n`, { flag: "w" });
  console.log(JSON.stringify({ phase: "started", jobId: job.jobId, state: job.state, appPid: app.pid }));

  let lastProgress = "";
  const deadline = Date.now() + 15 * 60_000;
  while (!new Set(["completed", "partial", "failed", "cancelled"]).has(job.state) && Date.now() < deadline) {
    await delay(2500);
    job = await invoke("jobs_get", { jobId: job.jobId });
    assert.ok(job, "Job vanished from the installed app ledger");
    const events = await invoke("jobs_events", { jobId: job.jobId, afterSeq: 0 });
    const latest = events.at(-1);
    const progress = latest?.totalTiles ? `${latest.completedTiles ?? 0}/${latest.totalTiles}` : job.state;
    if (progress !== lastProgress) {
      lastProgress = progress;
      console.log(JSON.stringify({ phase: "progress", jobId: job.jobId, state: job.state, progress }));
    }
  }
  if (!new Set(["completed", "partial", "failed", "cancelled"]).has(job.state)) throw new Error(`Job ${job.jobId} is still live after observation deadline`);
  if (job.state !== "completed" && job.state !== "partial") throw new Error(`Job ${job.jobId} ended as ${job.state}`);

  const manifest = await invoke("artifacts_inspect", { jobId: job.jobId });
  const preview = await invoke("artifact_preview", { jobId: job.jobId });
  assert.equal(manifest.quality.status, job.state === "completed" ? "complete" : "partial");
  assert.ok(manifest.assets.some(asset => asset.mimeType === "image/tiff"));
  assert.ok(manifest.assets.some(asset => asset.mimeType === "application/vnd.mbtiles"));
  assert.match(preview?.dataUrl || "", /^data:image\/png;base64,/);
  console.log(JSON.stringify({ phase: "verified", jobId: job.jobId, state: job.state, assets: manifest.assets.length, missingTiles: manifest.quality.missingTiles, preview: "verified PNG", appPid: app.pid }));
} finally {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.fail(new Error("CDP session closed")); }
  pending.clear();
  socket?.close();
  // Leave the installed app open so the task can continue if observation fails,
  // and so the user can inspect the result in the native window.
  app?.unref();
}
