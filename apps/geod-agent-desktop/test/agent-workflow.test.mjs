import assert from "node:assert/strict";
import test from "node:test";
import { boundaryLookupReply, pendingPlanLabel, sourceRegistrationDraft, toolDisplay, userProvidedUrl, workspacePermissionContext } from "../src/agent-workflow.ts";
import { boundedContext } from "../src/conversation-context.ts";

test("fresh native permission overrides stale history, survives compaction and preserves user links", () => {
  const link = "https://example.org/skills/geo/SKILL.md";
  const messages = [{ role: "user", content: "只要生成计划。" }, { role: "assistant", content: "当前是 Confirm Each，请确认计划。" },
    { role: "user", content: `接入 ${link}\n下载北京影像。` }];
  const full = workspacePermissionContext(messages, "fullAccess");
  assert.match(full.at(-1).content, /"permission":"fullAccess"/);
  assert.match(full.at(-1).content, /继续调用 jobs_start/);
  assert.match(full.at(-1).content, /仅要求规划、预览或估算时不启动任务/);
  assert.equal(userProvidedUrl(full.at(-1).content, link), true);
  assert.equal(messages.at(-1).content, `接入 ${link}\n下载北京影像。`);
  const confirm = workspacePermissionContext(full, "confirmEach");
  assert.equal(confirm.at(-1).content.includes('"permission":"fullAccess"'), false);
  assert.equal(confirm.at(-1).content.split("【本轮本机权限状态】").length, 2);
  const long = [...Array.from({ length: 100 }, () => ({ role: "assistant", content: "旧的逐次确认信息".repeat(100) })), ...full];
  assert.match(boundedContext(long).at(-1).content, /"permission":"fullAccess"/);
  assert.equal(pendingPlanLabel("fullAccess"), "待执行");
  assert.equal(pendingPlanLabel("confirmEach"), "待确认");
  assert.equal(pendingPlanLabel(null), "计划已生成");
});

test("detailed administrative geometry stays local and version survives the model reply", () => {
  const boundary = { name: "北京市-AreaCity-20260403.geojson", bounds: [115.4,39.4,117.5,41.1], polygonCount: 1,
    geometry: { polygons: [[Array.from({ length: 15_482 }, () => [116.4,39.9])]] } };
  const raw = { found: true, name: "北京市", version: "2025.251231.260403", collectedAt: "2026-04-03", boundary };
  const reply = boundaryLookupReply(raw);
  assert.equal(reply.attachment, boundary);
  assert.equal(reply.result.attachedToDesktopPlan, true);
  assert.equal(reply.result.version, raw.version);
  assert.ok(JSON.stringify(reply.result).length < 300);
  assert.equal(reply.result.boundary, undefined);
  assert.ok(raw.boundary);
  const unresolved = boundaryLookupReply({ found: false, candidates: [{ name: "朝阳区", path: "北京市" }, { name: "朝阳区", path: "吉林省 长春市" }] });
  assert.equal(unresolved.attachment, null);
  assert.equal(unresolved.result.candidates.length, 2);
  const step = toolDisplay("mcp_call", { kind: "builtin", toolName: "lookup_boundary", result: reply.result });
  assert.match(step.content, /北京市.*2026-04-03/);
});

const source = {
  id: "licensed-source", name: "授权影像", urlTemplate: "https://imagery.example.org/{z}/{x}/{y}.png",
  attribution: "提供方", license: "用户提供的批量下载许可", scheme: "XYZ", tileSize: 256,
  minZoom: 5, maxZoom: 18, minIntervalMs: 500,
};

test("source configuration accepts optional metadata and reports actual persistence", () => {
  const { attribution, license, ...technical } = source;
  const parsed = sourceRegistrationDraft(technical);
  assert.equal(parsed.source.attribution, "");
  assert.equal(parsed.source.license, "");
  const step = toolDisplay("source_configure", { saved: true, name: source.name });
  assert.equal(step.toolStatus, "success");
  assert.equal(step.sourceDraft, undefined);
  assert.match(step.content, /已保存/);
});

test("source proposal stays a user reviewed draft and excludes credentialed endpoints", () => {
  const draft = sourceRegistrationDraft(source);
  assert.equal(draft?.source.networkPolicy, "PublicHttps");
  assert.equal(draft?.maxZoom, 18);
  assert.equal(sourceRegistrationDraft({ ...source, urlTemplate: "https://imagery.example.org/{z}/{x}/{y}.png?key=secret" }), null);
  assert.equal(sourceRegistrationDraft({ ...source, urlTemplate: "http://imagery.example.org/{z}/{x}/{y}.png" }), null);
  assert.equal(sourceRegistrationDraft({ ...source, minZoom: 19 }), null);
  const step = toolDisplay("source_registration_prepare", { draft });
  assert.equal(step.toolStatus, "attention");
  assert.equal(step.sourceDraft, draft);
});

test("tool failures remain visible in the work transcript", () => {
  assert.deepEqual(toolDisplay("plan_imagery", { error: "RESOURCE_LIMIT" }), {
    toolName: "plan_imagery", toolStatus: "attention", content: "计算影像计划 · RESOURCE_LIMIT",
  });
  assert.deepEqual(toolDisplay("mcp_call", { error: "MCP_RESULT_UNKNOWN" }), {
    toolName: "mcp_call", toolStatus: "attention", content: "调用 MCP 工具 · 结果待核对，已停止自动重试",
  });
  assert.deepEqual(toolDisplay("jobs_start", { error: "SKIPPED_AFTER_MCP_UNKNOWN" }), {
    toolName: "jobs_start", toolStatus: "attention", content: "启动本机下载 · 等待核对，未执行",
  });
});

test("AI extension onboarding produces an in-conversation review step", () => {
  const extensionProposal = { kind: "mcp", id: "connector-1", name: "Example MCP", description: "A test service", detail: "https://example.org/mcp", toolNames: ["lookup"] };
  const step = toolDisplay("mcp_connect", { requiresUserReview: true, extensionProposal });
  assert.equal(step.toolStatus, "attention");
  assert.deepEqual(step.extensionProposal, extensionProposal);
  assert.equal(toolDisplay("mcp_registry_search", { candidates: [{ name: "example" }] }).content, "查找 MCP 连接器 · 1 个候选");
});

test("remote extension links must exactly appear in the latest user message", () => {
  assert.equal(userProvidedUrl("请接入 https://example.org/skills/geo/SKILL.md。", "https://example.org/skills/geo/SKILL.md"), true);
  assert.equal(userProvidedUrl("[Skill](https://example.org/skills/geo/SKILL.md)", "https://example.org/skills/geo/SKILL.md"), true);
  assert.equal(userProvidedUrl("https://example.org/skills/geo/SKILL.md?version=2", "https://example.org/skills/geo/SKILL.md"), false);
  assert.equal(userProvidedUrl("请查找 GeoJSON Skill", "https://example.org/skills/geo/SKILL.md"), false);
});
