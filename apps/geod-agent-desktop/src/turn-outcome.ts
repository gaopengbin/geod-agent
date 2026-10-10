import type {DisplayMessage} from './pending-generations';

export interface TurnOutcome {
 status:'failed'|'interrupted'|'incomplete';
 message:string;
 code?:string;
 generationId?:string;
}
export function turnOutcomeMessage(turnId:string,outcome:TurnOutcome):DisplayMessage {
 return {id:'turn-outcome-'+turnId,turnId,role:'tool',itemType:'turnOutcome',toolStatus:'attention',content:outcome.message,turnOutcome:outcome};
}
export function modelResponseIssue(generation:{state?:string;result?:{content?:string|null;toolCalls?:unknown[];finishReason?:string;response?:unknown}|null}|null):string|null {
 if(generation?.state!=='settled'||!generation.result)return null;
 const result=generation.result;
 if(result.finishReason==='length')return 'MODEL_OUTPUT_LIMIT';
 if(result.finishReason==='content_filter')return 'MODEL_CONTENT_FILTERED';
 if(!result.response&&!String(result.content??'').trim()&&!result.toolCalls?.length)return 'MODEL_EMPTY_RESPONSE';
 return null;
}
export function outputFailureCode(message:string):string|undefined {
 if(message.includes('次模型请求上限'))return 'MODEL_CALL_LIMIT';
 if(message.includes('模型输出达到本次上限'))return 'MODEL_OUTPUT_LIMIT';
 if(message.includes('模型只返回了思考或空内容'))return 'MODEL_EMPTY_RESPONSE';
 if(message.includes('模型供应商未返回完整内容'))return 'MODEL_CONTENT_FILTERED';
}
/** Historic running flags are not proof of an active run or its cause. */
export function orphanedReasoningTurn(messages:DisplayMessage[]):string|null {
 const last=messages.at(-1);
 if(last?.itemType!=='reasoning'||last.toolStatus!=='attention'||last.streaming||!last.turnId)return null;
 const records=messages.filter(message=>message.turnId===last.turnId);
 if(records.some(message=>message.turnOutcome||message.userInput?.status==='pending'||message.role==='assistant'&&message.phase==='final'))return null;
 return last.turnId;
}
export interface NativeProofClient {
 billingRunSnapshot:(runId:string)=>Promise<{status:string;conversationId:string;generations:{generationId:string}[]}>;
 agentGenerationGet:(generationId:string)=>Promise<{state?:string;result?:{content?:string|null;toolCalls?:unknown[];finishReason?:string;response?:unknown}|null}>;
}
/** Add a factual end marker to legacy reasoning-only history; never generate an answer or resume work. */
export async function recoverTurnOutcome(messages:DisplayMessage[],conversationId:string,client:NativeProofClient):Promise<DisplayMessage|null> {
 const turnId=orphanedReasoningTurn(messages);if(!turnId)return null;
 const proof=await client.billingRunSnapshot(turnId);
 if(proof.conversationId!==conversationId||!['completed','failed','interrupted'].includes(proof.status))return null;
 const last=proof.generations.at(-1);if(!last)return null;
 const generation=await client.agentGenerationGet(last.generationId),code=modelResponseIssue(generation);
 if(!code)return null;
 return turnOutcomeMessage(turnId,{status:'incomplete',code,generationId:last.generationId,message:code==='MODEL_OUTPUT_LIMIT'?'模型输出达到本次上限，没有完成回复或后续操作。已确认的需求仍然保留，可以继续处理。':'这一轮已结束，但模型只返回了思考，没有最终回复或后续操作。已确认的需求仍然保留，可以继续处理。'});
}
