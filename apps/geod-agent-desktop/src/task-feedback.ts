import {buildTaskFeedback,type FeedbackResource,type TaskFeedback} from '../src-tauri/task-feedback.mjs';
import type {DisplayMessage} from './pending-generations';

interface FeedbackClient {
 imagery:()=>Promise<{stored:{planId:string};job:{jobId:string;state:string}|null}[]>;
 data:()=>Promise<{id:string;status:string}[]>;
 active:()=>Promise<string[]>;
}
const sameTurn=(m:DisplayMessage,runId:string)=>m.turnId===runId||m.id.startsWith(`codex-${runId}-`);
function records(messages:DisplayMessage[],runId:string){
 const ids=new Set<string>();let code='';
 for(const m of messages.filter(m=>sameTurn(m,runId))){
  if(m.backgroundJob){ids.add(m.backgroundJob.jobId);ids.add(m.backgroundJob.planId);}
  if(!m.toolName||!m.details)continue;
  try{
   const detail=JSON.parse(m.details),args=detail.arguments??{},result=detail.result?.result??detail.result;
   for(const value of [args.jobId,args.planId,args.taskId,result?.jobId,result?.planId,result?.taskId,result?.id])if(typeof value==='string')ids.add(value);
   const failure=typeof result?.error==='string'?result.error:result?.error?.code;
   if(typeof failure==='string'&&failure!=='USER_STOPPED')code=failure;
  }catch{/* A text trace is not authoritative structured evidence. */}
 }
 return {ids,code};
}
/** A bounded, read-only status probe. A missing/slow ledger stays unknown; it
 * neither times out nor cancels the actual download or model task. */
export async function terminalTaskFeedback(messages:DisplayMessage[],runId:string,client:FeedbackClient,{code='',english=false,probeMs=3000}:{code?:string;english?:boolean;probeMs?:number}={}):Promise<TaskFeedback>{
 const captured=records(messages,runId),resources:FeedbackResource[]=[];
 const probe=async<T,>(read:()=>Promise<T>):Promise<T|null>=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(read),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),probeMs);})]);}
  catch{return null;}finally{if(timer)clearTimeout(timer);}
 };
 const [imagery,data,active]=await Promise.all([probe(client.imagery),probe(client.data),probe(client.active)]);
 for(const item of imagery??[])if(captured.ids.has(item.stored.planId)||item.job&&captured.ids.has(item.job.jobId))resources.push(item.job?{id:item.job.jobId,state:item.job.state,verified:item.job.state==='completed',active:active?active.includes(item.job.jobId):undefined}:{id:item.stored.planId,state:'pending',verified:false});
 for(const task of data??[])if(captured.ids.has(task.id))resources.push({id:task.id,state:task.status,verified:task.status==='completed',active:undefined});
 const pending=messages.some(m=>sameTurn(m,runId)&&m.userInput?.status==='pending');
 return buildTaskFeedback({code:code||(pending?'USER_INPUT_PENDING':captured.code),resources,factsKnown:imagery!==null&&data!==null,english});
}

/** A real final reply wins. Terminal Core status alone does not create a reply. */
export function needsTerminalFeedback(messages:DisplayMessage[],runId:string){
 return !messages.some(m=>sameTurn(m,runId)&&(m.turnOutcome&&!['CODEX_CONNECTION_UNKNOWN','CODEX_TOOL_OUTCOME_UNKNOWN'].includes(m.turnOutcome.code??'')||m.role==='assistant'&&m.phase==='final'&&!m.streaming&&m.content.trim()));
}
