import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Windows WebView2 is required");
const exe = resolve(process.argv[2] || "");
if (!existsSync(exe)) throw new Error("Usage: node native-production-chat.mjs <installed-exe> [screenshot.png] [sources|plan|results]");
const screenshot = process.argv[3] ? resolve(process.argv[3]) : null;
const mode = process.argv[4] || "sources";
if (!new Set(["sources", "plan", "results"]).has(mode)) throw new Error("Mode must be sources, plan or results");
const port = 9233;
const prompt = mode === "plan"
  ? "请调用 sources_list 后，使用 USGS NAIP Plus 为 WGS84 范围 [-77.05,38.85,-77.04,38.86]、Z18、GeoTIFF 和 MBTiles 生成本机计划。只生成计划，等待我在成果页确认，不要审批或下载。"
  : "请先调用 sources_list 读取本机已登记图源，然后只回答图源名称。不要规划、审批或下载。";
let app;
let socket;
let serial = 0;
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
async function capture() {
  if (!screenshot) return;
  const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(screenshot, Buffer.from(result.data, "base64"));
}

try {
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

  const status = await evaluate("window.__TAURI_INTERNALS__.invoke('auth_status')");
  assert.equal(status.state, "connected", "Existing GeoD desktop credential must already be connected");
  await waitFor(() => evaluate("!!document.querySelector('.agent-composer textarea')"), "composer");
  if (mode === "results") {
    await evaluate("document.querySelector('[aria-label=\"展开成果页\"]')?.click()");
    await waitFor(() => evaluate("!![...document.querySelectorAll('.history-item')].find(item => item.innerText.includes('4db30bd9'))"), "approved Z18 job in history");
    await evaluate("[...document.querySelectorAll('.history-item')].find(item => item.innerText.includes('4db30bd9')).click()");
    const result = await waitFor(async () => {
      const value = await evaluate("({ artifact: document.querySelector('.artifact-card')?.innerText || null, map: document.querySelector('.map-footer')?.innerText || null, error: document.querySelector('.error-box')?.innerText || null })");
      if (value.error) throw new Error(`Native result error: ${value.error}`);
      return value.artifact?.includes('缺失瓦片') && value.map?.includes('已校验影像') ? value : null;
    }, "verified artifact and map overlay", 45_000);
    assert.match(result.artifact, /完整/);
    assert.match(result.artifact, /缺失瓦片\s*0/);
    await delay(1200);
    await capture();
    console.log(JSON.stringify({ auth: status.state, flow: "approved Z18 job → inspected manifest → OSM map overlay", missingTiles: 0, screenshot: screenshot ? "saved" : "none" }));
  } else {
  const before = await evaluate("window.__TAURI_INTERNALS__.invoke('agent_usage')");
  const oldCount = await evaluate("document.querySelectorAll('.conversation-item').length");
  await evaluate("document.querySelector('.conversation-sidebar-head button').click()");
  await waitFor(() => evaluate(`document.querySelectorAll('.conversation-item').length > ${oldCount}`), "new conversation");
  await evaluate(`(() => { const field = document.querySelector('.agent-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(prompt)}); field.dispatchEvent(new Event('input', { bubbles: true })); field.form.requestSubmit(); })()`);
  const result = await waitFor(async () => {
    const value = await evaluate("({ error: document.querySelector('.agent-error')?.innerText || document.querySelector('.error-box')?.innerText || null, tools: [...document.querySelectorAll('.agent-message.tool')].map(item => item.innerText), answer: [...document.querySelectorAll('.agent-message.assistant')].at(-1)?.innerText || null, busy: !!document.querySelector('.agent-thinking'), plan: !!document.querySelector('.agent-plan-ready'), results: !document.querySelector('#agent-results')?.hidden, planSummary: document.querySelector('.summary-card')?.innerText || '' })");
    if (value.error) throw new Error(`Native conversation error: ${value.error}`);
    const toolReady = value.tools.some(tool => tool.includes(mode === "plan" ? "plan_imagery" : "sources_list"));
    return toolReady && value.answer && !value.busy ? value : null;
  }, "local tool and final assistant reply", 120_000);
  assert.match(result.answer, /USGS|NAIP/i);
  if (mode === "sources") assert.equal(result.plan, false, "The read-only conversation must not create a download plan");
  else {
    assert.equal(result.plan, true, "The Agent must create a reviewable plan");
    assert.equal(result.results, true, "The plan should open the results drawer");
    assert.match(result.planSummary, /90/);
    assert.match(result.planSummary, /Z18/);
  }
  const after = await evaluate("window.__TAURI_INTERNALS__.invoke('agent_usage')");
  assert.ok(after.committedTokens > before.committedTokens);
  assert.equal(after.reservedTokens, 0);
  await capture();
  console.log(JSON.stringify({ auth: status.state, flow: mode === "plan" ? "desktop composer → production DeepSeek → local plan_imagery → review drawer" : "desktop composer → production DeepSeek → local sources_list → final reply", chargedTokens: after.committedTokens - before.committedTokens, reservedTokens: after.reservedTokens, screenshot: screenshot ? "saved" : "none" }));
  }
} finally {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.fail(new Error("CDP session closed")); }
  pending.clear();
  socket?.close();
  if (app?.exitCode === null) {
    app.kill();
    await delay(600);
  }
}
