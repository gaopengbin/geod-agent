import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, readConfig } from "../server.mjs";

assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for this optional live test");
const secret = "s".repeat(40);
const token = "T".repeat(43);
const folder = mkdtempSync(join(tmpdir(), "geod-stream-live-"));
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
const identity = createServer((_request, response) => {
  if (_request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ active: { userId: "local-stream-smoke", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } }));
});
let gateway;
try {
  const identityOrigin = await listen(identity);
  gateway = createGatewayServer(readConfig({ GEOD_AGENT_GATEWAY_SECRET: secret, GEOD_IDENTITY_ORIGIN: identityOrigin,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: "deepseek-flash",
    GEOD_AGENT_DB_PATH: join(folder, "gateway.sqlite") }));
  const origin = await listen(gateway);
  const response = await fetch(`${origin}/api/agent/generations/stream`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ generationId: "local-live-stream-01", conversationId: "local-live-conv-01",
      messages: [{ role: "user", content: "流式链路验收：请只用一句中文回复流式连接正常，不调用工具。" }] }),
    signal: AbortSignal.timeout(130_000),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const events = raw.split(/\r?\n\r?\n/).map(block => {
    const name = block.match(/^event: ([^\r\n]+)/m)?.[1];
    const data = block.match(/^data: ([^\r\n]+)/m)?.[1];
    return name && data ? { name, data: JSON.parse(data) } : null;
  }).filter(Boolean);
  const deltas = events.filter(event => event.name === "content_delta");
  const generation = events.find(event => event.name === "generation")?.data;
  assert.ok(deltas.length > 0, "DeepSeek sent no text deltas");
  assert.equal(generation?.state, "settled", `Live stream did not settle: ${generation?.state ?? "none"}`);
  assert.equal(deltas.map(event => event.data.text).join(""), generation.result.content);
  console.log(JSON.stringify({ model: generation.model, deltas: deltas.length, characters: generation.result.content.length,
    inputTokens: generation.inputTokens, outputTokens: generation.outputTokens }));
} finally {
  if (gateway) await close(gateway);
  await close(identity);
  rmSync(folder, { recursive: true, force: true });
}
