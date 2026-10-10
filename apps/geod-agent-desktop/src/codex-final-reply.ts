import type {DisplayMessage} from './pending-generations';
import {modelResponseIssue, type NativeProofClient} from './turn-outcome.ts';

function lastIndex<T>(items:T[],match:(item:T)=>boolean):number {
  for(let i=items.length-1;i>=0;i--)if(match(items[i]))return i;
  return -1;
}

const belongs = (item:DisplayMessage, runId:string) => item.turnId===runId || item.id.startsWith(`codex-${runId}-`);
const isReply = (item:DisplayMessage) => item.role==='assistant' && !item.itemType && !item.turnOutcome;
// An earlier announcement cannot become a final reply after more actual work.
// Async lifecycle hooks and task monitor rows may legitimately arrive afterwards.
const laterWork = (items:DisplayMessage[],index:number,runId:string) => items.slice(index+1).some(item=>belongs(item,runId)
  && !item.backgroundJob && item.itemType!=='hook' && !item.userInput
  && (item.role==='tool' || item.phase==='progress'));

/** Use native turn completion and its actual last assistant text, never busy=false alone. */
export function completeCodexReply(messages:DisplayMessage[],runId:string,result:{status:string;text:string}):DisplayMessage[] {
  if(result.status!=='completed' || !result.text.trim())return messages;
  let index=lastIndex(messages,item=>belongs(item,runId)&&isReply(item)&&item.content.trim()===result.text.trim());
  if(index<0)index=lastIndex(messages,item=>belongs(item,runId)&&isReply(item)&&!!item.streaming&&result.text.startsWith(item.content));
  if(index>=0&&laterWork(messages,index,runId))return messages;
  let changed=false;
  const next=messages.map((item,i)=>{
    if(i===index && (item.phase!=='final'||item.streaming||item.content!==result.text)) {
      changed=true;return {...item,phase:'final' as const,streaming:false,content:result.text};
    }
    if(belongs(item,runId)&&item.itemType==='reasoning'&&item.toolStatus!=='success') {
      changed=true;return {...item,toolStatus:'success' as const,streaming:false};
    }
    return item;
  });
  if(index<0)return [...next,{id:`codex-${runId}-final-reply`,turnId:runId,role:'assistant',phase:'final',streaming:false,content:result.text}];
  return changed?next:messages;
}

/** Candidate only; saved progress flags are not proof of a completed turn. */
export function orphanedReplyTurn(messages:DisplayMessage[]):string|null {
  const start=lastIndex(messages,item=>item.role==='user');
  const tail=messages.slice(start+1);
  const index=lastIndex(tail,item=>isReply(item)&&item.phase==='progress'&&!!item.content.trim()&&!!item.turnId);
  const runId=tail[index]?.turnId;
  if(!runId||laterWork(tail,index,runId)||tail.some(item=>belongs(item,runId)&&(item.turnOutcome||item.userInput?.status==='pending'||isReply(item)&&item.phase==='final')))return null;
  return runId;
}

function responseText(response:unknown):string {
  if(!response||typeof response!=='object'||!('output' in response)||!Array.isArray(response.output))return '';
  for(const item of [...response.output].reverse()) {
    if(item?.type!=='message'||item.role!=='assistant'||!Array.isArray(item.content))continue;
    const text=item.content.filter((part:{type?:string;text?:unknown})=>part.type==='output_text'&&typeof part.text==='string').map((part:{text:string})=>part.text).join('');
    if(text.trim())return text;
  }
  return '';
}

/** Repair historic presentation only after account-scoped native receipt + generation proof. */
export async function recoverCodexReply(messages:DisplayMessage[],conversationId:string,client:NativeProofClient):Promise<DisplayMessage[]|null> {
  const runId=orphanedReplyTurn(messages);if(!runId)return null;
  const proof=await client.billingRunSnapshot(runId);
  if(proof.conversationId!==conversationId||proof.status!=='completed')return null;
  const last=proof.generations.at(-1);if(!last)return null;
  const generation=await client.agentGenerationGet(last.generationId);
  if(generation.state!=='settled'||!generation.result||modelResponseIssue(generation)||generation.result.toolCalls?.length)return null;
  const response=generation.result.response;
  if(response&&typeof response==='object'&&'output' in response&&Array.isArray(response.output)&&response.output.some(item=>['function_call','custom_tool_call'].includes(item?.type)))return null;
  const text=responseText(generation.result.response)||generation.result.content||'';
  if(!text.trim())return null;
  const next=completeCodexReply(messages,runId,{status:'completed',text});
  return next===messages?null:next;
}
