import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {RuntimePolicy,RUNTIME_TOOLS} from '../src-tauri/runtime-policy.mjs';
import {createHost} from '../src-tauri/codex-host.mjs';
const declared=JSON.parse(readFileSync(new URL('../src-tauri/codex-tools.json',import.meta.url)));
const params={conversationId:'blocked-task',input:'下载指定图源，不能换源，也暂不提供 Key',permission:'fullAccess'};
const facts={permission:'fullAccess',imagery:{available:true,tasks:[],data:{available:true,tasks:[]}},sourceReadiness:{available:true,sources:{locked:{state:'missing',revision:'none'}},plans:{p:['locked']}}};
function fixture(){const home=mkdtempSync(join(tmpdir(),'geod-task-report-'));const policy=new RuntimePolicy(home,[...declared,...RUNTIME_TOOLS]);policy.begin(params,{});policy.setFacts(facts);return {home,policy};}
test('a verified unchanged prerequisite can end with a durable actionable report, without granting completion or permissions',async()=>{
 const {policy,home}=fixture();const failed=await policy.execute('jobs_start',{planId:'p'},'source-missing',()=>({error:'SOURCE_CREDENTIAL_REQUIRED'}));
 assert(failed.executionBlocker?.id);
 const report=await policy.execute('runtime_task_report',{blockerIds:[failed.executionBlocker.id]},'report',()=>assert.fail('native report must not call a model or provider'));
 assert.equal(report.feedback.status,'waiting');assert.equal(report.objectiveComplete,false);assert.equal(report.downloadsCancelled,false);
 assert.match(report.feedback.next,/补全认证/);assert.notEqual(policy.state.goal.state,'complete');
 assert.equal((await policy.execute('jobs_start',{planId:'different'},'stale-sibling',()=>assert.fail())).error,'TASK_REPORTED_BLOCKED');
 const persisted=JSON.parse(readFileSync(join(home,'execution-checkpoint.json')));assert.equal(persisted.run.taskReport.feedback.source,'native-runtime');
 // A new user turn resumes the same task records; the old report cannot stop it.
 policy.begin({...params,input:'认证已经补全，继续'},{});policy.setFacts({...facts,sourceReadiness:{...facts.sourceReadiness,sources:{locked:{state:'ready',revision:'saved'}}}});
 assert.equal(policy.reportForRun(),null);assert.equal((await policy.execute('jobs_start',{planId:'p'},'resume',()=>({jobId:'j',state:'queued'}))).jobId,'j');
});
test('old errors, changed conditions, argument repairs and user stops cannot be declared permanent blockers',async()=>{
 const {policy}=fixture();const bad=await policy.execute('jobs_start',{planId:'p'},'bad',()=>({error:'SOURCE_CREDENTIAL_REQUIRED'}));
 policy.setFacts({...facts,sourceReadiness:{...facts.sourceReadiness,sources:{locked:{state:'ready',revision:'changed'}}}});
 assert.equal((await policy.execute('runtime_task_report',{blockerIds:[bad.executionBlocker.id]},'report',()=>assert.fail())).error,'REPORT_EVIDENCE_REQUIRED');
 assert.equal((await policy.execute('runtime_task_report',{blockerIds:['invented']},'invented',()=>assert.fail())).error,'REPORT_EVIDENCE_REQUIRED');
 const parameter=await policy.execute('jobs_start',{planId:'another'},'parameter',()=>({error:'INVALID_SOURCE_ID'}));assert.equal(parameter.executionBlocker,undefined);
 const stopped=await policy.execute('jobs_start',{planId:'stopped'},'stop',()=>({error:'USER_STOPPED'}));assert.equal(stopped.executionBlocker,undefined);
});
test('unknown submissions remain unknown in the report and native work is never cancelled',async()=>{
 const {policy}=fixture();let cancellations=0;
 const result=await policy.execute('jobs_start',{planId:'p'},'lost',()=>{throw Error('receipt lost');});
 const report=await policy.execute('runtime_task_report',{blockerIds:[result.executionBlocker.id]},'report',()=>cancellations++);
 assert.equal(report.feedback.status,'unknown');assert.equal(cancellations,0);assert.equal(policy.view().unresolvedOperations.length,1);assert.match(report.feedback.next,/核对/);
});
test('native delivery failure is reportable even though submission succeeded, and partial results are retained',async()=>{
 const {policy}=fixture();
 await policy.execute('jobs_start',{planId:'complete'},'complete',()=>({jobId:'complete-job',state:'completed',backgroundResult:{jobId:'complete-job',state:'completed',verified:true,artifact:{quality:{status:'complete',missingTiles:0},assets:[{bytes:100,sha256:'a'.repeat(64)}]}}}));
 const result=await policy.execute('jobs_start',{planId:'failed'},'failed',()=>({jobId:'failed-job',state:'failed',backgroundResult:{jobId:'failed-job',state:'failed',verified:false,errorCode:'SOURCE_NETWORK'}}));
 assert.equal(result.executionBlocker.code,'SOURCE_NETWORK');
 assert.equal(Object.values(policy.state.operations).find(o=>o.resource?.includes('failed')).state,'succeeded','submission receipt is not a failed submission');
 const report=await policy.execute('runtime_task_report',{blockerIds:[result.executionBlocker.id]},'report',()=>assert.fail());
 assert.equal(report.feedback.status,'partial');assert.equal(report.feedback.completed,1);assert.match(report.feedback.progress,/1 项/);
});
test('real Core closes a reported blocker locally without a third supplier request',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-core-task-report-'));let listener,models=0,tools=0;
 const reply=(event,value)=>listener({type:'response',requestId:event.requestId,value});
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{runtimePolicyNative:true,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{}},emit:event=>{
  if(event.type==='policyState')reply(event,facts);
  if(event.type==='tool'){assert.equal(event.tool,'jobs_start');tools++;reply(event,{result:{error:'SOURCE_CREDENTIAL_REQUIRED'}});}
  if(event.type==='model'){
   models++;assert(models<=2,'native closure must not request a third supplier generation');
   const blocker=JSON.stringify(event.request.input).match(/blocker-[a-f0-9-]{36}/)?.[0];
   if(models===2){assert(blocker);assert(event.request.tools.some(t=>t.name==='runtime_task_report'));}
   const call=models===1?{name:'jobs_start',arguments:'{"planId":"p"}'}:{name:'runtime_task_report',arguments:JSON.stringify({blockerIds:[blocker]})};
   reply(event,{generationId:event.generationId,state:'settled',inputTokens:10,outputTokens:5,result:{content:null,toolCalls:[{id:'call-'+models,type:'function',function:call}]}});
  }
 }});
 try{const done=await host.turn({...params,workspace:home,history:[]});assert.equal(done.status,'completed');assert.equal(done.taskFeedback.status,'waiting');assert.match(done.text,/补全认证/);assert.equal(models,2);assert.equal(tools,1);assert.equal(JSON.parse(readFileSync(join(home,'execution-checkpoint.json'))).run.completionRegistration.complete,false);}
 finally{await host.close();}
});
