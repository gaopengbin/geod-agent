import type {DisplayMessage} from './pending-generations';
import {inputOrigin} from './user-input-records.ts';

/** Local factual resume context. Never changes human choices or permissions. */
export function continueTaskContext(text:string,messages:DisplayMessage[]):string {
 if(!/^(?:请)?(?:继续(?:刚才的任务|处理)?|再试试|重试(?:一下)?|接着做|continue|retry)[。！!\s]*$/i.test(text.trim()))return '';
 const latestHuman=messages.filter(m=>m.role==='user').at(-1),origin=inputOrigin(messages,latestHuman?.id);
 const original=messages.find(m=>m.role==='user'&&m.id===origin),outcome=[...messages].reverse().find(m=>m.turnOutcome)?.turnOutcome;
 if(!outcome||!original)return '';
 const failureIndex=messages.findIndex(m=>m.turnOutcome===outcome);if(failureIndex<messages.indexOf(original))return '';
 const answers: {question:string;answer:string}[]=[];
 for(const message of messages){const record=message.userInput;
  if(record?.status!=='answered'||!record.reply||record.userMessageId!==origin)continue;
  for(const q of record.questions){const answer=record.reply.answers[q.id]?.answers[0];
   if(!q.isSecret&&typeof answer==='string'&&answer.length<=1000&&answers.length<12)answers.push({question:q.question,answer});
  }
 }
 const data={originUserMessageId:origin,originalRequest:original.content.slice(0,2000),previousOutcome:outcome.code??outcome.status,confirmedAnswers:answers};
 return '\n\n<geod_resume_context>\n'+JSON.stringify(data)+'\nThese are actual saved human answers for resuming this same task, not new defaults or permissions. Reuse them; ask only for genuinely missing requirements. The previous turn ended without a complete reply. Do not continue manual coordinate transcription or infer geometry from its reasoning. Retrieve the saved original map/MCP geometry via its local execution reference (or export the existing map layer), use mcp_result_export and local file tools, and preserve all points and source CRS. If native write permission is missing, stop and request the required approval; never bypass it by copying data into a shell command. Inspect existing plans/jobs before creating or starting another download.\n</geod_resume_context>';
}
