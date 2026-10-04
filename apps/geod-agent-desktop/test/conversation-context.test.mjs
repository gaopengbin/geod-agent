import assert from "node:assert/strict";
import test from "node:test";
import { boundedContext, contextWindowUsage, MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES } from "../src/conversation-context.ts";

test("context meter matches the payload sent by the desktop, including a draft", () => {
  const messages = [{ role: "user", content: "检查图源" }, { role: "assistant", content: "已找到影像" }];
  const preview = contextWindowUsage(messages, " 继续 ");
  const sent = boundedContext([...messages, { role: "user", content: "继续" }]);
  assert.equal(preview.sentChars, JSON.stringify(sent).length);
  assert.equal(preview.messageCount, sent.length);
  assert.equal(Object.values(preview.roles).reduce((sum, count) => sum + count, 0), preview.sentChars);
  assert.equal(preview.compressed, false);
});

test("empty conversations show the two JSON delimiters without inventing a user message", () => {
  const preview = contextWindowUsage([]);
  assert.equal(preview.sentChars, 2);
  assert.equal(preview.messageCount, 0);
  assert.equal(Object.values(preview.roles).reduce((sum, count) => sum + count, 0), 2);
});

test("context meter reports the compressed request rather than the full saved history", () => {
  const history = Array.from({ length: MAX_CONTEXT_MESSAGES + 12 }, (_, index) => ({ role: "user", content: `消息 ${index} ${"影像".repeat(150)}` }));
  const preview = contextWindowUsage(history, "继续当前任务");
  assert.equal(preview.sentChars, JSON.stringify(boundedContext([...history, { role: "user", content: "继续当前任务" }])).length);
  assert.ok(preview.sentChars <= MAX_CONTEXT_CHARS);
  assert.ok(preview.messageCount <= MAX_CONTEXT_MESSAGES);
  assert.equal(preview.compressed, true);
});

test("long conversations keep current task and complete tool call/result pairs", () => {
  const older = Array.from({ length: 36 }, (_, index) => [
    { role: "user", content: `第 ${index} 次规划 ${"区域".repeat(120)}` },
    { role: "assistant", content: `第 ${index} 次结果 ${"图源".repeat(120)}` },
  ]).flat();
  const call = { id: "call-final", type: "function", function: { name: "jobs_get", arguments: '{"jobId":"job-1"}' } };
  const current = [
    { role: "user", content: "继续检查 job-1" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call-final", content: '{"jobId":"job-1","state":"completed"}' },
  ];
  const result = boundedContext([...older, ...current]);
  assert.ok(result.length < 60);
  assert.ok(JSON.stringify(result).length <= 42_000);
  assert.match(result[0].content, /本机自动压缩/);
  assert.deepEqual(result.slice(-3), current);
});

test("oversized tool rounds are compacted without mutating saved messages", () => {
  const call = { id: "call-1", type: "function", function: { name: "sources_list", arguments: "{}" } };
  const original = [
    { role: "user", content: "查找图源" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call-1", content: "x".repeat(45_000) },
  ];
  const result = boundedContext(original);
  assert.ok(JSON.stringify(result).length <= 42_000);
  assert.equal(result[1].tool_calls[0].id, "call-1");
  assert.equal(result[2].tool_call_id, "call-1");
  assert.equal(original[2].content.length, 45_000);
});

test("many tool rounds compact at a call boundary", () => {
  const rounds = Array.from({ length: 35 }, (_, index) => {
    const call = { id: `call-${index}`, type: "function", function: { name: "jobs_get", arguments: '{"jobId":"job-1"}' } };
    return [
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: '{"state":"completed"}' },
    ];
  }).flat();
  const result = boundedContext([{ role: "user", content: "持续检查作业" }, ...rounds]);
  assert.ok(result.length <= 60);
  assert.match(result[1].content, /本轮较早的工具处理摘要/);
  for (const message of result.filter(item => item.role === "tool")) {
    assert.ok(result.some(item => item.role === "assistant" && item.tool_calls?.some(call => call.id === message.tool_call_id)));
  }
});

test("MCP result pages survive compaction so the model can read the complete result", () => {
  const older = Array.from({ length: 32 }, (_, index) => ({ role: "user", content: `旧对话 ${index} ${"背景".repeat(180)}` }));
  const call = { id: "call-mcp", type: "function", function: { name: "mcp_call", arguments: '{}' } };
  const page = JSON.stringify({ connectorId: "humaps", toolName: "search_map_layers", result: {
    paged: true, executionId: "generation:call-mcp", offset: 0, totalChars: 14_000,
    content: "中国图层".repeat(1_400), nextOffset: 7_000, complete: false,
  } });
  const result = boundedContext([...older,
    { role: "user", content: "搜索中国图层" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call-mcp", content: page },
  ]);
  assert.equal(result.at(-1).content, page);
  assert.ok(JSON.stringify(result).length <= 42_000);
});
