import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { DisplayMessage } from "./pending-generations";
export const CODEX_HOOK_LABELS: Record<string, string> = {
  sessionStart: "会话开始", sessionEnd: "会话结束", userPromptSubmit: "提交消息",
  preToolUse: "工具执行前", permissionRequest: "请求权限时", postToolUse: "工具执行后",
  preCompact: "压缩上下文前", postCompact: "压缩上下文后", subagentStart: "子任务开始",
  subagentStop: "子任务结束", stop: "回复结束", interrupt: "中断回复",
};

// Pinned to the generated protocol of the runtime checked by codex-host.
export function reduceCodexItems(messages: DisplayMessage[], runId: string, method: string, params: Record<string, unknown>): DisplayMessage[] {
  const hook = params.run as { id: string; eventName: string; status: string; statusMessage?: string; executionMode: string } | undefined;
  const id = `codex-${runId}-${String(hook?.id ?? params.itemId ?? (params.item as ThreadItem | undefined)?.id ?? "")}`;
  const previous = messages.find(item => item.id === id);
  const upsert = (change: Partial<DisplayMessage>): DisplayMessage[] => previous
    ? messages.map(item => item.id === id ? { ...item, ...change } : item)
    : [...messages, { id, turnId: runId, role: "tool", content: "", ...change }];
  if ((method === "hook/started" || method === "hook/completed") && hook?.id) return upsert({
    itemType: "hook", content: (hook.executionMode === "async" && method === "hook/started" ? "后台自动化已启动 · " : "自动化 · ") + (hook.statusMessage || CODEX_HOOK_LABELS[hook.eventName] || hook.eventName),
    details: JSON.stringify(params.run, null, 2), toolStatus: ["failed", "blocked"].includes(hook.status) ? "attention" : method === "hook/completed" || hook.executionMode === "async" ? "success" : "running",
  });
  if (method === "item/agentMessage/delta") return upsert({ role: "assistant", content: (previous?.content ?? "") + String(params.delta ?? ""), phase: previous?.phase ?? "progress", streaming: true });
  if (method === "item/reasoning/summaryTextDelta") return upsert({ itemType: "reasoning", content: "思考", details: (previous?.details ?? "") + String(params.delta ?? ""), toolStatus: "running" });
  if (method === "item/commandExecution/outputDelta") return upsert({ itemType: "commandExecution", content: previous?.content ?? "运行命令", details: (previous?.details ?? "") + String(params.delta ?? ""), toolStatus: "running" });
  if (method === "item/mcpToolCall/progress") return upsert({ content: previous?.content ?? "调用 MCP 工具", details: String(params.message ?? ""), toolStatus: "running" });
  if (method !== "item/started" && method !== "item/completed") return messages;
  const item = params.item as ThreadItem | undefined;
  if (!item?.id || item.type === "userMessage" || item.type === "dynamicToolCall") return messages;
  const completed = method === "item/completed";
  const toolStatus = completed ? "success" : "running";
  switch (item.type) {
    case "agentMessage": return upsert({ role: "assistant", content: item.text || previous?.content || "", phase: item.phase === "commentary" ? "progress" : item.phase === "final_answer" || completed ? "final" : previous?.phase ?? "progress", streaming: !completed });
    case "reasoning": return upsert({ itemType: item.type, content: "思考", details: item.summary.join("\n") || previous?.details, toolStatus });
    case "commandExecution": return upsert({ itemType: item.type, content: item.command, details: item.aggregatedOutput ?? previous?.details, toolStatus: item.status === "failed" || item.status === "declined" ? "attention" : toolStatus });
    case "mcpToolCall": return upsert({ itemType: item.type, content: `${item.server} · ${item.tool}`, details: JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2), toolStatus: item.status === "failed" ? "attention" : toolStatus });
    case "fileChange": return upsert({ itemType: item.type, content: `修改 ${item.changes.length} 个文件`, details: JSON.stringify(item.changes, null, 2), toolStatus: item.status === "failed" || item.status === "declined" ? "attention" : toolStatus });
    case "contextCompaction": return upsert({ itemType: item.type, content: completed ? "上下文已压缩" : "正在压缩上下文", toolStatus });
    case "plan": return upsert({ role: "assistant", content: item.text, phase: "progress", streaming: !completed });
    case "functionCallOutput": return messages;
    default: return upsert({ itemType: item.type, content: item.type, details: JSON.stringify(item, null, 2), toolStatus });
  }
}
