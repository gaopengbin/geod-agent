import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RuntimePolicy,RUNTIME_TOOLS,hash,unsupportedSchemaErrors} from '../src-tauri/runtime-policy.mjs';
import {GEOD_POLICY} from '../src-tauri/runtime-policy-geod.mjs';
import {createHost} from '../src-tauri/codex-host.mjs';
import {codexRequest} from '../../../packages/codex-protocol/codex-contract.mjs';
const declared=JSON.parse(readFileSync(new URL('../src-tauri/codex-tools.json',import.meta.url)));
const params={conversationId:'policy-test',input:'下载所选范围，保留确认的参数',permission:'fullAccess',outputCrs:'EPSG:4326'};
function fixture(){const home=mkdtempSync(join(tmpdir(),'geod-policy-'));let now=100000,signals=[];const policy=new RuntimePolicy(home,declared,{now:()=>now,onSignal:s=>signals.push(s)});policy.begin(params,{inputModalities:['text']});return{home,policy,signals,tick:ms=>now+=ms};}

test('verified native submissions register exact resources automatically without a bookkeeping tool call',async()=>{
 const {policy,home}=fixture();const artifact={quality:{status:'complete',missingTiles:0},assets:[{id:'raster',bytes:100,sha256:'a'.repeat(64)}]};
 await policy.execute('jobs_start',{planId:'native-plan'},'start',async()=>({jobId:'real-job',state:'queued',backgroundResult:{jobId:'real-job',state:'completed',verified:true,artifact}}));
 const registration=policy.compactView().completionRegistration;assert.equal(registration.complete,true);assert.deepEqual(registration.ids,['real-job']);assert.deepEqual(policy.state.goal.nativeDeliverables,['real-job']);
 policy.finish('completed');assert.equal(policy.state.run.completionRegistration.complete,true);
 const restored=new RuntimePolicy(home,declared);assert.equal(restored.state.nativeResources['real-job'].verified,true);
 assert(!readFileSync(join(home,'execution-decisions.jsonl'),'utf8').includes('goal-update'),'no model-driven registration is needed');
});

test('partial/failed native results and another job identifier cannot pass automatic completion',async()=>{
 const {policy}=fixture(),artifact={quality:{status:'complete',missingTiles:0},assets:[{bytes:100,sha256:'a'.repeat(64)}]};
 for(const [i,state]of ['partial','failed','cancelled','paused'].entries())await policy.execute('jobs_start',{planId:'p'+i},'c'+i,()=>({jobId:'j'+i,state:'queued',backgroundResult:{jobId:'j'+i,state,verified:false,artifact}}));
 await policy.execute('jobs_start',{planId:'wrong'},'wrong',()=>({jobId:'owned',backgroundResult:{jobId:'different',state:'completed',verified:true,artifact}}));
 await policy.execute('jobs_get',{jobId:'requested'},'wrong-read',()=>({jobId:'other',backgroundResult:{jobId:'other',state:'completed',verified:true,artifact}}));
 assert.equal(policy.compactView().completionRegistration.complete,false);assert(Object.values(policy.state.nativeResources).every(r=>!r.verified));
});

test('resuming a manually approved job registers its native receipt without re-submission or completion bookkeeping',async()=>{
 const {policy}=fixture(),artifact={quality:{status:'complete',missingTiles:0},assets:[{bytes:100,sha256:'a'.repeat(64)}]};
 await policy.execute('jobs_get',{jobId:'user-approved'},'read-approved',()=>({jobId:'user-approved',state:'completed',backgroundResult:{jobId:'user-approved',state:'completed',verified:true,artifact}}));
 assert.deepEqual(policy.compactView().completionRegistration.ids,['user-approved']);assert.equal(policy.compactView().completionRegistration.complete,true);
});

test('checkpoint projection omits verbose historical receipts while explicit state pages retain them',()=>{
 const {policy}=fixture();for(let i=0;i<12;i++)policy.state.evidence['old'+i]={id:'old'+i,goalId:'old-goal',verified:false,summary:{data:'x'.repeat(5000)}};
 const full=JSON.stringify(policy.view()),projected=JSON.stringify(policy.context({input:[]}).input);
 assert(projected.length<full.length*.1);assert(policy.view().evidence.some(e=>e.id==='old0'));assert(!projected.includes('xxxxx'));
});

test('all GeoD tools have an explicit adapter, and model state tools cannot bypass schema/native evidence',async()=>{
 for(const t of declared){assert(GEOD_POLICY.tools[t.function.name]||RUNTIME_TOOLS.some(r=>r.function.name===t.function.name),t.function.name);assert.deepEqual(unsupportedSchemaErrors(t.function.parameters),[],t.function.name);}
 const {policy}=fixture();let effects=0;
 const output=await policy.execute('jobs_start',{planId:17},'bad',()=>effects++);assert.equal(output.error,'TOOL_ARGUMENT_INVALID');assert.equal(effects,0);
 assert.equal(policy.update({action:'complete',expectedRevision:policy.state.revision,evidenceIds:['model-says-done']}).error,'COMPLETION_EVIDENCE_REQUIRED');
 assert.equal(policy.update({action:'amend',expectedRevision:1}).error,'TASK_REVISION_CONFLICT');
});
test('unchanged service outage is shared across different search arguments; retry runs below the model and honors cooldown',async()=>{
 const {policy,signals,tick}=fixture();let attempts=0;
 const fail=()=>{attempts++;return{error:'REGISTRY_UNAVAILABLE'};};
 await policy.execute('mcp_registry_search',{query:'provider-a'},'a',fail);assert.equal(attempts,3);
 const blocked=await policy.execute('mcp_registry_search',{query:'different-provider'},'b',fail);assert.equal(blocked.error,'RECOVERY_CONDITION_UNCHANGED');assert.equal(attempts,3);
 await policy.execute('mcp_registry_search',{query:'different-query-again'},'c',fail);assert.equal(signals.length,1);
 tick(30001);await policy.execute('mcp_registry_search',{query:'healthy'},'d',()=>{attempts++;return{candidates:['official']};});assert.equal(attempts,4);assert.equal(policy.state.stagnation,0);
});
test('permission recovery depends on native state; model proposals and another submission ID cannot grant it',async()=>{
 const {policy}=fixture();policy.setFacts({permission:'confirmEach',outputCrs:params.outputCrs});let executed=0;
 const start=()=>{executed++;return{error:'APPROVAL_REQUIRED'};};await policy.execute('jobs_start',{planId:'p1'},'a',start);
 policy.update({action:'amend',expectedRevision:policy.state.revision,objective:'用户已授权'});
 assert.equal((await policy.execute('jobs_start',{planId:'p2'},'b',start)).error,'RECOVERY_CONDITION_UNCHANGED');assert.equal(executed,1);
 policy.setFacts({permission:'fullAccess',outputCrs:params.outputCrs});await policy.execute('jobs_start',{planId:'p2'},'c',()=>{executed++;return{jobId:'j2',state:'queued'};});assert.equal(executed,2);
 policy.setFacts({permission:'confirmEach',outputCrs:params.outputCrs});assert.equal(policy.builtinPre({tool_name:'Bash',tool_use_id:'old-permission',tool_input:{command:'old-authorized-command'}}).error,'WORKSPACE_PERMISSION_CHANGED');
 policy.begin({...params,permission:'confirmEach'},{inputModalities:['text']});assert.equal(policy.builtinPre({tool_name:'Bash',tool_use_id:'new-permission',tool_input:{command:'new-turn-command'}}),null);
});
test('business refusal is scoped to its native object; independent jobs continue and an actual object change permits recovery',async()=>{
 const {policy}=fixture();let executed=0;
 const refused=()=>{executed++;return{error:'PLAN_EXPIRED'};};
 await policy.execute('jobs_start',{planId:'expired'},'expired-1',refused);
 assert.equal((await policy.execute('jobs_start',{planId:'expired'},'expired-2',refused)).error,'RECOVERY_CONDITION_UNCHANGED');assert.equal(executed,1);
 await policy.execute('jobs_start',{planId:'independent'},'independent',()=>{executed++;return{jobId:'other',state:'queued'};});assert.equal(executed,2);
 policy.setFacts({permission:'fullAccess',outputCrs:params.outputCrs,imagery:{tasks:[{planId:'expired',state:'not_started',planHash:'renewed'}]}});
 assert.equal((await policy.execute('jobs_start',{planId:'expired'},'renewed',()=>{executed++;return{jobId:'renewed-job',state:'queued'};})).jobId,'renewed-job');assert.equal(executed,3);
});

test('successful effects deduplicate across call IDs, simultaneous requests, process recreation and turn continuation',async()=>{
 const {policy,home}=fixture();let executed=0,release;const wait=new Promise(r=>release=r);
 const submit=async()=>{executed++;await wait;return{jobId:'job-once',state:'queued'};};
 const first=policy.execute('jobs_start',{planId:'p'},'id1',submit);
 const second=await policy.execute('jobs_start',{planId:'p'},'id2',submit);assert.equal(second.error,'OPERATION_RECONCILIATION_REQUIRED');release();await first;
 assert.equal((await policy.execute('jobs_start',{planId:'p'},'id3',submit)).jobId,'job-once');assert.equal(executed,1);
 policy.finish('completed');const reopened=new RuntimePolicy(home,declared);reopened.begin(params,{inputModalities:['text']});assert.equal((await reopened.execute('jobs_start',{planId:'p'},'id4',submit)).jobId,'job-once');assert.equal(executed,1);
 assert(readFileSync(join(home,'execution-decisions.jsonl'),'utf8').includes('operation-reused'));
});
test('lost side-effect outcome survives a crash; only actual native job state reconciles the submission',async()=>{
 const {policy,home}=fixture();let submitted=0;await policy.execute('jobs_start',{planId:'p'},'x',()=>{submitted++;throw new Error('lost response');});
 const reopened=new RuntimePolicy(home,declared);reopened.begin(params,{inputModalities:['text']});assert.equal((await reopened.execute('jobs_start',{planId:'p'},'y',()=>submitted++)).error,'OPERATION_RECONCILIATION_REQUIRED');assert.equal(submitted,1);
 reopened.setFacts({permission:'fullAccess',outputCrs:params.outputCrs,imagery:{available:true,tasks:[{planId:'p',jobId:'native-job',state:'completed'}]}});
 assert.equal((await reopened.execute('jobs_start',{planId:'p'},'z',()=>submitted++)).jobId,'native-job');assert.equal(submitted,1);
});
test('confirmed requirements inherit across revisions/restart; explicitly invalidated fields are asked again',async()=>{
 const {policy,home}=fixture();let asked=0;const questions=[{id:'resolution',header:'分辨率',question:'使用哪个层级？',options:[{label:'z14',description:'快速'},{label:'z18',description:'详细'}]}];
 const answer=()=>{asked++;return{answers:{resolution:{answers:['z14']}},answeredBy:'user'};};await policy.execute('ask_user',{questions},'a',answer);
 policy.update({action:'amend',expectedRevision:policy.state.revision,objective:'只修改保存位置'});
 const reopened=new RuntimePolicy(home,declared);reopened.begin(params,{inputModalities:['text']});assert((await reopened.execute('ask_user',{questions},'b',answer)).reusedPreviousAnswer);assert.equal(asked,1);
 reopened.update({action:'amend',expectedRevision:reopened.state.revision,invalidateRequirements:['question:resolution']});await reopened.execute('ask_user',{questions},'c',answer);assert.equal(asked,2);
 assert.equal(reopened.state.requirements['conversation.outputCrs'].source,'native-user-selection');
});
test('MCP schema preflight uses discovered current contracts; old capability declarations cannot be reused after change',async()=>{
 const {policy}=fixture();let executed=0;
 const args={connectorId:'map',toolName:'move',arguments:{longitude:'bad'}};
 assert.equal((await policy.execute('mcp_call',args,'1',()=>executed++)).error,'TOOL_DISCOVERY_REQUIRED');
 await policy.execute('extensions_list',{},'2',()=>({connectors:[{connectorId:'map',tools:[{name:'move',inputSchema:{type:'object',properties:{longitude:{type:'number',minimum:-180,maximum:180}},required:['longitude'],additionalProperties:false}}]}]}));
 assert.equal((await policy.execute('mcp_call',args,'3',()=>executed++)).error,'TOOL_ARGUMENT_INVALID');assert.equal(executed,0);
 await policy.execute('mcp_call',{...args,arguments:{longitude:116}},'4',()=>{executed++;return{state:'moved'};});assert.equal(executed,1);
 policy.begin(params,{inputModalities:['text'],model:'changed'});assert.equal((await policy.execute('mcp_call',args,'5',()=>executed++)).error,'TOOL_DISCOVERY_REQUIRED');
});
test('native waits do not trip stagnation, progressing tasks exceed twelve steps, and cancelling blocks new effects',async()=>{
 const {policy,signals}=fixture();for(let i=0;i<40;i++)await policy.execute('jobs_get',{jobId:'j'},String(i),()=>({state:'downloading',completed:i<30?i:29}));assert.equal(signals.length,0);
 for(let i=0;i<16;i++)await policy.execute('workspace_status',{},'progress'+i,()=>({milestone:i}));assert.equal(signals.length,0);
 policy.cancel();let executed=0;assert.equal((await policy.execute('jobs_start',{planId:'p'},'stop',()=>executed++)).error,'EXECUTION_CANCELLED');assert.equal(executed,0);
 assert.equal(policy.builtinPre({tool_name:'exec_command'}).error,'EXECUTION_CANCELLED');
});

test('unsupported MCP constraints block dispatch; repeated invalid nested arguments lead to a strategy review',async()=>{
 const {policy,signals}=fixture();let executed=0;
 policy.learn('extensions_list',{}, {connectors:[{connectorId:'strict',tools:[{name:'strict-tool',inputSchema:{type:'object',properties:{name:{type:'string'}},dependentRequired:{name:['scope']}}},{name:'known-tool',inputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value']}}]}]});
 const unsupported=await policy.execute('mcp_call',{connectorId:'strict',toolName:'strict-tool',arguments:{name:'bad'}},'unsupported',()=>executed++);
 assert.equal(unsupported.error,'TOOL_SCHEMA_UNSUPPORTED');assert.equal(executed,0);
 for(let i=0;i<3;i++)assert.equal((await policy.execute('mcp_call',{connectorId:'strict',toolName:'known-tool',arguments:{value:'wrong-'+i}},'invalid-'+i,()=>executed++)).error,'TOOL_ARGUMENT_INVALID');
 assert.equal(executed,0);assert.equal(signals.length,1);
});

test('Core hook and terminal notifications count one failed operation once and repeated failures trigger review',()=>{
 const {policy,signals}=fixture();
 for(let i=0;i<3;i++){
  const event={tool_name:'Bash',tool_use_id:'failed-'+i,tool_input:{command:'different-failing-command-'+i}};
  assert.equal(policy.builtinPre(event),null);policy.builtinPost({...event,tool_response:{exit_code:1}});
  policy.coreItemCompleted({type:'commandExecution',id:event.tool_use_id,status:'failed',exitCode:1});
  assert.equal(policy.state.stagnation,i+1);
 }
 assert.equal(signals.length,1);
});
test('bulk effect results remain in protected files, checkpoints contain bounded evidence, and final replies do not complete goals',async()=>{
 const {policy,home}=fixture();const result={jobId:'large',coordinates:Array.from({length:10000},(_,i)=>[i,i])};await policy.execute('data_download_start',{taskId:'t',planHash:'approved-hash'},'x',()=>result);
 const checkpoint=readFileSync(join(home,'execution-checkpoint.json'),'utf8');assert(checkpoint.length<10000);assert.equal(Object.values(policy.state.operations)[0].resultRef.length,69);
 assert.deepEqual(await policy.execute('data_download_start',{taskId:'t',planHash:'approved-hash'},'again',()=>assert.fail('duplicate')),result);
 policy.finish('completed');assert.equal(policy.state.goal.state,'active');assert.equal(policy.state.run.state,'completed');
 assert.equal(policy.builtinPre({tool_name:'view_image'}).error,'EXECUTION_CANCELLED');policy.begin(params,{inputModalities:['text']});assert.equal(policy.builtinPre({tool_name:'view_image'}).error,'MODEL_IMAGE_UNSUPPORTED');
 assert.equal(hash({state:'completed',readAt:1}),hash({state:'completed',readAt:2}));
});

test('real bundled Codex: schema rejection and duplicate effects stay outside the executor, checkpoint reaches the next model round',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-policy-core-'));let listener,round=0,effects=0;const requests=[];
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='model'){
   requests.push(event.request);const r=++round;
   const call=r<4?{id:'policy-call-'+r,type:'function',function:{name:'jobs_start',arguments:JSON.stringify({planId:r===1?123:'native-plan'})}}:null;
   listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:1,outputTokens:1,result:{content:call?null:'已提交一次',toolCalls:call?[call]:[]}}});
  }else if(event.type==='tool'){effects++;listener({type:'response',requestId:event.requestId,value:{result:{jobId:'native-job',state:'queued'}}});}
 }});
 try{const result=await host.turn({...params,workspace:home,history:[]});assert.equal(result.status,'completed');assert.equal(effects,1);assert.equal(round,4);assert(JSON.stringify(requests[1]).includes('TOOL_ARGUMENT_INVALID'));assert(readFileSync(join(home,'execution-decisions.jsonl'),'utf8').includes('operation-reused'));assert(JSON.stringify(requests[3]).includes('native-job'));assert(readFileSync(join(home,'execution-checkpoint.json'),'utf8').includes('native-job'));}
 finally{await host.close();}
});

test('real bundled Codex refreshes dynamic contracts on durable thread resume while preserving historical calls',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-policy-contract-')),oldFile=join(home,'old-tools.json');writeFileSync(oldFile,JSON.stringify(declared.filter(t=>t.function.name!=='mcp_result_export')));
 let listener,phase=0,round=0,threadId;const make=toolsFile=>createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile,receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='model'){
   const contract=codexRequest(event.request);if(phase===1){assert(contract.tools.some(t=>t.function.name==='mcp_result_export'),'Resume must install the new callable contract');assert(JSON.stringify(contract.messages).includes('historical-native-marker'));}
   const call=round++===0?{id:'history-call',type:'function',function:{name:'workspace_status',arguments:'{}'}}:null;
   listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:1,outputTokens:1,result:{content:call?null:'完成',toolCalls:call?[call]:[]}}});
  }else if(event.type==='tool')listener({type:'response',requestId:event.requestId,value:{result:{status:'historical-native-marker'}}});
 }});
 let host=await make(oldFile);try{threadId=(await host.turn({...params,workspace:home,history:[]})).threadId;}finally{await host.close();}
 phase=1;host=await make(resolve('src-tauri/codex-tools.json'));try{assert.equal((await host.turn({...params,workspace:home,history:[]})).threadId,threadId);}finally{await host.close();}
});

test('real bundled Codex command hooks enforce native preflight before a filesystem effect',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-policy-hook-core-'));let listener,round=0,preflights=0,hookStarts=0;const marker=join(home,'must-not-exist.txt');
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{runtimePolicyNative:true},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='policyState'){preflights++;listener({type:'response',requestId:event.requestId,value:round===0?{permission:'fullAccess',outputCrs:params.outputCrs}:{error:'ACCOUNT_CHANGED',message:'Native identity no longer matches this run'}});}
  if(event.type==='event'&&event.method==='hook/started'&&event.params.run.eventName==='preToolUse')hookStarts++;
  if(event.type==='model'){
   const first=round++===0,call=first?{id:'builtin-policy',type:'function',namespace:'functions',function:{name:'exec_command',arguments:JSON.stringify({cmd:`Set-Content -LiteralPath '${marker.replaceAll("'","''")}' -Value 'unexpected'`,yield_time_ms:1000,max_output_tokens:1000})}}:null;
   listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:1,outputTokens:1,result:{content:call?null:'调用被运行层阻止',toolCalls:call?[call]:[]}}});
  }
 }});
 try{await host.turn({...params,workspace:home,history:[]});assert(preflights>=2&&hookStarts>0,'The actual Core command must traverse the native policy hook');assert(!existsSync(marker),'The command cannot execute after a failed preflight');}
 finally{await host.close();}
});

test('completion requires every declared deliverable and a complete, hashed native artifact manifest',async()=>{
 const {policy}=fixture();policy.update({action:'amend',expectedRevision:policy.state.revision,deliverables:['j1','j2']});
 const manifest=id=>({jobId:id,quality:{status:'complete',missingTiles:0},assets:[{bytes:100,sha256:'a'.repeat(64)}]});
 await policy.execute('artifacts_inspect',{jobId:'j1'},'inspect1',()=>manifest('j1'));
 let evidenceIds=Object.values(policy.state.evidence).map(e=>e.id);
 assert.equal(policy.update({action:'complete',expectedRevision:policy.state.revision,evidenceIds}).error,'COMPLETION_EVIDENCE_REQUIRED');
 await policy.execute('artifacts_inspect',{jobId:'j2'},'inspect-partial',()=>({...manifest('j2'),quality:{status:'partial',missingTiles:1}}));
 evidenceIds=Object.values(policy.state.evidence).filter(e=>e.verified).map(e=>e.id);assert.equal(policy.update({action:'complete',expectedRevision:policy.state.revision,evidenceIds}).error,'COMPLETION_EVIDENCE_REQUIRED');
 await policy.execute('artifacts_inspect',{jobId:'j2'},'inspect2',()=>manifest('j2'));evidenceIds=Object.values(policy.state.evidence).filter(e=>e.verified).map(e=>e.id);
 assert.equal(policy.update({action:'complete',expectedRevision:policy.state.revision,evidenceIds}).goal.state,'complete');
 assert.equal((await policy.execute('artifacts_inspect',{jobId:'j2'},'redundant',()=>assert.fail('unnecessary extra verification'))).error,'TASK_ALREADY_COMPLETE');
 assert.equal(policy.builtinPre({tool_name:'Bash',tool_use_id:'unnecessary-shell',tool_input:{command:'inspect-again'}}).error,'TASK_ALREADY_COMPLETE');
});
test('user steering invalidates generated sibling calls and unresolved opaque Core effects survive restart',async()=>{
 const {policy,home}=fixture();policy.bindCall('old-call',policy.state.revision);policy.steer('只修改分辨率，不修改其他要求');let dispatched=0;
 assert.equal((await policy.execute('jobs_start',{planId:'p'},'old-call',()=>dispatched++)).error,'TASK_REVISION_CHANGED');assert.equal(dispatched,0);
 const event={tool_name:'apply_patch',tool_use_id:'patch',tool_input:{patch:'fixture opaque operation'}};assert.equal(policy.builtinPre(event),null);
 const reopened=new RuntimePolicy(home,declared);reopened.begin(params,{inputModalities:['text']});assert.equal(reopened.builtinPre(event).error,'OPERATION_RECONCILIATION_REQUIRED');
});

test('native MCP aliases share failure conditions and operation identities with their direct tools',async()=>{
 const {policy}=fixture();const schema=declared.find(t=>t.function.name==='data_download_start').function.parameters;
 await policy.execute('extensions_list',{},'discovery',()=>({connectors:[{connectorId:'builtin-data-downloads',tools:[{name:'data_download_start',inputSchema:schema}]}]}));
 let submitted=0;const args={taskId:'t',planHash:'p'};await policy.execute('data_download_start',args,'a',()=>{submitted++;return{taskId:'t',status:'queued'};});
 const same=await policy.execute('mcp_call',{connectorId:'builtin-data-downloads',toolName:'data_download_start',arguments:args},'b',()=>submitted++);
 assert.equal(submitted,1);assert.equal(same.result.taskId,'t');
});
test('independent batch items keep progressing after an uncertain submission and capability failures permit a valid alternative',async()=>{
 const {policy}=fixture();await policy.execute('jobs_start',{planId:'uncertain'},'one',()=>{throw new Error('lost acknowledgement');});let count=0;
 assert.equal((await policy.execute('jobs_start',{planId:'independent'},'two',()=>{count++;return{jobId:'independent-job',state:'queued'};})).jobId,'independent-job');assert.equal(count,1);
 const tools=['missing','valid'].map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}));
 await policy.execute('extensions_list',{},'discover',()=>({connectors:[{connectorId:'other-service',tools}]}));
 await policy.execute('mcp_call',{connectorId:'other-service',toolName:'missing',arguments:{}},'bad-capability',()=>({connectorId:'other-service',toolName:'missing',result:{error:'TOOL_NOT_FOUND'}}));
 const valid=await policy.execute('mcp_call',{connectorId:'other-service',toolName:'valid',arguments:{}},'alternative',()=>({connectorId:'other-service',toolName:'valid',result:{found:true}}));assert.equal(valid.result.found,true);
});
test('fresh native completion evidence avoids redundant inspection and partial ledger states do not pass acceptance',()=>{
 const {policy}=fixture();policy.update({action:'amend',expectedRevision:policy.state.revision,deliverables:['j']});
 policy.setFacts({permission:'fullAccess',outputCrs:params.outputCrs,imagery:{available:true,tasks:[{planId:'p',jobId:'j',state:'partial'}]}});
 assert.equal(policy.update({action:'complete',expectedRevision:policy.state.revision,evidenceIds:[]}).error,'COMPLETION_EVIDENCE_REQUIRED');
 policy.setFacts({permission:'fullAccess',outputCrs:params.outputCrs,imagery:{available:true,tasks:[{planId:'p',jobId:'j',state:'completed'}]}});
 assert.equal(policy.update({action:'complete',expectedRevision:policy.state.revision,evidenceIds:Object.values(policy.state.evidence).filter(e=>e.verified).map(e=>e.id)}).goal.state,'complete');
});

test('real bundled Core settles file operation checkpoints from hook or terminal item evidence',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-policy-patch-core-'));let listener,round=0;const workspace=join(home,'workspace');await import('node:fs').then(fs=>fs.mkdirSync(workspace));const marker=join(workspace,'fixture.txt');
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='model'){
   const call=round++===0?{id:'policy-patch',type:'function',custom:true,namespace:'functions',function:{name:'apply_patch',arguments:'{}'},input:'*** Begin Patch\n*** Add File: fixture.txt\n+actual local fixture\n*** End Patch'}:null;
   listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:1,outputTokens:1,result:{content:call?null:'完成本地文件写入',toolCalls:call?[call]:[]}}});
  }else if(event.type==='request')listener({type:'response',requestId:event.requestId,value:{decision:'accept'}});
 }});
 try{await host.turn({...params,workspace,history:[]});const journal=readFileSync(join(home,'execution-decisions.jsonl'),'utf8');assert(journal.includes('core-tool-preflight'));assert(journal.includes('core-tool-result')||journal.includes('core-item-result'));assert(Object.values(JSON.parse(readFileSync(join(home,'execution-checkpoint.json'))).operations).some(o=>o.tool==='core:apply_patch'&&o.state==='reported'));}
 finally{await host.close();}
});
