import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createGatewayServer, readConfig } from "../server.mjs";

assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for this optional native smoke test");
if (process.platform !== "win32") throw new Error("This smoke test requires Windows WebView2");
const exe = process.env.GEOD_AGENT_EXE || resolve(import.meta.dirname, "../../../apps/geod-agent-desktop/src-tauri/target/release/geod-agent-desktop.exe");
const folder = mkdtempSync(resolve(tmpdir(), "geod-native-deepseek-"));
const boundaryPath = resolve(folder, "native-test-boundary.geojson");
const boundaryText = JSON.stringify({ type: "Polygon", coordinates: [[[-77.05, 38.85], [-77.04, 38.85], [-77.04, 38.86], [-77.05, 38.86], [-77.05, 38.85]]] });
writeFileSync(boundaryPath, boundaryText);
const upstreamIdentity = process.env.GEOD_OAUTH_UPSTREAM_ORIGIN;
const browserCookie = process.env.GEOD_OAUTH_BROWSER_COOKIE;
if (upstreamIdentity && (!browserCookie || !process.env.GEOD_OAUTH_GATEWAY_SECRET)) throw new Error("Real identity smoke test needs the browser session cookie and gateway secret");
if (upstreamIdentity) {
  const upstream = new URL(upstreamIdentity);
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) || upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error("Real identity smoke test accepts only a local loopback origin");
}
const gatewaySecret = process.env.GEOD_OAUTH_GATEWAY_SECRET || randomBytes(32).toString("hex");
const code = randomBytes(32).toString("base64url");
const accessToken = randomBytes(32).toString("base64url");
const refreshToken = randomBytes(32).toString("base64url");
const prompt = "请先调用 sources_list 查询本机已授权图源，再根据工具结果回答。不要猜测图源。";
let challenge = ""; let redirectUri = ""; let tokenIssued = false;
let smokeConversationId = "";
let identityServer; let gateway; let app; let socket; let nextId = 0; let shuttingDown = false;
const pending = new Map();
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
async function ensureDebugPortFree() {
  await new Promise((resolve, reject) => {
    const probe = connect(9228, "127.0.0.1");
    probe.once("connect", () => { probe.destroy(); reject(new Error("WebView2 debug port 9228 is already in use")); });
    probe.once("error", () => resolve());
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Cannot verify WebView2 debug port 9228")); });
  });
}
async function waitFor(task, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await task();
    if (result) return result;
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

try {
  await ensureDebugPortFree();
  identityServer = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (upstreamIdentity) {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (!["host", "connection", "content-length", "accept-encoding"].includes(name) && typeof value === "string") headers.set(name, value);
        }
        if (url.pathname === "/api/geod/oauth/authorize") {
          headers.set("cookie", browserCookie);
          if (request.method === "POST") headers.set("origin", upstreamIdentity);
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(`${upstreamIdentity}${request.url}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        let body = Buffer.from(await upstream.arrayBuffer());
        const allowed = ["content-type", "location", "cache-control", "content-security-policy", "referrer-policy"];
        const responseHeaders = Object.fromEntries(allowed.map(name => [name, upstream.headers.get(name)]).filter(([, value]) => value));
        if (request.method === "GET" && url.pathname === "/api/geod/oauth/authorize" && upstream.status === 200) {
          // The isolated test account gives consent through the real POST route.
          body = Buffer.from(body.toString("utf8").replace("</html>", "<script>document.forms[0].submit()</script></html>"));
          delete responseHeaders["content-security-policy"];
        }
        response.writeHead(upstream.status, responseHeaders);
        response.end(body);
      } catch (error) { response.writeHead(502); response.end(`OAuth test proxy: ${error.message}`); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/geod/oauth/authorize") {
      if (!url.searchParams.has("client_id")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "INVALID_OAUTH_REQUEST" } }));
        return;
      }
      assert.equal(url.searchParams.get("client_id"), "geod-agent-desktop");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      challenge = url.searchParams.get("code_challenge") || "";
      redirectUri = url.searchParams.get("redirect_uri") || "";
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state") || "");
      response.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/geod/oauth/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), code);
      assert.equal(form.get("redirect_uri"), redirectUri);
      assert.equal(createHash("sha256").update(form.get("code_verifier") || "").digest("base64url"), challenge);
      tokenIssued = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, user_id: "native-live-smoke", expires_in: 3600, token_type: "Bearer" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/geod/oauth/introspect") {
      let body = ""; for await (const chunk of request) body += chunk;
      const valid = request.headers.authorization === `Bearer ${gatewaySecret}` && JSON.parse(body).token === accessToken;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ active: valid ? { userId: "native-live-smoke", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } : null }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/geod/oauth/revoke") {
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
    }
    response.writeHead(404); response.end();
  });
  const identityOrigin = await listen(identityServer);
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: gatewaySecret, GEOD_IDENTITY_ORIGIN: identityOrigin, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: "deepseek-flash", GEOD_AGENT_DB_PATH: resolve(folder, "gateway.sqlite") });
  gateway = createGatewayServer(config);
  const gatewayOrigin = await listen(gateway);
  app = spawn(exe, [], { env: { ...process.env, GEOD_AGENT_IDENTITY_ORIGIN: identityOrigin, GEOD_AGENT_GATEWAY_ORIGIN: gatewayOrigin, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9228" }, stdio: "ignore", windowsHide: true });
  app.on("error", error => { console.error(`Native app launch failed: ${error.message}`); });
  app.on("exit", (exitCode, signal) => { if (!shuttingDown) console.error(`Native app exited: ${exitCode ?? signal}`); });
  const page = await waitFor(async () => {
    if (app.exitCode !== null) throw new Error(`Native app exited before WebView2 opened: ${app.exitCode}`);
    try { return (await (await fetch("http://127.0.0.1:9228/json/list", { signal: AbortSignal.timeout(1000) })).json()).find(item => item.title === "GeoD Agent"); }
    catch { return null; }
  }, 25_000, "GeoD Agent WebView2");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open");
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer); pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
  });
  await command("Runtime.enable");
  const initial = await evaluate("window.__TAURI_INTERNALS__.invoke('auth_status')");
  console.error(`Native initial auth state: ${initial.state}`);
  assert.equal(initial.state, "disconnected", "Preserve any existing GeoD credential and abort this test");
  await waitFor(async () => await evaluate("(() => { const button = document.querySelector('.agent-auth-landing button'); return button && !button.disabled; })()"), 10_000, "login button");
  await evaluate("document.querySelector('.agent-auth-landing button').click()");
  await waitFor(async () => (await evaluate("window.__TAURI_INTERNALS__.invoke('auth_status')")).state === "connected", 30_000, "OAuth callback");
  tokenIssued = true;
  console.error("Native OAuth callback completed");
  const sources = await evaluate("window.__TAURI_INTERNALS__.invoke('sources_list')");
  assert.ok(Array.isArray(sources));
  const originalConversationId = await evaluate("JSON.parse(localStorage.getItem('geod-agent-conversations-0.1') || '[]')[0]?.conversationId || null");
  await evaluate("document.querySelector('.conversation-sidebar-head button').click()");
  await waitFor(async () => await evaluate("!!document.querySelector('.agent-composer textarea')"), 10_000, "agent composer");
  smokeConversationId = await waitFor(async () => await evaluate(`(() => { const id = JSON.parse(localStorage.getItem('geod-agent-conversations-0.1') || '[]')[0]?.conversationId; return id && id !== ${JSON.stringify(originalConversationId)} ? id : null; })()`), 10_000, "test conversation");
  await waitFor(async () => await evaluate("!document.querySelector('[aria-label=\"附加 GeoJSON 边界\"]').disabled"), 10_000, "attachment button");
  const inspected = await evaluate(`window.__TAURI_INTERNALS__.invoke('boundary_inspect', { name: 'native-test-boundary.geojson', text: ${JSON.stringify(boundaryText)} })`);
  assert.equal(inspected.polygonCount, 1);
  const document = await command("DOM.getDocument");
  const input = await command("DOM.querySelector", { nodeId: document.root.nodeId, selector: ".agent-boundary-input" });
  assert.ok(input.nodeId, "GeoJSON file input should exist in the native composer");
  await command("DOM.setFileInputFiles", { files: [boundaryPath], nodeId: input.nodeId });
  const attachment = await waitFor(async () => {
    const state = await evaluate("({ attachment: document.querySelector('.agent-attachment')?.innerText || null, error: document.querySelector('.agent-error')?.innerText || null })");
    if (state.error) throw new Error(`Native attachment error: ${state.error}`);
    return state.attachment;
  }, 10_000, "native GeoJSON attachment");
  assert.match(attachment, /native-test-boundary\.geojson/);
  assert.match(attachment, /1 个面/);
  if (process.env.GEOD_NATIVE_CAPTURE_PATH) {
    const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(process.env.GEOD_NATIVE_CAPTURE_PATH, Buffer.from(capture.data, "base64"));
  }
  await evaluate("document.querySelector('[aria-label=\"移除边界附件\"]').click()");
  await waitFor(async () => await evaluate("!document.querySelector('.agent-attachment')"), 10_000, "attachment removal");
  console.error("Native GeoJSON attachment inspected and removed");
  await evaluate(`(() => { const field = document.querySelector('.agent-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(prompt)}); field.dispatchEvent(new Event('input', { bubbles: true })); field.form.requestSubmit(); })()`);
  console.error("Native prompt submitted");
  const reply = await waitFor(async () => await evaluate("(() => { const items = [...document.querySelectorAll('.agent-message')]; const toolIndex = items.findIndex(item => item.classList.contains('tool')); const answer = items.slice(toolIndex + 1).find(item => item.classList.contains('assistant')); return toolIndex >= 0 && answer && !document.querySelector('.agent-thinking') ? answer.innerText : null; })()"), 100_000, "native tool call and DeepSeek reply");
  const usage = await evaluate("window.__TAURI_INTERNALS__.invoke('agent_usage')");
  console.error(`Native model usage: ${usage.committedTokens} committed, ${usage.reservedTokens} reserved`);
  assert.ok(usage.committedTokens > 0);
  assert.equal(usage.reservedTokens, 0);
  console.log(JSON.stringify({ auth: "connected", localSourceCount: sources.length, model: config.model, tool: "sources_list", answer: reply.slice(0, 600), committedTokens: usage.committedTokens, reservedTokens: usage.reservedTokens }, null, 2));
} finally {
  if (socket && tokenIssued) {
    try { await evaluate("window.__TAURI_INTERNALS__.invoke('auth_logout')"); }
    catch (error) { console.error(`Fake OAuth credential cleanup failed: ${error.message}`); }
  }
  if (socket) {
    try { if (smokeConversationId) await evaluate(`(() => { const key = 'geod-agent-conversations-0.1'; const chats = JSON.parse(localStorage.getItem(key) || '[]'); localStorage.setItem(key, JSON.stringify(chats.filter(chat => chat.conversationId !== ${JSON.stringify(smokeConversationId)}))); })()`); }
    catch (error) { console.error(`Smoke conversation cleanup failed: ${error.message}`); }
  }
  socket?.close();
  if (app && app.exitCode === null) { shuttingDown = true; app.kill(); await Promise.race([once(app, "exit"), delay(5000)]); }
  if (gateway) await Promise.race([close(gateway), delay(3000)]);
  if (identityServer) await Promise.race([close(identityServer), delay(3000)]);
  rmSync(folder, { recursive: true, force: true });
}
