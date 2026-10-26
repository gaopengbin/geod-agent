import { api, errorMessage, type AgentMessage, type AgentToolCall, type Generation, type ImageAttachment, type DocumentAttachment } from "./api";
import { modelMessagesWithoutArtifactPaths } from "./model-artifacts";
import { guardedCodexTurn } from "./codex-liveness";
import {runtimeCompatibilityFailure} from "./app-error";
import {followNativeRun,type RunSnapshot} from './codex-stream-client';

export interface CodexTokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; modelContextWindow: number | null }
type CodexEventPayload =
  | { type: "stage"; stage: string; message: string }
  | { type: "heartbeat" }
  | {type:"spending";accountId:string;conversationId:string;spending:import('./context-settings').Spending}
  | { type: "thread"; threadId: string }
  | { type: "event"; method: string; params: Record<string, unknown> }
  | { type: "generation"; generationId: string; inputTokens?: number; state: string }
  | { type: "model"; generationId: string }
  | { type: "generationResult"; generation: Generation }
  | { type: "capabilities"; capabilities: { model: string; contextWindow: number; contextWindowSource: string; reasoning: boolean } }
  | { type: "request"; requestId: string; method: string; params: Record<string, unknown> }
  | { type: "connection"; state:'connected'|'reconnecting'|'unavailable'; attempt?:number; details?:string }
  | { type: "steered"; text: string; input?:string;requestId?: string;imageIds?:string[];documentIds?:string[] }
  | { type: "commandError"; message: string; commandType?: string; requestId?: string; code?: string;outcomeUnknown?:boolean }
  | { type: "tool"; requestId: string; tool: string; arguments: Record<string, unknown>; callId: string; threadId: string;operationId?:string };
export type CodexEvent=CodexEventPayload&{sequence?:number;runId?:string;emittedAt?:number};
export type CodexRunSnapshot=RunSnapshot<CodexResult>;
export interface CodexResult { threadId: string; id: string; status: "completed" | "interrupted" | "failed"; text: string;durationMs?:number; error?: { message: string } | null }
export interface CodexHooks {
  onEvent: (event: CodexEvent) => void;
  onModel: (generationId: string, messages: AgentMessage[]) => void | Promise<void>;
  onGeneration: (generation: Generation) => void;
  followupAttachments?:(requestId:string)=>{images?:ImageAttachment[];documents?:DocumentAttachment[]}|undefined;
  onRequest: (request: Extract<CodexEvent, { type: "request" }>,sendReply?:(value:unknown)=>Promise<void>) => Promise<unknown>;
  execute: (call: AgentToolCall, executionId: string, context: AgentMessage[], requestId:string) => Promise<{ result: unknown }>;
}

/** Codex owns the turn loop; this adapter only fulfils requests from that loop. */
export async function runCodexTurn(runId: string, conversationId: string, input: string, history: AgentMessage[], hooks: CodexHooks, images?:ImageAttachment[],documents?:DocumentAttachment[],resumeAfter?:number): Promise<CodexResult> {
  let context: AgentMessage[] = resumeAfter!==undefined?history:[...history, { role: "user", content: input, ...(images?.length?{images}:{}),...(documents?.length?{documents}:{}) }];
  let callbacksError: unknown;
  let active = true;
  let checkpoint: Promise<void> = Promise.resolve();
  const fulfilled = new Set<string>();
  const replying=new Map<string,Promise<void>>();
  const processing=new Set<string>();
  const recovery=new AbortController();
  let durableCallbacks=false;
  async function respond(requestId: string, value: unknown, error?: string) {
    if (!active || fulfilled.has(requestId)) return;
    if(replying.has(requestId))return replying.get(requestId);
    const pending=api.codexCommand(runId, { type: "response", requestId, value, ...(error ? { error } : {}) });replying.set(requestId,pending);
    try{await pending;fulfilled.add(requestId);}finally{replying.delete(requestId);}
  }
  const handle = async (event: CodexEvent) => {
    if (!active) return;
    const callback=event.type==='request'||event.type==='tool'?event.requestId:null;
    if(callback&&(fulfilled.has(callback)||processing.has(callback)))return;
    if(callback)processing.add(callback);
    if (event.type === "steered") context = [...context, { role: "user", content: event.input??event.text,...(event.requestId?hooks.followupAttachments?.(event.requestId):{}) }];
    try {
      if(callback&&durableCallbacks){
        const claim=await api.codexCallbackClaim(runId,conversationId,callback);
        if(claim.state==='replied'){await api.codexCommand(runId,claim.response!);fulfilled.add(callback);return;}
        if(claim.state==='outcome-unknown'){
          recovery.abort(Object.assign(Error('上一工具请求已提交，结果尚未确认。请先检查任务与成果，再恢复执行，避免重复操作。'),{code:'CODEX_TOOL_OUTCOME_UNKNOWN'}));return;
        }
      }
      hooks.onEvent(event);
      if(event.type==='spending')window.dispatchEvent(new CustomEvent('geod:execution-spending-changed',{detail:event}));
      if (event.type === "model") {
        const modelContext = context;
        checkpoint = checkpoint.then(() => hooks.onModel(event.generationId, modelContext));
        await checkpoint;
      } else if (event.type === "generationResult") {
        hooks.onGeneration(event.generation);
      } else if (event.type === "request") {
        if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "geod/executionReview"].includes(event.method)) throw new Error(`当前客户端尚未支持此请求：${event.method}`);
        await respond(event.requestId, await hooks.onRequest(event,event.method==='geod/executionReview'?value=>respond(event.requestId,value):undefined));
      } else if (event.type === "tool") {
        await checkpoint;
        const call: AgentToolCall = { id: event.callId, type: "function", function: { name: event.tool, arguments: JSON.stringify(event.arguments) } };
        const output = await hooks.execute(call, event.operationId?`runtime-operation:${event.operationId}`:`codex:${conversationId}`, context,event.requestId);
        context = [...context, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: JSON.stringify(output.result) }];
        await respond(event.requestId, output);
      }
    } catch (cause) {
      if (event.type === "request" || event.type === "tool") await respond(event.requestId, null, errorMessage(cause)).catch(() => {});
      // A malformed model question is returned to Core as a request error so
      // it can correct the question. It is not a failed user interaction.
      if(event.type==='request'&&event.method==='item/tool/requestUserInput'&&(cause as {code?:string})?.code==='CRS_OPTION_CONFLICT')return;
      callbacksError = cause;
      if ((event.type !== "request" && event.type !== "tool") || runtimeCompatibilityFailure(cause)) await api.codexCommand(runId, { type: "interrupt" }).catch(() => {});
    }finally{if(callback)processing.delete(callback);}
  };
  try {
    const capabilities=await api.runtimeCapabilities();
    durableCallbacks=!!capabilities.conversationReconnect;
    const result = capabilities.conversationReconnect?await followNativeRun<CodexResult,CodexEvent>({runId,
      start:resumeAfter===undefined?receive=>api.codexTurn(runId,conversationId,input,modelMessagesWithoutArtifactPaths(history),receive,images,documents):undefined,
      afterSequence:resumeAfter,signal:recovery.signal,
      reconnect:(after,receive)=>api.codexRunReconnect(runId,conversationId,after,receive),onEvent:event=>void handle(event),
      onConnection:status=>hooks.onEvent({type:'connection',...status,runId}),
    }):await guardedCodexTurn(activity => api.codexTurn(runId, conversationId, input, modelMessagesWithoutArtifactPaths(history), event => { activity(); void handle(event); }, images,documents), {
      probe: () => api.authStatus(), interrupt: async () => {
        await api.codexCommand(runId, { type: "interrupt" }).catch(cause=>{if((cause as {code?:string})?.code!=='CODEX_RUN_NOT_FOUND')throw cause;});
        if((await api.runtimeCapabilities()).conversationExecution)await api.codexConversationStop(conversationId);
      },
    });
    await checkpoint;
    if (callbacksError) throw callbacksError;
    if (result.status === "failed") throw new Error(result.error?.message || "Codex 对话失败，请重试。");
    return result;
  } finally { active = false; }
}
