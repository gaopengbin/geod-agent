import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Windows WebView2 is required");
const exe = resolve(process.argv[2] || "");
const screenshot = resolve(process.argv[3] || "");
if (!existsSync(exe) || !process.argv[3]) throw new Error("Usage: node native-approved-ui-flow.mjs <installed-exe> <screenshot.png>");
const approved = {
  planId: "tool-2dc690ae7ce5d3d0d74a7197860bbc766f33ed5729cbbda6862bf9bebc286a17",
  hash: "57f3a91700b7fd96757b0a7e52cee8593857b6391609f09182fd0a546495deb8",
  output: "C:\\Users\\Administrator\\Documents\\GeoD Agent\\imagery-20260928-143511-e679111b",
};
const port = 9234;
let app;
let socket;
let serial = 0;
let job = null;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app?.exitCode !== null) throw new Error(`Installed app exited before ${label}: ${app.exitCode}`);
    const value = await check();
    if (value) return value;
    await delay(350);
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
async function evaluate(expression) {
  const value = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
  return value.result.value;
}
async function invoke(name, args = {}) {
  return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
}

try {
  assert.equal(existsSync(approved.output), false, "Approved output already exists");
  await new Promise((done, fail) => {
    const probe = connect(port, "127.0.0.1");
    probe.once("connect", () => { probe.destroy(); fail(new Error(`Debug port ${port} is in use`)); });
    probe.once("error", done);
    probe.setTimeout(1000, () => { probe.destroy(); fail(new Error(`Cannot check debug port ${port}`)); });
  });
  app = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore", windowsHide: false,
  });
  const page = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      return response.ok ? (await response.json()).find(item => item.title === "GeoD Agent") : null;
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
  await command("Page.enable");

  const status = await invoke("auth_status");
  assert.equal(status.state, "connected");
  const stored = await invoke("plans_get", { planId: approved.planId });
  assert.equal(stored.plan.planHash, approved.hash);
  assert.equal(resolve(stored.plan.spec.outputDirectory), resolve(approved.output));
  assert.equal(stored.plan.spec.sourceId, "usgs-naip-plus-conus");
  assert.deepEqual(stored.plan.spec.bounds, [-77.05, 38.85, -77.04, 38.86]);
  assert.deepEqual(stored.plan.spec.zoomLevels, [18]);
  assert.deepEqual(stored.plan.spec.outputFormats, ["geotiff", "mbtiles"]);
  assert.equal(stored.plan.totalTiles, 90);
  assert.equal(stored.plan.requiredFreeDiskBytes, 114098176);
  const existing = await invoke("jobs_for_plan", { planId: approved.planId });
  if (existing) {
    assert.equal(existing.planHash, approved.hash);
    assert.equal(existing.state, "failed", "Only an existing failed job can be retried by this harness");
  } else assert.ok(Date.parse(stored.plan.expiresAt) > Date.now() + 60_000, "New approval requires a live plan");
  console.log(JSON.stringify({ phase: "preflight", planHash: approved.hash, tiles: 90, output: approved.output, existingJob: existing?.jobId || null, appPid: app.pid }));

  const chatPosition = await waitFor(async () => evaluate(`(() => { const raw = localStorage.getItem('geod-agent-conversations-0.1:account:' + ${JSON.stringify(status.userId)}); const chats = JSON.parse(raw || '[]'); return chats.findIndex(chat => chat.planId === ${JSON.stringify(approved.planId)}) + 1; })()`), "approved plan conversation");
  await evaluate(`document.querySelectorAll('.conversation-item')[${chatPosition - 1}].click()`);
  await waitFor(() => evaluate("!document.querySelector('#agent-results')?.hidden && !!document.querySelector('.summary-card')"), "plan review drawer");
  const review = await evaluate("document.querySelector('.summary-card')?.innerText || ''");
  assert.match(review, /90/);
  assert.match(review, /Z18/);
  assert.ok(review.includes(approved.output), "UI plan does not show the approved save path");
  if (existing) {
    await waitFor(() => evaluate("!![...document.querySelectorAll('.job-actions button')].find(button => button.innerText.includes('重试作业'))"), "retry button");
    await evaluate("[...document.querySelectorAll('.job-actions button')].find(button => button.innerText.includes('重试作业')).click()");
    job = await waitFor(async () => {
      const current = await invoke("jobs_get", { jobId: existing.jobId });
      return current?.state !== "failed" ? current : null;
    }, "resumed approved job", 30_000);
    assert.equal(job.jobId, existing.jobId);
  } else {
    await evaluate("document.querySelector('.approval-card input[type=checkbox]').click()");
    await waitFor(() => evaluate("!document.querySelector('.approval-card button.wide-button')?.disabled"), "enabled approval button");
    await evaluate("document.querySelector('.approval-card button.wide-button').click()");
    job = await waitFor(() => invoke("jobs_for_plan", { planId: approved.planId }), "approved job", 30_000);
  }
  assert.equal(job.planHash, approved.hash);
  writeFileSync(resolve(screenshot, "..", "native-approved-ui-job-id.txt"), `${job.jobId}\n`);
  console.log(JSON.stringify({ phase: "started", jobId: job.jobId, state: job.state, appPid: app.pid }));

  const deadline = Date.now() + 15 * 60_000;
  let lastProgress = "";
  while (!new Set(["completed", "partial", "failed", "cancelled"]).has(job.state) && Date.now() < deadline) {
    await delay(2500);
    job = await invoke("jobs_get", { jobId: job.jobId });
    assert.ok(job, "Approved job disappeared");
    const events = await invoke("jobs_events", { jobId: job.jobId, afterSeq: 0 });
    const latest = events.at(-1);
    const progress = latest?.totalTiles ? `${latest.completedTiles ?? 0}/${latest.totalTiles}` : job.state;
    if (progress !== lastProgress) {
      lastProgress = progress;
      console.log(JSON.stringify({ phase: "progress", jobId: job.jobId, state: job.state, progress }));
    }
  }
  if (!new Set(["completed", "partial", "failed", "cancelled"]).has(job.state)) throw new Error(`Job ${job.jobId} still running after observation deadline`);
  assert.equal(job.state, "completed", `Job ended as ${job.state}`);
  const manifest = await invoke("artifacts_inspect", { jobId: job.jobId });
  const preview = await invoke("artifact_preview", { jobId: job.jobId });
  assert.equal(manifest.quality.status, "complete");
  assert.equal(manifest.quality.missingTiles, 0);
  assert.equal(manifest.assets.length, 3);
  assert.match(preview.dataUrl, /^data:image\/png;base64,/);
  await waitFor(() => evaluate("!!document.querySelector('.artifact-card') && document.querySelector('.map-footer')?.innerText.includes('已校验影像')"), "verified UI results", 30_000);
  await delay(1200);
  const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
  console.log(JSON.stringify({ phase: "verified", jobId: job.jobId, state: job.state, missingTiles: 0, assets: 3, ui: "chat → review → approve → download → map result", screenshot }));
} finally {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.fail(new Error("CDP session closed")); }
  pending.clear();
  socket?.close();
  if (app?.exitCode === null && (!job || new Set(["completed", "partial", "failed", "cancelled"]).has(job.state))) {
    app.kill();
    await delay(600);
  } else app?.unref();
}
