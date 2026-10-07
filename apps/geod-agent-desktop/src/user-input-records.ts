import {inputQuestions,validatedInputReply,type UserInputQuestion,type UserInputReply} from './user-input.ts';
import {crsFromAnswers} from './export-crs.ts';
import type {DisplayMessage} from './pending-generations';
export interface UserInputDraft {page:number;values:Record<string,string>;custom:Record<string,boolean>;drafts:Record<string,string>}
export interface UserInputRecord {
  requestId:string; questions:UserInputQuestion[]; status:'pending'|'answered'|'cancelled'|'resolved';
  userMessageId?:string; userText?:string; reply?:UserInputReply; draft?:UserInputDraft;
  toolCallId?:string; createdAt:string;
  resolution?:{kind:'existingMcp';connectorId:string;name:string;url:string}|{kind:'existingPlanCrs';planId:string;crs:string;resampling:'nearest'|'bilinear'|'cubic'};
}
const fingerprint=(q:UserInputQuestion)=>JSON.stringify([q.header,q.question,q.options??[]]);
export function inputOrigin(messages:DisplayMessage[],userMessageId?:string){
  const humans=messages.filter(m=>m.role==='user'),index=humans.findIndex(m=>m.id===userMessageId);
  if(index<0)return userMessageId;
  const submitted=messages.find(m=>m.userInput?.status==='answered'&&m.userInput.reply&&userInputReplyText(m.userInput,m.userInput.reply)===humans[index].content)?.userInput;
  if(submitted?.userMessageId)return submitted.userMessageId;
  let cursor=index;
  while(cursor>0&&/^(?:请)?(?:继续(?:刚才的任务|处理)?|再试试|重试(?:一下)?|接着做|continue|retry)[。！!\s]*$/i.test(humans[cursor].content.split('\n已附加边界：')[0].trim()))cursor--;
  return humans[cursor].id;
}
export function reusableInputReply(questions:UserInputQuestion[],messages:DisplayMessage[],userMessageId?:string):UserInputReply|null {
  const origin=inputOrigin(messages,userMessageId);
  const values=new Map<string,string>();
  for(const message of messages){const record=message.userInput;if(record?.status!=='answered'||!record.reply||record.userMessageId!==origin)continue;
    for(const q of record.questions){const answer=record.reply.answers[q.id]?.answers[0];if(answer)values.set(fingerprint(q),answer);}
  }
  if(!questions.every(q=>values.has(fingerprint(q))))return null;
  return {answers:Object.fromEntries(questions.map(q=>[q.id,{answers:[values.get(fingerprint(q))!]}]))};
}
export function answeredCrsChoice(messages:DisplayMessage[],userMessageId?:string){
  const origin=inputOrigin(messages,userMessageId);
  for(const item of [...messages].reverse()){
    const record=item.userInput;if(record?.status!=='answered'||record.userMessageId!==origin)continue;
    const choice=crsFromAnswers(record.questions,record.reply??null);if(choice)return choice;
  }
  return null;
}
/** Recover actual accepted legacy ask_user results, never infer an answer from assistant prose. */
export function restoreUserInputRecords(messages:DisplayMessage[]):DisplayMessage[]{
  let human:DisplayMessage|undefined,changed=false;
  const recorded=new Set(messages.flatMap(m=>m.userInput?.toolCallId?[m.userInput.toolCallId]:[]));
  const result=messages.map(item=>{
    if(item.role==='user')human=item;
    if(item.userInput||item.toolName!=='ask_user'||!item.details||recorded.has(item.id))return item;
    try{
      const data=JSON.parse(item.details),questions=inputQuestions(data.arguments?.questions);
      if(questions.some(q=>q.isSecret)||data.result?.answeredBy!=='user')return item;
      const reply=validatedInputReply(questions,data.result);if(!reply)return item;
      changed=true;return {...item,userInput:{requestId:'saved-'+item.id,questions,status:'answered' as const,reply,userMessageId:human?.id,userText:human?.content,toolCallId:item.id,createdAt:''}};
    }catch{return item;}
  });
  return changed?result:messages;
}
export function userInputReplyText(record:UserInputRecord,reply:UserInputReply){
  return `${record.userText?'继续原请求：'+record.userText+'\n\n':''}我在问答卡中提交的回答：\n${record.questions.map(q=>q.question+'：'+reply.answers[q.id].answers[0]).join('\n')}\n请按这些回答继续处理。`;
}
export const detachedUserInput={userInputSaved:true} as const;
export const isDetachedUserInput=(value:unknown)=>!!value&&typeof value==='object'&&(value as {userInputSaved?:unknown}).userInputSaved===true;
