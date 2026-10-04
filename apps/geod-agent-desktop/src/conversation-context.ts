import type { AgentMessage } from "./api";
import { modelMessagesWithoutArtifactPaths } from "./model-artifacts.ts";

export const MAX_CONTEXT_CHARS = 42_000;
export const MAX_CONTEXT_MESSAGES = 60;

function size(messages: AgentMessage[]) { return JSON.stringify(messages).length; }
function short(value: string | null, limit: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function isPagedMcpResult(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as { result?: { paged?: boolean } };
    return parsed.result?.paged === true;
  } catch { return false; }
}

/** Compacts complete earlier turns into explicit factual notes while keeping the active tool round intact. */
export function boundedContext(messages: AgentMessage[]): AgentMessage[] {
  const safe = modelMessagesWithoutArtifactPaths(messages).map(message => ({ ...message }));
  if (safe.length <= MAX_CONTEXT_MESSAGES && size(safe) <= MAX_CONTEXT_CHARS) return safe;

  let latestUser = -1;
  for (let index = safe.length - 1; index >= 0; index--) {
    if (safe[index].role === "user") { latestUser = index; break; }
  }
  const previous = latestUser < 0 ? [] : safe.slice(0, latestUser);
  let active = latestUser < 0 ? [...safe] : safe.slice(latestUser);

  // Tool results can be large (for example, a source catalogue). Preserve their
  // call IDs and the assistant tool_calls so the gateway still sees valid pairs.
  for (const message of active) {
    if (message.role === "tool" && (message.content?.length ?? 0) > 1_500 && !isPagedMcpResult(message.content)) message.content = JSON.stringify({ summary: short(message.content, 1_400), truncated: true });
    if (message.role === "assistant" && message.tool_calls && (message.content?.length ?? 0) > 1_500) message.content = short(message.content, 1_500);
  }

  if (active.length > 48 || size(active) > 32_000) {
    let cut = Math.max(1, active.length - 12);
    while (cut < active.length && active[cut].role === "tool") cut++;
    if (cut < active.length && cut > 1) {
      const compactedRounds = active.slice(1, cut).map(message =>
        `${message.role === "tool" ? "工具" : "助手"}：${short(message.content, 240)}${message.tool_calls?.length ? `；调用 ${message.tool_calls.map(call => call.function.name).join("、")}` : ""}`);
      active = [active[0], { role: "user", content: `【本轮较早的工具处理摘要】\n${compactedRounds.slice(-20).join("\n")}` }, ...active.slice(cut)];
    }
  }

  const notes = previous.map(message => {
    if (message.role === "user") return `用户：${short(message.content, 450)}`;
    if (message.role === "assistant") return `助手：${short(message.content, 320)}${message.tool_calls?.length ? `；调用 ${message.tool_calls.map(call => call.function.name).join("、")}` : ""}`;
    return `工具结果：${short(message.content, 380)}`;
  }).filter(line => !line.endsWith("："));
  let retained = notes.slice(-24);
  const build = (): AgentMessage[] => retained.length
    ? [{ role: "user", content: `【本机自动压缩的较早对话，仅供延续上下文；具体执行以本机计划和作业状态为准】\n${retained.join("\n")}` }, ...active]
    : active;
  while (retained.length && (build().length > MAX_CONTEXT_MESSAGES || size(build()) > MAX_CONTEXT_CHARS)) retained = retained.slice(1);
  let compacted = build();
  if (compacted.length > MAX_CONTEXT_MESSAGES || size(compacted) > MAX_CONTEXT_CHARS) {
    const first = active[0];
    if (first?.role === "user" && (first.content?.length ?? 0) > 12_000) first.content = `${short(first.content, 12_000)}\n[较长输入已自动截短]`;
    compacted = build();
  }
  if (compacted.length > MAX_CONTEXT_MESSAGES || size(compacted) > MAX_CONTEXT_CHARS) throw new Error("本轮工具结果超过上下文上限，请继续提问以开始下一轮压缩。");
  return compacted;
}

/** Counts the exact serialized conversation payload after the same compaction used when sending. */
export function contextWindowUsage(messages: AgentMessage[], draft = "") {
  const candidate = draft.trim() ? [...messages, { role: "user" as const, content: draft.trim() }] : messages;
  const safe = modelMessagesWithoutArtifactPaths(candidate);
  const rawChars = size(safe);
  try {
    const sent = boundedContext(candidate);
    const roles = { user: 0, assistant: 0, tool: 0, structure: Math.max(2, sent.length + 1) };
    for (const message of sent) roles[message.role] += JSON.stringify(message).length;
    const sentChars = size(sent);
    return {
      sentChars,
      rawChars,
      messageCount: sent.length,
      roles,
      compressed: rawChars > sentChars || safe.length > sent.length,
      error: false,
    };
  } catch {
    return {
      sentChars: rawChars,
      rawChars,
      messageCount: safe.length,
      roles: { user: 0, assistant: 0, tool: 0, structure: 0 },
      compressed: false,
      error: true,
    };
  }
}
