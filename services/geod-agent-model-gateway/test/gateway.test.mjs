import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createGatewayServer, readConfig } from "../server.mjs";
import { openLedger } from "../ledger.mjs";

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
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, "Bearer project-key");
    let body = ""; for await (const part of request) body += part;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "deepseek-flash");
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.equal(payload.tools.some(tool => tool.function.name === "jobs_start"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "source_registration_prepare"), true);
    const configure = payload.tools.find(tool => tool.function.name === "source_configure").function;
    assert.equal(configure.parameters.required.includes("license"), false);
    assert.equal(configure.parameters.required.includes("attribution"), false);
    assert.match(payload.messages[0].content, /do not investigate licensing agreements/);
    assert.equal(payload.tools.some(tool => tool.function.name === "workspace_boundary_use"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "workspace_gis_files_list"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "extensions_list"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "skill_read"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "mcp_call"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "mcp_result_read"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "mcp_registry_search"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "mcp_connect"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "gdal_connect"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "workspace_skills_list"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "workspace_skill_import"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "skill_catalog_search"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "skill_source_inspect"), true);
    assert.equal(payload.tools.some(tool => tool.function.name === "skill_connect"), true);
    calls++;
    if (failUpstream) { response.writeHead(503); response.end("service unavailable"); return; }
    if (payload.messages.find(message => message.role === "user")?.content === "配置图源验收") {
      const saved = payload.messages.at(-1).role === "tool";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `source-${calls}`, usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: saved
        ? { role: "assistant", content: "已保存图源。" }
        : { role: "assistant", content: "正在保存配置。", tool_calls: [{ id: "call_configure_01", type: "function", function: { name: "source_configure", arguments: JSON.stringify({ id: "map-source", name: "Imagery", urlTemplate: "https://example.org/MapServer/tile/{z}/{y}/{x}", scheme: "XYZ", tileSize: 256, minZoom: 0, maxZoom: 18, minIntervalMs: 500 }) } }] } }] }));
      return;
    }
    if (payload.messages.find(message => message.role === "user")?.content === "流式验收") {
      assert.equal(payload.stream, true);
      assert.deepEqual(payload.stream_options, { include_usage: true });
      const continuation = payload.messages.at(-1).role === "tool";
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, usage = null) => response.write(`data: ${JSON.stringify({ id: `stream-${calls}`, choices: delta ? [{ delta }] : [], usage })}\n\n`);
      if (continuation) {
        chunk({ content: "已读取" });
        await new Promise(resolve => setTimeout(resolve, 15));
        chunk({ content: "授权图源。" });
      } else {
        chunk({ content: "先检查" });
        await new Promise(resolve => setTimeout(resolve, 15));
        chunk({ content: "图源。", tool_calls: [{ index: 0, id: "call_stream_1234", type: "function", function: { name: "sources_list", arguments: "{" } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] });
      }
      chunk(null, { prompt_tokens: 300, completion_tokens: 40 });
      response.end("data: [DONE]\n\n");
      return;
    }
    if (payload.messages.find(message => message.role === "user")?.content === "使用扩展工具完成本地验收") {
      const previousTool = payload.messages.filter(message => message.role === "assistant" && message.tool_calls?.length).at(-1)?.tool_calls[0].function.name;
      const next = previousTool === undefined
        ? { name: "extensions_list", arguments: "{}" }
        : previousTool === "extensions_list"
          ? { name: "skill_read", arguments: JSON.stringify({ name: "test-skill" }) }
          : previousTool === "skill_read"
            ? { name: "mcp_call", arguments: JSON.stringify({ connectorId: "test-connector", toolName: "echo", arguments: { text: "GeoD MCP OK" } }) }
            : null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `upstream-${calls}`, usage: { prompt_tokens: 300, completion_tokens: 40 }, choices: [{ message: next
        ? { role: "assistant", content: `继续执行 ${next.name}`, tool_calls: [{ id: `call_ext_${calls}`, type: "function", function: next }] }
        : { role: "assistant", content: "已读取 Skill，并通过 MCP 工具收到 GeoD MCP OK。" } }] }));
      return;
    }
    const isContinuation = payload.messages.at(-1).role === "tool";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `upstream-${calls}`, usage: { prompt_tokens: 300, completion_tokens: 40 }, choices: [{ message: isContinuation
      ? { role: "assistant", content: "本机已有两个授权图源；请先检查下载计划。" }
      : { role: "assistant", content: null, tool_calls: [{ id: "call_12345678", type: "function", function: { name: "sources_list", arguments: "{}" } }] } }] }));
  });
  const identityOrigin = await listen(identityServer);
  const upstreamOrigin = await listen(upstreamServer);
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "project-key", GEOD_IDENTITY_ORIGIN: identityOrigin, DEEPSEEK_BASE_URL: upstreamOrigin, GEOD_AGENT_DB_PATH: join(folder, "gateway.sqlite"), GEOD_AGENT_TOKEN_LIMIT: "40000", GEOD_AGENT_WELCOME_CREDITS: "0" });
  gateway = createGatewayServer(config);
  base = await listen(gateway);
});
after(async () => { await Promise.all([close(gateway), close(identityServer), close(upstreamServer)]); rmSync(folder, { recursive: true, force: true }); });

async function call(path, body, token = TOKEN, method = "POST") {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

test("authorization, tool call, local result continuation, idempotency and quota", async () => {
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

test("local extension discovery, Skill read and MCP call continue across model rounds", async () => {
  const conversationId = "conversation-extensions";
  const messages = [{ role: "user", content: "使用扩展工具完成本地验收" }];
  const expected = ["extensions_list", "skill_read", "mcp_call"];
  for (const [round, name] of expected.entries()) {
    const result = await call("/api/agent/generations", { generationId: `generation-ext-${round}`, conversationId, messages });
    assert.equal(result.status, 200);
    assert.equal(result.data.result.toolCalls[0].function.name, name);
    messages.push({ role: "assistant", content: result.data.result.content, tool_calls: result.data.result.toolCalls });
    messages.push({ role: "tool", tool_call_id: result.data.result.toolCalls[0].id, content: JSON.stringify(round === 0
      ? { skills: [{ name: "test-skill", description: "Local verification" }], connectors: [{ connectorId: "test-connector", tools: [{ name: "echo" }] }] }
      : round === 1 ? { name: "test-skill", content: "Use echo." } : { connectorId: "test-connector", toolName: "echo", result: "GeoD MCP OK" }) });
  }
  const final = await call("/api/agent/generations", { generationId: "generation-ext-final", conversationId, messages });
  assert.equal(final.status, 200);
  assert.deepEqual(final.data.result.toolCalls, []);
  assert.match(final.data.result.content, /GeoD MCP OK/);
});

test("source configuration tool works without licensing fields or a review round", async () => {
  const messages = [{ role: "user", content: "配置图源验收" }];
  const first = await call("/api/agent/generations", { generationId: "configure-generation-01", conversationId: "configure-conversation", messages });
  assert.equal(first.status, 200);
  const tool = first.data.result.toolCalls[0];
  assert.equal(tool.function.name, "source_configure");
  assert.equal(JSON.parse(tool.function.arguments).license, undefined);
  messages.push({ role: "assistant", content: first.data.result.content, tool_calls: [tool] });
  messages.push({ role: "tool", tool_call_id: tool.id, content: JSON.stringify({ saved: true, configured: true, id: "map-source" }) });
  const final = await call("/api/agent/generations", { generationId: "configure-generation-02", conversationId: "configure-conversation", messages });
  assert.equal(final.status, 200);
  assert.match(final.data.result.content, /已保存/);
});

test("SSE streams text and tool activity, settles usage, and continues after a tool result", async () => {
  const messages = [{ role: "user", content: "流式验收" }];
  const first = await fetch(`${base}/api/agent/generations/stream`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ generationId: "stream-generation-01", conversationId: "stream-conversation-01", messages }) });
  assert.equal(first.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const body = await first.text();
  assert.ok(body.indexOf("event: started") < body.indexOf("event: content_delta"));
  assert.ok(body.indexOf("event: content_delta") < body.indexOf("event: tool_start"));
  assert.ok(body.indexOf("event: tool_start") < body.indexOf("event: generation"));
  const generation = JSON.parse(body.match(/event: generation\ndata: ([^\n]+)/)[1]);
  assert.equal(generation.state, "settled");
  assert.equal(generation.result.content, "先检查图源。");
  assert.equal(generation.result.toolCalls[0].function.name, "sources_list");
  const replay = await fetch(`${base}/api/agent/generations/stream`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ generationId: "stream-generation-01", conversationId: "stream-conversation-01", messages }) });
  assert.equal(JSON.parse((await replay.text()).match(/event: generation\ndata: ([^\n]+)/)[1]).result.content, generation.result.content);
  messages.push({ role: "assistant", content: generation.result.content, tool_calls: generation.result.toolCalls });
  messages.push({ role: "tool", tool_call_id: generation.result.toolCalls[0].id, content: "{\"sources\":[]}" });
  const second = await fetch(`${base}/api/agent/generations/stream`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ generationId: "stream-generation-02", conversationId: "stream-conversation-01", messages }) });
  const secondBody = await second.text();
  assert.match(secondBody, /已读取/);
  assert.match(secondBody, /授权图源/);
  assert.equal(JSON.parse(secondBody.match(/event: generation\ndata: ([^\n]+)/)[1]).result.content, "已读取授权图源。");
});

test("a closed desktop stream still settles the generation for recovery", async () => {
  const body = { generationId: "stream-disconnected-01", conversationId: "stream-disconnected-conv", messages: [{ role: "user", content: "流式验收" }] };
  const response = await fetch(`${base}/api/agent/generations/stream`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 80));
  const recovered = await call(`/api/agent/generations/${body.generationId}`, undefined, TOKEN, "GET");
  assert.equal(recovered.data.state, "settled");
  assert.equal(recovered.data.result.content, "先检查图源。");
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
  assert.throws(() => readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "key", GEOD_IDENTITY_ORIGIN: "http://example.com" }), /HTTPS/);
  assert.throws(() => readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "key", GEOD_IDENTITY_ORIGIN: "http://127.0.0.1:8787", DEEPSEEK_BASE_URL: "https://example.com" }), /official API/);
  assert.throws(() => readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "key", GEOD_IDENTITY_ORIGIN: "http://127.0.0.1:8787", DEEPSEEK_BASE_URL: "https://api.deepseek.com:8443" }), /official API/);
  assert.throws(() => readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "key", GEOD_IDENTITY_ORIGIN: "http://127.0.0.1:8787", DEEPSEEK_MODEL: "deepseek-chat" }), /DEEPSEEK_MODEL/);
});

test("identity and upstream redirects cannot forward credentials", async () => {
  let forwarded = 0;
  const destination = createServer((_request, response) => { forwarded++; response.end("unexpected"); });
  const destinationOrigin = await listen(destination);
  const redirectIdentity = createServer((_request, response) => {
    response.writeHead(307, { location: `${destinationOrigin}/identity` }); response.end();
  });
  const identityOrigin = await listen(redirectIdentity);
  const redirectUpstream = createServer((_request, response) => {
    response.writeHead(307, { location: `${destinationOrigin}/upstream` }); response.end();
  });
  const upstreamOrigin = await listen(redirectUpstream);
  const identityConfig = readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "project-key", GEOD_IDENTITY_ORIGIN: identityOrigin, DEEPSEEK_BASE_URL: upstreamOrigin, GEOD_AGENT_DB_PATH: join(folder, "identity-redirect.sqlite") });
  const upstreamConfig = readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "project-key", GEOD_IDENTITY_ORIGIN: `http://127.0.0.1:${identityServer.address().port}`, DEEPSEEK_BASE_URL: upstreamOrigin, GEOD_AGENT_DB_PATH: join(folder, "upstream-redirect.sqlite") });
  const identityGateway = createGatewayServer(identityConfig);
  const upstreamGateway = createGatewayServer(upstreamConfig);
  const identityBase = await listen(identityGateway);
  const upstreamBase = await listen(upstreamGateway);
  try {
    const headers = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${identityBase}/api/agent/usage`, { headers })).status, 503);
    const response = await fetch(`${upstreamBase}/api/agent/generations`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ generationId: "redirect-01", conversationId: "redirect-02", messages: [{ role: "user", content: "sources?" }] }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).state, "pending_reconcile");
    assert.equal(forwarded, 0);
  } finally {
    await Promise.all([close(identityGateway), close(upstreamGateway), close(redirectIdentity), close(redirectUpstream), close(destination)]);
  }
});

test("token limits reject invalid quota configuration", () => {
  const config = { GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "key", GEOD_IDENTITY_ORIGIN: "http://127.0.0.1:8787" };
  for (const limit of ["-1", "NaN", "19999", "100000001"]) {
    assert.throws(() => readConfig({ ...config, GEOD_AGENT_TOKEN_LIMIT: limit }), /token limit/);
  }
  assert.throws(() => readConfig({ ...config, GEOD_AGENT_QUOTA_MODE: "invalid" }), /quota mode/);
});

test("testing gateway accepts a request after the nominal budget is already exhausted", async () => {
  const dbPath = join(folder, "unlimited.sqlite");
  const seed = openLedger(dbPath, 20_000, SECRET, false);
  seed.reserve({userId:"user-1",generationId:"seed-over-limit",conversationId:"seed-conversation",requestHash:"seed",model:"deepseek-flash",reserveTokens:20_000});
  seed.markStreaming("user-1", "seed-over-limit");
  seed.settle("user-1", "seed-over-limit", 21_000, 0, "seed-upstream", {content:"test",toolCalls:[]});
  seed.close();
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: SECRET, DEEPSEEK_API_KEY: "project-key", GEOD_IDENTITY_ORIGIN: `http://127.0.0.1:${identityServer.address().port}`, DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamServer.address().port}`, GEOD_AGENT_DB_PATH: dbPath, GEOD_AGENT_TOKEN_LIMIT: "20000", GEOD_AGENT_QUOTA_MODE: "unlimited" });
  const server = createGatewayServer(config);
  const origin = await listen(server);
  try {
    const headers={authorization:`Bearer ${TOKEN}`,"content-type":"application/json"};
    const usage=await (await fetch(`${origin}/api/agent/usage`,{headers})).json();
    assert.equal(usage.quotaEnforced,false);
    assert.equal(usage.remainingTokens,null);
    assert.equal(usage.committedTokens,21000);
    const response=await fetch(`${origin}/api/agent/generations`,{method:"POST",headers,body:JSON.stringify({generationId:"unlimited-after-cap-01",conversationId:"unlimited-conversation",messages:[{role:"user",content:"sources?"}]})});
    assert.equal(response.status,200);
    assert.equal((await response.json()).state,"settled");
    const after=await (await fetch(`${origin}/api/agent/usage`,{headers})).json();
    assert.equal(after.committedTokens,21340);
    assert.equal(after.reservedTokens,0);
    assert.equal(after.limitTokens,null);
  } finally { await close(server); }
});
