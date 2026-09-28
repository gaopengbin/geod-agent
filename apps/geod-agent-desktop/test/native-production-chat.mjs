import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Windows WebView2 is required");
const exe = resolve(process.argv[2] || "");
if (!existsSync(exe)) throw new Error("Usage: node native-production-chat.mjs <installed-exe> [screenshot.png]");
const screenshot = process.argv[3] ? resolve(process.argv[3]) : null;
const port = 9233;
const prompt = "请先调用 sources_list 读取本机已登记图源，然后只回答图源名称。不要规划、审批或下载。";
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
  const before = await evaluate("window.__TAURI_INTERNALS__.invoke('agent_usage')");
  const oldCount = await evaluate("document.querySelectorAll('.conversation-item').length");
  await evaluate("document.querySelector('.conversation-sidebar-head button').click()");
  await waitFor(() => evaluate(`document.querySelectorAll('.conversation-item').length > ${oldCount}`), "new conversation");
  await evaluate(`(() => { const field = document.querySelector('.agent-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(prompt)}); field.dispatchEvent(new Event('input', { bubbles: true })); field.form.requestSubmit(); })()`);
  const result = await waitFor(async () => {
    const value = await evaluate("({ error: document.querySelector('.agent-error')?.innerText || null, tool: [...document.querySelectorAll('.agent-message.tool')].some(item => item.innerText.includes('sources_list')), answer: [...document.querySelectorAll('.agent-message.assistant')].at(-1)?.innerText || null, busy: !!document.querySelector('.agent-thinking'), plan: !!document.querySelector('.agent-plan-ready') })");
    if (value.error) throw new Error(`Native conversation error: ${value.error}`);
    return value.tool && value.answer && !value.busy ? value : null;
  }, "local tool and final assistant reply", 120_000);
  assert.equal(result.plan, false, "The read-only conversation must not create a download plan");
  assert.match(result.answer, /USGS|NAIP/i);
  const after = await evaluate("window.__TAURI_INTERNALS__.invoke('agent_usage')");
  assert.ok(after.committedTokens > before.committedTokens);
  assert.equal(after.reservedTokens, 0);
  if (screenshot) {
    const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
  }
  console.log(JSON.stringify({ auth: status.state, flow: "desktop composer → production DeepSeek → local sources_list → final reply", chargedTokens: after.committedTokens - before.committedTokens, reservedTokens: after.reservedTokens, screenshot: screenshot ? "saved" : "none" }));
} finally {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.fail(new Error("CDP session closed")); }
  pending.clear();
  socket?.close();
  if (app?.exitCode === null) {
    app.kill();
    await delay(600);
  }
}
