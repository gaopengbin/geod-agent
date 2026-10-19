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

/** Inspect a terminal uncertain request without releasing its billing receipt,
 * replaying its response, or stopping a live native turn. */
export async function inspectCodexCheckpoint(client:Pick<RecoveryClient,'runtimeCapabilities'|'codexConversationStatus'>&{
  agentGenerationGet:(id:string)=>Promise<{generationId:string;conversationId:string;state:string}>
},conversationId:string,generationId:string):Promise<{billingPending:boolean}> {
  if(!(await client.runtimeCapabilities()).conversationExecution)
    throw new Error('请先重启应用以恢复已保存进度。原请求的费用核对记录会保留。');
  const [receipt,execution]=await Promise.all([
    client.agentGenerationGet(generationId).then(value=>({value,error:null as unknown})).catch(error=>({value:null,error})),
    client.codexConversationStatus(conversationId),
  ]);
  if(execution.busy||execution.stopping)
    throw Object.assign(new Error('上一轮仍在执行或停止中，请稍后检查状态。'),{code:'CODEX_BUSY'});
  // Only confirmed absence plus an idle native lease permits continuation.
  // Network/auth failures do not prove that the request was never dispatched.
  if(receipt.error){
    if((receipt.error as {code?:string})?.code==='GENERATION_NOT_FOUND')return {billingPending:false};
    throw receipt.error;
  }
  const generation=receipt.value!;
  if(generation.generationId!==generationId||generation.conversationId!==conversationId)
    throw new Error('请求记录与当前会话不匹配，无法恢复。');
  if(!['settled','failed','pending_reconcile'].includes(generation.state))
    throw new Error('模型请求仍在处理中，请稍后检查。已完成的本机工具不会自动重复执行。');
  return {billingPending:generation.state==='pending_reconcile'};
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
