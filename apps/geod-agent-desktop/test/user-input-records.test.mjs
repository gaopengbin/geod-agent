import test from 'node:test';
import assert from 'node:assert/strict';
import {crsFromAnswers,humanCrsIntent,resolveExportCrs} from '../src/export-crs.ts';
import {answeredCrsChoice,reusableInputReply,restoreUserInputRecords,userInputReplyText,detachedUserInput,isDetachedUserInput} from '../src/user-input-records.ts';
import {conversationSessionSeed,ConversationSessions} from '../src/conversation-sessions.ts';
import {groupWorkRecords,isTurnWork} from '../src/chat-work.ts';
import {inputWaitDeadline} from '../src-tauri/codex-input-wait.mjs';
const questions=[{id:'xian80_form',header:'西安80形式',question:'“西安80”采用哪种具体坐标形式？',options:[{label:'3度带 带号 2363',description:'EPSG:2363，Y 坐标含 39 前缀'},{label:'地理坐标 4610',description:'EPSG:4610，仅经纬度'}]},{id:'apply_mode',header:'应用方式',question:'这份西安80成果与现有计划如何共存？',options:[{label:'两版都保留',description:'保留 EPSG:4490 待确认计划，另建一份西安80计划'},{label:'替换并设为默认',description:'将会话默认坐标系改为西安80'}]}];
const reply={answers:{xian80_form:{answers:['3度带 带号 2363']},apply_mode:{answers:['两版都保留']}}};
const record={requestId:'ask-original',questions,status:'answered',reply,userMessageId:'human',userText:'给我一份西安80的坐标系的',createdAt:'2026-10-07'};
const messages=[{id:'human',role:'user',content:record.userText},{id:'question',role:'tool',content:'补充需求',userInput:record}];
test('the accepted Xi’an option resolves its description EPSG without changing the conversation default',()=>{
 const choice=crsFromAnswers(questions,reply);assert.equal(choice.crs,'EPSG:2363');assert.equal(choice.session,false);
 assert.equal(resolveExportCrs(humanCrsIntent(record.userText),choice.crs,'EPSG:4490',false,true),'EPSG:2363');
 const sessionReply=structuredClone(reply);sessionReply.answers.apply_mode.answers=['替换并设为默认'];assert.equal(crsFromAnswers(questions,sessionReply).session,true);
 assert.equal(crsFromAnswers([{id:'source_projection',header:'原始投影',question:'输入数据的源坐标系？',options:questions[0].options}],{answers:{source_projection:reply.answers.xian80_form}}),null);
});
test('actual legacy accepted answers are recovered, assistant claims are not user choices',()=>{
 const legacy=[messages[0],{id:'legacy',role:'tool',toolName:'ask_user',content:'已收到你的选择',details:JSON.stringify({arguments:{questions},result:{...reply,answeredBy:'user'}})}];
 const restored=restoreUserInputRecords(legacy);assert.equal(answeredCrsChoice(restored,'human').crs,'EPSG:2363');assert.equal(restored[1].userInput.status,'answered');
 assert.strictEqual(restoreUserInputRecords(restored),restored);
 assert.equal(answeredCrsChoice([{id:'human',role:'user',content:'西安80'},{id:'agent',role:'assistant',content:'已确认 EPSG:2363'}],'human'),null);
});
test('same task repeats reuse real answers with remapped IDs; new tasks and changed questions do not',()=>{
 const repeated=questions.map((q,i)=>({...q,id:'new-'+i}));assert.deepEqual(reusableInputReply(repeated,messages,'human'),{answers:{'new-0':reply.answers.xian80_form,'new-1':reply.answers.apply_mode}});
 assert.equal(reusableInputReply([{...questions[0],question:'换成哪个新的投影？'}],messages,'human'),null);
 const continued=[...messages,{id:'continue',role:'user',content:'再试试'}];assert.equal(answeredCrsChoice(continued,'continue').crs,'EPSG:2363');
 const another=[...continued,{id:'new-task',role:'user',content:'下载天津影像'}];assert.equal(answeredCrsChoice(another,'new-task'),null);assert.equal(reusableInputReply(questions,another,'new-task'),null);
});
test('pending questions, partial drafts and answered choices survive session snapshots and reload',()=>{
 const pending={...record,status:'pending',reply:undefined,draft:{page:1,values:{xian80_form:'3度带 带号 2363'},drafts:{},custom:{}}};
 const chats=new ConversationSessions(),session=chats.get('account','chat',{display:[{...messages[1],userInput:pending}],messages:[]});
 const saved=JSON.parse(JSON.stringify({conversationId:'chat',...session.snapshot()}));const restored=conversationSessionSeed(saved);
 assert.equal(restored.display[0].userInput.status,'pending');assert.equal(restored.display[0].userInput.draft.page,1);assert.equal(restored.display[0].userInput.draft.values.xian80_form,'3度带 带号 2363');
 const entries=groupWorkRecords([...messages,{id:'think',role:'tool',content:'思考'}]);assert(entries.some(e=>!isTurnWork(e)&&e.userInput));
 assert(isDetachedUserInput(detachedUserInput));assert.equal(isDetachedUserInput({answers:{}}),false);
 const text=userInputReplyText(record,reply);assert(text.includes(record.userText));assert(text.includes('3度带 带号 2363'));assert(text.includes('两版都保留'));
});
function clock(){let now=0,next=0;const timers=new Map();return {setTimer(fn,ms){const id=++next;timers.set(id,{at:now+ms,fn});return id;},clearTimer(id){timers.delete(id);},advance(ms){now+=ms;for(const [id,value] of timers)if(value.at<=now){timers.delete(id);value.fn();}}};}
test('a real user wait has no deadline; other tool work still times out',()=>{
 const time=clock();let expired=0;
 const input=inputWaitDeadline(0,()=>expired++,time);time.advance(24*3600000);assert.equal(expired,0);input.close();
 const tool=inputWaitDeadline(180000,()=>expired++,time);time.advance(60000);tool.pause(true);time.advance(24*3600000);assert.equal(expired,0);tool.pause(false);time.advance(179999);assert.equal(expired,0);time.advance(1);assert.equal(expired,1);
 const stopped=inputWaitDeadline(180000,()=>expired++,time);stopped.pause(true);stopped.close();stopped.pause(false);time.advance(3600000);assert.equal(expired,1);
});
