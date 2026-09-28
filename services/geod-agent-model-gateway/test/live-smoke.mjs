import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, readConfig } from "../server.mjs";

const token = "L".repeat(43);
const secret = "s".repeat(40);
assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for this optional live smoke test");
const folder = mkdtempSync(join(tmpdir(), "geod-deepseek-live-"));
const identityServer = createServer((_request, response) => {
  if (_request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ active: { userId: "live-smoke-user", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } }));
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
let gateway;

try {
  const identityOrigin = await listen(identityServer);
  const config = readConfig({
    GEOD_AGENT_GATEWAY_SECRET: secret,
    GEOD_IDENTITY_ORIGIN: identityOrigin,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: "deepseek-flash",
    GEOD_AGENT_DB_PATH: join(folder, "gateway.sqlite"),
  });
  gateway = createGatewayServer(config);
  const gatewayOrigin = await listen(gateway);
  async function generate(generationId, messages) {
    const response = await fetch(`${gatewayOrigin}/api/agent/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ generationId, conversationId: "live-smoke-conversation", messages }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, state: result.state, error: result.error }));
    assert.equal(result.state, "settled");
    return result;
  }
  const messages = [{ role: "user", content: "请先调用 sources_list 查询本机已授权图源，再根据工具结果回答。不要猜测图源。" }];
  const first = await generate("live-smoke-first", messages);
  const toolCall = first.result?.toolCalls?.find(call => call.function.name === "sources_list");
  assert.ok(toolCall, `Expected sources_list tool call; received ${JSON.stringify(first.result?.toolCalls?.map(call => call.function.name) ?? [])}`);
  messages.push({ role: "assistant", content: first.result.content, tool_calls: first.result.toolCalls });
  for (const call of first.result.toolCalls) {
    messages.push({ role: "tool", tool_call_id: call.id, content: call.function.name === "sources_list"
      ? JSON.stringify({ sources: [{ id: "usgs-naip-test", name: "USGS NAIP Plus", license: "public domain", minZoom: 12, maxZoom: 18 }] })
      : JSON.stringify({ error: "TOOL_NOT_AVAILABLE_IN_SMOKE_TEST" }) });
  }
  const second = await generate("live-smoke-second", messages);
  assert.match(second.result?.content ?? "", /USGS|NAIP/i);
  const usageResponse = await fetch(`${gatewayOrigin}/api/agent/usage`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.ok(usage.committedTokens > 0);
  console.log(JSON.stringify({ model: config.model, first: { state: first.state, tools: first.result.toolCalls.map(call => call.function.name), upstreamRequestId: first.upstreamRequestId }, second: { state: second.state, answer: second.result.content, upstreamRequestId: second.upstreamRequestId }, usage: { committedTokens: usage.committedTokens, reservedTokens: usage.reservedTokens } }, null, 2));
} finally {
  if (gateway) await close(gateway);
  await close(identityServer);
  rmSync(folder, { recursive: true, force: true });
}
