import test from 'node:test';import assert from 'node:assert/strict';
import {buildTaskFeedback,taskFeedbackText} from '../src-tauri/task-feedback.mjs';
import {terminalTaskFeedback,needsTerminalFeedback} from '../src/task-feedback.ts';
const trace={id:'tool',turnId:'run',role:'tool',toolName:'jobs_start',content:'启动影像',details:JSON.stringify({arguments:{planId:'p'},result:{error:'SOURCE_NETWORK'}})};
const client={imagery:async()=>[{stored:{planId:'p'},job:{jobId:'j',state:'completed'}}],data:async()=>[],active:async()=>[]};
test('an actual source credential blocker explains the condition and recovery without a blind retry',()=>{
 const f=buildTaskFeedback({code:'SOURCE_CREDENTIAL_REQUIRED'});assert.equal(f.status,'waiting');assert.equal(f.canContinue,false);
 const text=taskFeedbackText(f);assert.match(text,/本机认证/);assert.match(text,/图源管理/);assert.match(text,/参数和任务记录保留/);assert.doesNotMatch(text,/SOURCE_CREDENTIAL|sk-|\bkey=/);
});
test('verified partial results, active background work and unverified state remain distinct',()=>{
 const partial=buildTaskFeedback({code:'SOURCE_NETWORK',resources:[{id:'done',state:'completed',verified:true}]});assert.equal(partial.status,'partial');assert.match(partial.progress,/1 项/);
 const running=buildTaskFeedback({code:'SOURCE_NETWORK',resources:[{state:'downloading',active:true}]});assert.equal(running.status,'background');assert.match(running.retained,/不会取消/);
 const unknown=buildTaskFeedback({code:'SOURCE_NETWORK',resources:[{state:'downloading'}]});assert.equal(unknown.status,'unknown');assert.doesNotMatch(unknown.retained,/已取消|下载失败/);
 assert.equal(buildTaskFeedback({code:'SOURCE_NETWORK',factsKnown:false}).status,'unknown');
 assert.equal(buildTaskFeedback({code:'SOURCE_NETWORK',unresolved:1}).canContinue,false);
 const approval=buildTaskFeedback({resources:[{id:'p',state:'pending'}]});assert.equal(approval.status,'waiting');assert.match(approval.progress,/计划等待执行/);assert.match(approval.next,/确认入口/);
});
test('completed turn feedback scopes results to this turn and never treats an unreadable ledger as zero or failure',async()=>{
 const f=await terminalTaskFeedback([trace],'run',client);assert.equal(f.completed,1);assert.equal(f.status,'partial');
 const other=await terminalTaskFeedback([{...trace,turnId:'old'}],'run',client);assert.equal(other.completed,0);
 const unavailable=await terminalTaskFeedback([trace],'run',{...client,imagery:async()=>{throw Error('unavailable');}});assert.equal(unavailable.status,'unknown');assert.match(unavailable.progress,/未能读取/);
 const slow=await terminalTaskFeedback([trace],'run',{...client,imagery:()=>new Promise(()=>{})},{probeMs:5});assert.equal(slow.status,'unknown');
});
test('only actual final replies suppress terminal feedback; pending questions remain actionable and normal stops remain explicit',async()=>{
 assert.equal(needsTerminalFeedback([trace],'run'),true);
 assert.equal(needsTerminalFeedback([{id:'f',turnId:'run',role:'assistant',phase:'final',content:'无法取得指定时期数据，已保留任务。'}],'run'),false);
 assert.equal(needsTerminalFeedback([{id:'stop',turnId:'run',role:'tool',content:'已停止',turnOutcome:{status:'interrupted'}}],'run'),false);
 const waiting=await terminalTaskFeedback([{id:'q',turnId:'run',role:'tool',content:'补充需求',userInput:{status:'pending'}}],'run',client);assert.equal(waiting.status,'waiting');assert.match(waiting.next,/待回答/);
 const provisional={id:'connection',turnId:'run',role:'tool',content:'',turnOutcome:{status:'incomplete',code:'CODEX_TOOL_OUTCOME_UNKNOWN'}};
 assert.equal(needsTerminalFeedback([provisional],'run'),true,'a reconnect notice cannot replace the eventual final outcome');
 const connection=buildTaskFeedback({code:'CODEX_TOOL_OUTCOME_UNKNOWN',factsKnown:false});assert.match(connection.next,/重新连接/);assert.equal(connection.canContinue,false);
});
test('upstream quota errors do not invent a balance cause, and English feedback is complete',()=>{
 const f=buildTaskFeedback({code:'HTTP_402',english:true});assert.match(f.reason,/recorded diagnostics/);assert.doesNotMatch(f.reason,/insufficient|exhausted/i);assert.match(taskFeedbackText(f,true),/Next step:/);
});
