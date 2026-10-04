import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, readConfig } from "../server.mjs";

assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for the optional local live test");
const token = "E".repeat(43);
const secret = "e".repeat(40);
const folder = mkdtempSync(join(tmpdir(), "geod-extensions-live-"));
const identityServer = createServer((_request, response) => {
  if (_request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ active: { userId: "local-extensions-smoke", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } }));
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
let gateway;

async function echo(text) {
  const response = await fetch("http://127.0.0.1:43121/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text } } }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "Start apps/geod-agent-desktop/test/mcp-mock.mjs first");
  const value = await response.json();
  assert.match(value.result?.content?.[0]?.text ?? "", /GeoD MCP OK/);
  return value.result;
}

try {
  const identityOrigin = await listen(identityServer);
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: secret, GEOD_IDENTITY_ORIGIN: identityOrigin,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: "deepseek-flash",
    GEOD_AGENT_DB_PATH: join(folder, "gateway.sqlite") });
  gateway = createGatewayServer(config);
  const gatewayOrigin = await listen(gateway);
  const conversationId = "local-extensions-conversation";
  const messages = [{ role: "user", content: "请在本地验收扩展：先调用 extensions_list，读取 geod-local-smoke Skill，再用 mcp_call 调用本地测试连接器的 echo 工具，arguments 为 {\"text\":\"GeoD MCP OK\"}。最后只根据工具实际返回的内容报告结果。" }];
  const used = [];
  let final = "";
  for (let round = 0; round < 8; round++) {
    const response = await fetch(`${gatewayOrigin}/api/agent/generations`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ generationId: `extensions-live-${round}`, conversationId, messages }),
      signal: AbortSignal.timeout(90_000),
    });
    const generation = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: generation.error, state: generation.state }));
    assert.equal(generation.state, "settled");
    const result = generation.result;
    if (!result.toolCalls.length) { final = result.content ?? ""; break; }
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments);
      used.push(name);
      const output = name === "extensions_list"
        ? { skills: [{ name: "geod-local-smoke", description: "本地扩展验收 Skill" }], connectors: [{ connectorId: "local-smoke", name: "本地测试", tools: [{ name: "echo", description: "回显文本", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }] }
        : name === "skill_read" && args.name === "geod-local-smoke"
          ? { name: args.name, content: "# 本地验收 Skill\n用 echo 工具回显 GeoD MCP OK。" }
          : name === "mcp_call" && args.connectorId === "local-smoke" && args.toolName === "echo"
            ? { connectorId: args.connectorId, toolName: args.toolName, result: await echo(args.arguments?.text) }
            : { error: "TOOL_NOT_AVAILABLE_IN_LOCAL_SMOKE" };
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  assert.ok(used.includes("extensions_list"), `Missing extensions_list: ${used.join(", ")}`);
  assert.ok(used.includes("skill_read"), `Missing skill_read: ${used.join(", ")}`);
  assert.ok(used.includes("mcp_call"), `Missing mcp_call: ${used.join(", ")}`);
  assert.match(final, /GeoD MCP OK/);
  const onboarding = [{ role: "user", content: "请调用 workspace_skills_list 查找当前工作区的 Skill；如果发现 geojson-helper，就调用 workspace_skill_import，relativePath 必须照工具返回值填写。先不要声称已启用，告诉我需要在对话里确认。" }];
  const onboardingTools = [];
  for (let round = 0; round < 6; round++) {
    const response = await fetch(`${gatewayOrigin}/api/agent/generations`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ generationId: `extensions-onboard-${round}`, conversationId: "local-extensions-onboard", messages: onboarding }),
      signal: AbortSignal.timeout(90_000),
    });
    const generation = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: generation.error, state: generation.state }));
    assert.equal(generation.state, "settled");
    const result = generation.result;
    if (!result.toolCalls.length) break;
    onboarding.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments);
      onboardingTools.push(name);
      const output = name === "workspace_skills_list"
        ? { skills: [{ name: "geojson-helper", description: "处理 GeoJSON 边界", relativePath: ".agents/skills/geojson-helper" }] }
        : name === "workspace_skill_import" && args.relativePath === ".agents/skills/geojson-helper"
          ? { imported: true, enabled: false, requiresUserReview: true, extensionProposal: { kind: "skill", id: "local-skill", name: "geojson-helper", detail: args.relativePath } }
          : name === "extensions_list" ? { skills: [], connectors: [] } : { error: "TOOL_NOT_AVAILABLE_IN_LOCAL_SMOKE" };
      onboarding.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (onboardingTools.includes("workspace_skill_import")) break;
  }
  assert.ok(onboardingTools.includes("workspace_skills_list"), `Missing workspace_skills_list: ${onboardingTools.join(", ")}`);
  assert.ok(onboardingTools.includes("workspace_skill_import"), `Missing workspace_skill_import: ${onboardingTools.join(", ")}`);
  const connectorMessages = [{ role: "user", content: "请调用 mcp_registry_search 查找 echo 能力。如果返回 example/echo，请调用 mcp_connect 测试该候选，然后告诉我需要在对话里确认启用，不要声称已启用。" }];
  const connectorTools = [];
  for (let round = 0; round < 6; round++) {
    const response = await fetch(`${gatewayOrigin}/api/agent/generations`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ generationId: `extensions-connect-${round}`, conversationId: "local-extensions-connect", messages: connectorMessages }),
      signal: AbortSignal.timeout(90_000),
    });
    const generation = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: generation.error, state: generation.state }));
    assert.equal(generation.state, "settled");
    const result = generation.result;
    if (!result.toolCalls.length) break;
    connectorMessages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments);
      connectorTools.push(name);
      const output = name === "mcp_registry_search"
        ? { candidates: [{ name: "example/echo", title: "Echo", description: "Echoes text" }] }
        : name === "mcp_connect" && args.registryName === "example/echo"
          ? { connected: true, enabled: false, requiresUserReview: true, extensionProposal: { kind: "mcp", id: "local-echo", name: "Echo", detail: "https://example.org/mcp", toolNames: ["echo"] } }
          : name === "extensions_list" ? { skills: [], connectors: [] } : { error: "TOOL_NOT_AVAILABLE_IN_LOCAL_SMOKE" };
      connectorMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (connectorTools.includes("mcp_connect")) break;
  }
  assert.ok(connectorTools.includes("mcp_registry_search"), `Missing mcp_registry_search: ${connectorTools.join(", ")}`);
  assert.ok(connectorTools.includes("mcp_connect"), `Missing mcp_connect: ${connectorTools.join(", ")}`);
  const networkSkillMessages = [{ role: "user", content: "请从网络查找 React 最佳实践 Skill。先调用 skill_catalog_search；如果找到 vercel-labs/agent-skills/vercel-react-best-practices，调用 skill_connect 获取并校验它。最后说明仍需在对话里确认启用。" }];
  const networkSkillTools = [];
  for (let round = 0; round < 6; round++) {
    const response = await fetch(`${gatewayOrigin}/api/agent/generations`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ generationId: `extensions-network-skill-${round}`, conversationId: "local-extensions-network-skill", messages: networkSkillMessages }),
      signal: AbortSignal.timeout(90_000),
    });
    const generation = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: generation.error, state: generation.state }));
    assert.equal(generation.state, "settled");
    const result = generation.result;
    if (!result.toolCalls.length) break;
    networkSkillMessages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments);
      networkSkillTools.push(name);
      const output = name === "skill_catalog_search"
        ? { candidates: [{ id: "vercel-labs/agent-skills/vercel-react-best-practices", name: "vercel-react-best-practices", source: "vercel-labs/agent-skills", installs: 100 }] }
        : name === "skill_connect" && args.candidateId === "vercel-labs/agent-skills/vercel-react-best-practices"
          ? { installed: true, enabled: false, requiresUserReview: true, extensionProposal: { kind: "skill", id: "network-skill", name: "vercel-react-best-practices", detail: "https://raw.githubusercontent.com/vercel-labs/agent-skills/HEAD/skills/react-best-practices/SKILL.md" } }
          : name === "extensions_list" ? { skills: [], connectors: [] } : { error: "TOOL_NOT_AVAILABLE_IN_LOCAL_SMOKE" };
      networkSkillMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (networkSkillTools.includes("skill_connect")) break;
  }
  assert.ok(networkSkillTools.includes("skill_catalog_search"), `Missing skill_catalog_search: ${networkSkillTools.join(", ")}`);
  assert.ok(networkSkillTools.includes("skill_connect"), `Missing skill_connect: ${networkSkillTools.join(", ")}`);
  const link = "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices";
  const linkedSkillMessages = [{ role: "user", content: `请从这个链接获取 Skill 并准备接入：${link}。先检查链接指向的 Skill，再获取文件，启用前让我在对话里核对。` }];
  const linkedSkillTools = [];
  for (let round = 0; round < 6; round++) {
    const response = await fetch(`${gatewayOrigin}/api/agent/generations`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ generationId: `extensions-linked-skill-${round}`, conversationId: "local-extensions-linked-skill", messages: linkedSkillMessages }),
      signal: AbortSignal.timeout(90_000),
    });
    const generation = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: generation.error, state: generation.state }));
    assert.equal(generation.state, "settled");
    const result = generation.result;
    if (!result.toolCalls.length) break;
    linkedSkillMessages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments);
      linkedSkillTools.push(name);
      const output = name === "skill_source_inspect" && args.url === link
        ? { candidates: [{ id: "vercel-labs/agent-skills/vercel-react-best-practices", name: "vercel-react-best-practices", source: "vercel-labs/agent-skills" }] }
        : name === "skill_connect" && (args.candidateId === "vercel-labs/agent-skills/vercel-react-best-practices" || args.url === link)
          ? { installed: true, enabled: false, requiresUserReview: true, extensionProposal: { kind: "skill", id: "linked-skill", name: "vercel-react-best-practices", detail: "https://raw.githubusercontent.com/vercel-labs/agent-skills/HEAD/skills/react-best-practices/SKILL.md" } }
          : name === "extensions_list" ? { skills: [], connectors: [] } : { error: "TOOL_NOT_AVAILABLE_IN_LOCAL_SMOKE" };
      linkedSkillMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (linkedSkillTools.includes("skill_connect")) break;
  }
  assert.ok(linkedSkillTools.includes("skill_connect"), `Missing skill_connect for supplied URL: ${linkedSkillTools.join(", ")}`);
  const usageResponse = await fetch(`${gatewayOrigin}/api/agent/usage`, { headers: { authorization: `Bearer ${token}` } });
  const usage = await usageResponse.json();
  assert.equal(usageResponse.status, 200);
  assert.ok(usage.committedTokens > 0);
  assert.equal(usage.reservedTokens, 0);
  console.log(JSON.stringify({ model: config.model, rounds: messages.filter(message => message.role === "assistant").length + 1,
    tools: used, onboardingTools, connectorTools, networkSkillTools, linkedSkillTools, final: final.slice(0, 300), committedTokens: usage.committedTokens, reservedTokens: usage.reservedTokens }, null, 2));
} finally {
  if (gateway) await close(gateway);
  await close(identityServer);
  rmSync(folder, { recursive: true, force: true });
}
