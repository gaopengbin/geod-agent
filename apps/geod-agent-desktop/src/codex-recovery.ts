export interface ConversationExecution {busy:boolean;runId:string|null;stopping:boolean}
export interface RecoveryClient {
  runtimeCapabilities:()=>Promise<{conversationExecution?:boolean}>;
  codexConversationStatus:(conversationId:string)=>Promise<ConversationExecution>;
  codexConversationStop:(conversationId:string)=>Promise<ConversationExecution>;
}

/** Called only when this client has no live turn. Read the native lease, not billing. */
export async function prepareCodexConversation(client:RecoveryClient,conversationId:string) {
  if(!(await client.runtimeCapabilities()).conversationExecution)return;
  if(!(await client.codexConversationStatus(conversationId)).busy)return;
  const stopped=await client.codexConversationStop(conversationId);
  if(stopped.busy)throw Object.assign(new Error('上一轮仍在停止，请稍后再发送消息。'),{code:'CODEX_BUSY'});
}

/** Old saved busy outcomes never represent an executed model turn. */
export function conversationBusyFailure(cause:unknown):boolean {
  const value=cause as {code?:string;message?:string}|null;
  const text=typeof cause==='string'?cause:value?.message??'';
  return value?.code==='CODEX_BUSY'||['此会话正在处理上一轮请求','Codex 正在处理上一轮对话','上一轮仍在停止'].some(message=>text.includes(message));
}

/** Billing rejection before dispatch is terminal, not an uncertain model result.
 * Read server evidence and the native lease; never stop or retry a live turn. */
export async function confirmedCreditRejection(client:Pick<RecoveryClient,'runtimeCapabilities'|'codexConversationStatus'>&{
  agentGenerationGet:(id:string)=>Promise<{generationId:string;conversationId:string;state:string;errorCode:string|null}>
},conversationId:string,generationId:string):Promise<boolean> {
  if(!(await client.runtimeCapabilities()).conversationExecution)return false;
  const [generation,execution]=await Promise.all([client.agentGenerationGet(generationId),client.codexConversationStatus(conversationId)]);
  return !execution.busy&&generation.generationId===generationId&&generation.conversationId===conversationId&&generation.state==='failed'&&['BILLING_INSUFFICIENT_CREDIT','BILLING_CREDIT_IN_USE'].includes(generation.errorCode??'');
}
