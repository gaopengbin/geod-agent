// Run with Node --env-file on the server. Never print the key or model response.
import assert from "node:assert/strict";

const apiKey = process.env.DEEPSEEK_API_KEY;
assert.ok(apiKey, "DEEPSEEK_API_KEY is required");
const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const tools = [{
  type: "function",
  function: {
    name: "sources_list",
    description: "List imagery sources registered on this device. Read only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
}];
const messages = [
  { role: "system", content: "You are GeoD Agent. Call sources_list before answering. Answer in Chinese after reading its result." },
  { role: "user", content: "请先调用 sources_list，再告诉我测试图源的名称。" },
];

async function complete() {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", thinking: { type: "disabled" }, max_tokens: 256, stream: false }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`DeepSeek tools probe failed with HTTP ${response.status}`);
  const body = await response.json();
  const message = body?.choices?.[0]?.message;
  const usage = body?.usage;
  assert.ok(message && Number.isSafeInteger(usage?.total_tokens), "Invalid DeepSeek tools response");
  return { message, usage };
}

const first = await complete();
const calls = first.message.tool_calls;
assert.ok(Array.isArray(calls) && calls.some(call => call.function?.name === "sources_list"), "DeepSeek did not call sources_list");
messages.push({ role: "assistant", content: first.message.content ?? null, tool_calls: calls });
for (const call of calls) {
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify(call.function?.name === "sources_list"
      ? { sources: [{ id: "probe-naip", name: "USGS NAIP test source", license: "public domain" }] }
      : { error: "TOOL_NOT_AVAILABLE_IN_PROBE" }),
  });
}
const second = await complete();
assert.match(second.message.content ?? "", /USGS|NAIP/i, "DeepSeek did not use the tool result");
console.log(`DeepSeek tools verified: sources_list -> tool result -> answer; billed ${first.usage.total_tokens + second.usage.total_tokens} tokens`);
