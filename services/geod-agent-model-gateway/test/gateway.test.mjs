import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createGatewayServer, readConfig } from "../server.mjs";

const TOKEN = "A".repeat(43);
const SECRET = "a".repeat(40);
const folder = mkdtempSync(join(tmpdir(), "geod-agent-gateway-"));
let identityServer; let upstreamServer; let gateway; let base; let calls = 0; let failUpstream = false;

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
before(async () => {
  identityServer = createServer(async (request, response) => {
    assert.equal(request.url, "/api/geod/oauth/introspect");
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    let body = ""; for await (const part of request) body += part;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ active: JSON.parse(body).token === TOKEN ? { userId: "user-1", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } : null }));
  });
  upstreamServer = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer project-key");
    let body = ""; for await (const part of request) body += part;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "fake-geod-model");
    assert.equal(payload.tools.some(tool => tool.function.name === "jobs_start"), false);
    calls++;
    if (failUpstream) { response.writeHead(503); response.end("service unavailable"); return; }
    const isContinuation = payload.messages.at(-1).role === "tool";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `upstream-${calls}`, usage: { prompt_tokens: 300, completion_tokens: 40 }, choices: [{ message: isContinuation
      ? { role: "assistant", content: "本机已有两个授权图源；请先检查下载计划。" }
      : { role: "assistant", content: null, tool_calls: [{ id: "call_12345678", type: "function", function: { name: "sources_list", arguments: "{}" } }] } }] }));
  });
  const identityOrigin = await listen(identityServer);
  const upstreamOrigin = await listen(upstreamServer);
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, LAOGAO_API_KEY: "project-key", LAOGAO_MODEL: "fake-geod-model", GEOD_IDENTITY_ORIGIN: identityOrigin, LAOGAO_BASE_URL: `${upstreamOrigin}/v1`, GEOD_AGENT_DB_PATH: join(folder, "gateway.sqlite"), GEOD_AGENT_TOKEN_LIMIT: "40000" });
  gateway = createGatewayServer(config);
  base = await listen(gateway);
});
after(async () => { await Promise.all([close(gateway), close(identityServer), close(upstreamServer)]); rmSync(folder, { recursive: true, force: true }); });

async function call(path, body, token = TOKEN, method = "POST") {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

test("authorization, read-only tool call, local result continuation, idempotency and quota", async () => {
  assert.equal((await call("/api/agent/usage", undefined, "bad", "GET")).status, 401);
  const firstBody = { generationId: "generation-01", conversationId: "conversation-01", messages: [{ role: "user", content: "有哪些图源？" }] };
  const first = await call("/api/agent/generations", firstBody);
  assert.equal(first.status, 200);
  assert.equal(first.data.state, "settled");
  assert.equal(first.data.result.toolCalls[0].function.name, "sources_list");
  assert.equal((await call("/api/agent/generations", firstBody)).data.result.toolCalls[0].id, "call_12345678");
  assert.equal(calls, 1);
  assert.equal((await call("/api/agent/generations", { ...firstBody, messages: [{ role: "user", content: "changed" }] })).status, 409);
  const second = await call("/api/agent/generations", { generationId: "generation-02", conversationId: "conversation-01", messages: [
    firstBody.messages[0], { role: "assistant", content: null, tool_calls: first.data.result.toolCalls },
    { role: "tool", tool_call_id: "call_12345678", content: JSON.stringify({ sources: [{ id: "s1" }, { id: "s2" }] }) },
  ] });
  assert.equal(second.status, 200);
  assert.match(second.data.result.content, /两个授权图源/);
  assert.equal(calls, 2);
  const usage = await call("/api/agent/usage", undefined, TOKEN, "GET");
  assert.equal(usage.data.committedTokens, 680);
  assert.equal(usage.data.reservedTokens, 0);
  assert.equal(usage.data.remainingTokens, 39320);
  const fetched = await call("/api/agent/generations/generation-01", undefined, TOKEN, "GET");
  assert.deepEqual(fetched.data.result.toolCalls, first.data.result.toolCalls);
});

test("ambiguous upstream failure remains reserved for reconciliation", async () => {
  failUpstream = true;
  const body = { generationId: "generation-03", conversationId: "conversation-02", messages: [{ role: "user", content: "检查状态" }] };
  assert.equal((await call("/api/agent/generations", body)).status, 202);
  assert.equal((await call("/api/agent/generations/generation-03", undefined, TOKEN, "GET")).data.state, "pending_reconcile");
  assert.equal((await call("/api/agent/generations", { generationId: "generation-04", conversationId: "conversation-02", messages: [{ role: "user", content: "重试" }] })).status, 429);
  assert.equal((await call("/api/agent/usage", undefined, TOKEN, "GET")).data.pendingReconcile, 1);
  failUpstream = false;
});

test("public HTTP upstream and identity are rejected except loopback", () => {
  assert.throws(() => readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, LAOGAO_API_KEY: "key", LAOGAO_MODEL: "model", GEOD_IDENTITY_ORIGIN: "http://example.com", LAOGAO_BASE_URL: "http://127.0.0.1:19094/v1" }), /HTTPS/);
});
