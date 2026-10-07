import { api, errorMessage, type AgentMessage, type AgentToolCall, type Generation, type ImageAttachment, type DocumentAttachment } from "./api";
import { modelMessagesWithoutArtifactPaths } from "./model-artifacts";
import { guardedCodexTurn } from "./codex-liveness";
import {runtimeCompatibilityFailure} from "./app-error";

export interface CodexTokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; modelContextWindow: number | null }
export type CodexEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "heartbeat" }
  | { type: "thread"; threadId: string }
  | { type: "event"; method: string; params: Record<string, unknown> }
  | { type: "generation"; generationId: string; inputTokens?: number; state: string }
  | { type: "model"; generationId: string }
  | { type: "generationResult"; generation: Generation }
  | { type: "capabilities"; capabilities: { model: string; contextWindow: number; contextWindowSource: string; reasoning: boolean } }
  | { type: "request"; requestId: string; method: string; params: Record<string, unknown> }
  | { type: "steered"; text: string }
  | { type: "commandError"; message: string }
  | { type: "tool"; requestId: string; tool: string; arguments: Record<string, unknown>; callId: string; threadId: string };
export interface CodexResult { threadId: string; id: string; status: "completed" | "interrupted" | "failed"; text: string; error?: { message: string } | null }
export interface CodexHooks {
  onEvent: (event: CodexEvent) => void;
  onModel: (generationId: string, messages: AgentMessage[]) => void | Promise<void>;
  onGeneration: (generation: Generation) => void;
  onRequest: (request: Extract<CodexEvent, { type: "request" }>) => Promise<unknown>;
  execute: (call: AgentToolCall, executionId: string, context: AgentMessage[], requestId:string) => Promise<{ result: unknown }>;
}

/** Codex owns the turn loop; this adapter only fulfils requests from that loop. */
export async function runCodexTurn(runId: string, conversationId: string, input: string, history: AgentMessage[], hooks: CodexHooks, images?:ImageAttachment[],documents?:DocumentAttachment[]): Promise<CodexResult> {
  let context: AgentMessage[] = [...history, { role: "user", content: input, ...(images?.length?{images}:{}),...(documents?.length?{documents}:{}) }];
  let callbacksError: unknown;
  let active = true;
  let checkpoint: Promise<void> = Promise.resolve();
  const fulfilled = new Set<string>();
  async function respond(requestId: string, value: unknown, error?: string) {
    if (!active || fulfilled.has(requestId)) return;
    fulfilled.add(requestId);
    await api.codexCommand(runId, { type: "response", requestId, value, ...(error ? { error } : {}) });
  }
  const handle = async (event: CodexEvent) => {
    if (!active) return;
    if (event.type === "steered") context = [...context, { role: "user", content: event.text }];
    try {
      hooks.onEvent(event);
      if (event.type === "model") {
        const modelContext = context;
        checkpoint = checkpoint.then(() => hooks.onModel(event.generationId, modelContext));
        await checkpoint;
      } else if (event.type === "generationResult") {
        hooks.onGeneration(event.generation);
      } else if (event.type === "request") {
        if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(event.method)) throw new Error(`当前客户端尚未支持此请求：${event.method}`);
        await respond(event.requestId, await hooks.onRequest(event));
      } else if (event.type === "tool") {
        await checkpoint;
        const call: AgentToolCall = { id: event.callId, type: "function", function: { name: event.tool, arguments: JSON.stringify(event.arguments) } };
        const output = await hooks.execute(call, `codex:${conversationId}`, context,event.requestId);
        context = [...context, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: JSON.stringify(output.result) }];
        await respond(event.requestId, output);
      }
    } catch (cause) {
      if (event.type === "request" || event.type === "tool") await respond(event.requestId, null, errorMessage(cause)).catch(() => {});
      callbacksError = cause;
      if ((event.type !== "request" && event.type !== "tool") || runtimeCompatibilityFailure(cause)) await api.codexCommand(runId, { type: "interrupt" }).catch(() => {});
    }
  };
  try {
    const result = await guardedCodexTurn(activity => api.codexTurn(runId, conversationId, input, modelMessagesWithoutArtifactPaths(history), event => { activity(); void handle(event); }, images,documents), {
      probe: () => api.authStatus(), interrupt: () => api.codexCommand(runId, { type: "interrupt" }),
    });
    await checkpoint;
    if (callbacksError) throw callbacksError;
    if (result.status === "failed") throw new Error(result.error?.message || "Codex 对话失败，请重试。");
    return result;
  } finally { active = false; }
}
