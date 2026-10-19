import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeWorkflow} from '../src-tauri/runtime-workflow.mjs';
import {RuntimePolicy,RUNTIME_TOOLS} from '../src-tauri/runtime-policy.mjs';
import {ModelToolCatalog} from '../src-tauri/model-input-context.mjs';
const root=()=>mkdtempSync(join(tmpdir(),'geod-workflow-'));
const condition={kind:'result',pointer:'/ok',equals:true};

test('MCP acceptance exposes normalized paths, rejects empty conditions and repairs without another call',async()=>{
 const w=fixture();
 assert.equal(w.plan({title:'invalid',expectedRevision:0,steps:[step('info',[],{acceptance:[{kind:'result',pointer:'/data/crs'}]})]}).error,'WORKFLOW_RESULT_CONDITION_REQUIRED');
 w.plan({title:'MCP',expectedRevision:0,steps:[step('info',[],{acceptance:[{kind:'result',pointer:'/structuredContent/data/crs',equals:'EPSG:4326'}]})]});let calls=0;
 const dispatch=async()=>{calls++;return{connectorId:'gis',toolName:'raster_info',result:{content:[{type:'text',text:JSON.stringify({data:{crs:'EPSG:4326'}})}],structuredContent:{data:{crs:'EPSG:4326'}}}};};
 const failed=await w.run('info',dispatch);assert.equal(failed.error,'WORKFLOW_ACCEPTANCE_FAILED');
 assert.deepEqual(w.view().steps[0].checks[0].resultRootKeys,['data']);assert.equal(w.view().steps[0].checks[0].pointer,'/structuredContent/data/crs');
 assert.deepEqual(w.acceptanceResult(w.step('info')),{data:{crs:'EPSG:4326'}});
 w.repair({stepId:'info',expectedRevision:1,acceptance:[{kind:'result',pointer:'/data/crs',equals:'EPSG:4326'}]});
 assert((await w.run('info',dispatch)).reconciled);assert.equal(calls,1);
});
const step=(id,dependsOn=[],extra={})=>({id,title:id,dependsOn,tool:'operation',arguments:{id},acceptance:[condition],...extra});
function fixture(home=root(),verify=async c=>({...c,verified:true,sha256:'a'.repeat(64)})){
 const runtime=new RuntimeWorkflow(home,{verify,knownTool:()=>true,nativeEvidence:()=>true,descriptor:()=>({effect:'external'})});runtime.bind({conversationId:'qa',workspace:'workspace'});return runtime;
}
test('dependency graph rejects cycles, missing nodes, stale edits and recursive workflow calls',()=>{
 const w=fixture();assert.equal(w.plan({title:'invalid',expectedRevision:0,steps:[step('a',['b']),step('b',['a'])]}).error,'WORKFLOW_GRAPH_INVALID');
 assert.equal(w.plan({title:'invalid',expectedRevision:0,steps:[step('a',['missing'])]}).error,'WORKFLOW_GRAPH_INVALID');
 assert.equal(w.plan({title:'invalid',expectedRevision:0,steps:[step('a',[],{tool:'runtime_workflow_run'})]}).error,'WORKFLOW_TOOL_UNAVAILABLE');
 assert(w.plan({title:'valid',expectedRevision:0,steps:[step('a')]}).workflowId);
 assert.equal(w.plan({title:'stale',expectedRevision:0,steps:[step('a')]}).error,'WORKFLOW_REVISION_CONFLICT');
});

test('direct and MCP database selection contracts expose the same typed filters',()=>{
 const shared=JSON.parse(readFileSync(new URL('../../../packages/codex-protocol/data-selection-tools.json',import.meta.url),'utf8'));
 const declared=JSON.parse(readFileSync(new URL('../src-tauri/codex-tools.json',import.meta.url),'utf8'));
 for(const t of shared){const direct=declared.find(d=>d.function.name===t.name).function;assert.deepEqual(direct.parameters,t.inputSchema);assert(direct.parameters.properties.filters);}
});

test('durable Core tool names keep current schemas and can repair through the original plan entry',async()=>{
 const catalog=new ModelToolCatalog(RUNTIME_TOOLS,{input:'继续 COG 交付'}),declared=RUNTIME_TOOLS.find(t=>t.function.name==='runtime_workflow_plan').function;
 const [wire]=catalog.project([{type:'function',name:declared.name,description:'old',parameters:{type:'object',properties:{old:{type:'string'}}}}],[]);
 assert.deepEqual(wire.parameters,declared.parameters);assert(wire.parameters.properties.repair);
 const w=fixture();w.plan({title:'repair',expectedRevision:0,steps:[step('read',[],{acceptance:[{kind:'result',pointer:'/missing',equals:true}]})]});let calls=0;
 await w.run('read',async()=>{calls++;return{ok:true};});w.plan({expectedRevision:1,repair:{stepId:'read',acceptance:[condition]}});
 assert((await w.run('read',()=>calls++)).reconciled);assert.equal(calls,1);
});

test('append and stable MCP routing preserve completed work and the completion gate',async()=>{
 const tools=[...RUNTIME_TOOLS,...['mcp_call','worker_file_write'].map(name=>({type:'function',function:{name,parameters:{type:'object',additionalProperties:true}}}))],p=new RuntimePolicy(root(),tools,{verifyArtifact:async c=>({...c,verified:true})});p.begin({conversationId:'qa',workspace:'workspace',input:'delivery',permission:'fullAccess'});
 const call=(toolName,args)=>p.execute('mcp_call',{connectorId:'builtin-runtime-workflow',toolName,arguments:args},toolName+Math.random(),()=>{throw Error('Workflow control must not dispatch externally');});
 assert((await call('runtime_workflow_plan',{title:'delivery',expectedRevision:0,steps:[step('a',[],{tool:'worker_file_write'})]})).workflowId);
 let writes=0;await p.execute('runtime_workflow_run',{stepId:'a'},'first',async()=>{writes++;return{ok:true};});
 await call('runtime_workflow_plan',{expectedRevision:1,append:[step('b',['a'],{tool:'worker_file_write'})]});assert.equal(p.workflow.step('a').state,'completed');
 assert.equal(p.update({expectedRevision:p.state.revision,action:'complete'}).error,'WORKFLOW_ACCEPTANCE_REQUIRED');
 await p.execute('runtime_workflow_run',{stepId:'a'},'reuse',()=>writes++);assert.equal(writes,1);
 assert.equal((await call('runtime_workflow_plan',{expectedRevision:2,append:[step('recursive',[],{tool:'mcp_call',arguments:{connectorId:'builtin-runtime-workflow',toolName:'runtime_workflow_run',arguments:{stepId:'a'}}})]})).error,'WORKFLOW_TOOL_UNAVAILABLE');
 p.cancel();assert.equal((await call('runtime_workflow_state',{})).error,'EXECUTION_CANCELLED');
});

test('JSON property order cannot invalidate completed dependencies during append or amendment',async()=>{
 const w=fixture(),ordered=Object.fromEntries(Object.entries(step('read',[],{arguments:{b:2,a:{y:2,x:1}}})).reverse());w.plan({title:'order',expectedRevision:0,steps:[ordered]});let calls=0;
 await w.run('read',async()=>{calls++;return{ok:true};});
 w.plan({expectedRevision:1,append:[step('convert',['read'])]});assert.equal(w.step('read').state,'completed');assert(w.step('read').receipt);
 const reordered=step('read',[],{arguments:{a:{x:1,y:2},b:2}});w.plan({title:'order',expectedRevision:2,steps:[reordered,step('convert',['read'])]});
 assert((await w.run('read',()=>calls++)).reused);assert.equal(calls,1);
});

test('an MCP JSON error cannot satisfy a step acceptance condition',async()=>{
 const w=fixture();w.plan({title:'error',expectedRevision:0,steps:[step('a')]});
 const result=await w.run('a',async()=>({connectorId:'native',toolName:'operation',result:{content:[{type:'text',text:JSON.stringify({error:'NATIVE_FAILURE',ok:true})}]}}));
 assert.equal(result.state,'failed');assert.equal(w.step('a').receipt,undefined);
});
test('failed conversion resumes after restart without another database read or download dispatch',async()=>{
 const home=root(),w=fixture(home),calls=[];
 w.plan({title:'database to COG',expectedRevision:0,steps:[step('database'),step('download',['database']),step('cog',['download'])]});
 const dispatch=async(_tool,args)=>{calls.push(args.id);return args.id==='cog'?{error:'CONVERSION_INTERRUPTED'}:{ok:true};};
 assert.equal((await w.run('cog',dispatch)).error,'WORKFLOW_DEPENDENCY_REQUIRED');
 await w.run('database',dispatch);await w.run('download',dispatch);assert.equal((await w.run('cog',dispatch)).state,'failed');
 const restored=fixture(home);const reused=await restored.run('download',dispatch);assert(reused.reused);
 await restored.run('cog',async()=>{calls.push('cog-resumed');return{ok:true};});assert(restored.view().complete);
 assert.deepEqual(calls,['database','download','cog','cog-resumed']);
});
test('unknown side effects cannot be repeated without a native receipt; interrupted verification uses saved output',async()=>{
 const home=root(),w=fixture(home);w.plan({title:'unknown',expectedRevision:0,steps:[step('a')]});
 w.step('a').state='running';w.save();const restored=fixture(home);let calls=0;
 assert.equal((await restored.run('a',()=>{calls++;return{ok:true};})).error,'WORKFLOW_RECONCILIATION_REQUIRED');assert.equal(calls,0);
 restored.step('a').receipt=restored.writeResult(restored.step('a'),{ok:true});restored.save();
 assert((await restored.run('a',()=>calls++)).reconciled);assert.equal(calls,0);
});
test('native postconditions reject wrong CRS/layout, preserve successful inputs and detect changed output',async()=>{
 let valid=false,sha='a'.repeat(64);const w=fixture(root(),async c=>({kind:c.kind,path:c.path,verified:valid,sha256:sha,failedChecks:valid?[]:['layout']}));
 w.plan({title:'verify',expectedRevision:0,steps:[step('download'),step('cog',['download'],{arguments:{output:'result.tif'},acceptance:[{kind:'raster',path:'result.tif',crs:'EPSG:4326',layout:'COG'}]})]});
 await w.run('download',async()=>({ok:true}));let conversions=0;const convert=async()=>{conversions++;return{output:'result.tif'};};
 assert.equal((await w.run('cog',convert)).error,'WORKFLOW_ACCEPTANCE_FAILED');assert.equal(w.step('download').state,'completed');
 valid=true;assert((await w.run('cog',convert)).reconciled);assert.equal(conversions,1);
 sha='b'.repeat(64);assert.equal((await w.run('cog',convert)).error,'WORKFLOW_ARTIFACT_CHANGED');assert.equal(conversions,1);
});
test('changing a step invalidates only that step and its dependants',async()=>{
 const w=fixture();const steps=[step('db'),step('source'),step('download',['db','source']),step('cog',['download'])];w.plan({title:'delivery',expectedRevision:0,steps});
 for(const s of steps)await w.run(s.id,async()=>({ok:true}));
 const changed=steps.map(s=>s.id==='source'?{...s,arguments:{provider:'new'}}:s);w.plan({title:'delivery',expectedRevision:1,steps:changed});
 assert.equal(w.step('db').state,'completed');for(const id of ['source','download','cog'])assert.equal(w.step(id).state,'pending');
});
test('amending acceptance rechecks the existing operation instead of overwriting its output',async()=>{
 const w=fixture();const s=step('convert',[],{arguments:{output:'cog.tif'},acceptance:[{kind:'file',path:'cog.tif'}]});w.plan({title:'cog',expectedRevision:0,steps:[s]});let writes=0;
 await w.run('convert',async()=>{writes++;return{output:'cog.tif'};});
 w.plan({title:'cog',expectedRevision:1,steps:[{...s,acceptance:[{kind:'raster',path:'cog.tif',layout:'COG'}]}]});
 assert((await w.run('convert',()=>writes++)).reconciled);assert.equal(writes,1);
});

test('local repair keeps unrelated nodes and fixes a missing receipt pointer without executing again',async()=>{
 const w=fixture();w.plan({title:'delivery',expectedRevision:0,steps:[step('read',[],{acceptance:[{kind:'result',pointer:'/count',equals:1}]}),step('other')]});let reads=0;
 const dispatch=async()=>{reads++;return{boundary:{count:1}};};
 const failed=await w.run('read',dispatch);assert.equal(failed.error,'WORKFLOW_ACCEPTANCE_FAILED');assert.equal(failed.checks[0].error,'WORKFLOW_ACCEPTANCE_FIELD_UNAVAILABLE');
 assert.equal(w.repair({stepId:'read',expectedRevision:0,acceptance:[{kind:'result',pointer:'/boundary/count',equals:1}]}).error,'WORKFLOW_REVISION_CONFLICT');
 w.repair({stepId:'read',expectedRevision:1,acceptance:[{kind:'result',pointer:'/boundary/count',equals:1}]});assert.equal(w.step('other').state,'pending');
 assert((await w.run('read',dispatch)).reconciled);assert.equal(reads,1);
});
test('dependency receipt pointers carry exact parameters and refuse non-dependency references',async()=>{
 const w=fixture();w.plan({title:'refs',expectedRevision:0,steps:[step('db'),step('download',['db'],{arguments:{boundaryId:{$step:'db',pointer:'/boundaryId'}}})]});
 await w.run('db',async()=>({ok:true,boundaryId:'native-boundary'}));let value;await w.run('download',async(_,args)=>{value=args.boundaryId;return{ok:true};});assert.equal(value,'native-boundary');
});
test('a write cannot verify an unrelated file and scope cannot migrate to another conversation or workspace',async()=>{
 const w=fixture();w.plan({title:'mismatch',expectedRevision:0,steps:[step('a',[],{arguments:{output:'actual.tif'},acceptance:[{kind:'file',path:'unrelated.tif'}]})]});
 assert.equal((await w.run('a',async()=>({output:'actual.tif'}))).checks[0].error,'WORKFLOW_OUTPUT_MISMATCH');
 assert.throws(()=>w.bind({conversationId:'other',workspace:'workspace'}),/SCOPE/);
});
test('mutations exclude conflicting execution',async()=>{
 const w=fixture();w.plan({title:'serial',expectedRevision:0,steps:[step('a'),step('b')]});let release;
 const pending=w.run('a',()=>new Promise(r=>release=()=>r({ok:true})));await new Promise(r=>setImmediate(r));
 assert.equal((await w.run('b',async()=>({ok:true}))).error,'WORKFLOW_RESOURCE_BUSY');release();await pending;
});

test('a restarted unknown download reconciles the native ledger without resubmitting',async()=>{
 const home=root(),tools=[...RUNTIME_TOOLS,...['jobs_start','jobs_get'].map(name=>({type:'function',function:{name,parameters:{type:'object',additionalProperties:true}}}))];
 const asset={bytes:100,sha256:'a'.repeat(64)},native={jobId:'job-1',state:'completed',verified:true,artifact:{assets:[asset]}};
 const options={verifyArtifact:async()=>native},params={conversationId:'qa',workspace:'workspace',input:'delivery',permission:'fullAccess'};
 const p=new RuntimePolicy(home,tools,options);p.begin(params);
 await p.execute('runtime_workflow_plan',{title:'download',expectedRevision:0,steps:[step('download',[],{tool:'jobs_start',arguments:{planId:'plan-1'},acceptance:[{kind:'native'}]})]},'plan',()=>{});
 let submissions=0;
 await p.execute('runtime_workflow_run',{stepId:'download'},'first',async()=>{submissions++;throw new Error('Lost start response');});
 const q=new RuntimePolicy(home,tools,options);q.begin(params);
 assert.equal((await q.execute('runtime_workflow_run',{stepId:'download'},'before-status',()=>{submissions++;})).error,'WORKFLOW_RECONCILIATION_REQUIRED');
 q.setFacts({permission:'fullAccess',imagery:{tasks:[{jobId:'job-1',planId:'plan-1',state:'completed'}]}});
 const resumed=await q.execute('runtime_workflow_run',{stepId:'download'},'resume',()=>{submissions++;});
 assert(resumed.reconciled);assert.equal(resumed.state,'completed');assert.equal(submissions,1);
});
test('more than twelve progressing steps finish without a fixed iteration stop',async()=>{
 const w=fixture(),steps=Array.from({length:17},(_,i)=>step('step'+i,i?['step'+(i-1)]:[]));w.plan({title:'long',expectedRevision:0,steps});
 for(const s of steps)assert.equal((await w.run(s.id,async()=>({ok:true}))).state,'completed');assert(w.view().complete);
});
test('policy binds direct matching calls to workflow receipts and native permissions still gate recovery',async()=>{
 const home=root(),tools=[...RUNTIME_TOOLS,{type:'function',function:{name:'worker_file_write',parameters:{type:'object',additionalProperties:true}}}];
 const p=new RuntimePolicy(home,tools,{verifyArtifact:async c=>({...c,verified:true,sha256:'a'.repeat(64)})});
 const params={conversationId:'qa',workspace:'workspace',input:'delivery',permission:'fullAccess'};p.begin(params);
 await p.execute('runtime_workflow_plan',{title:'delivery',expectedRevision:0,steps:[step('write',[],{tool:'worker_file_write',arguments:{output:'out.json'},acceptance:[{kind:'file',path:'out.json'}]})]},'plan',()=>{});
 let effects=0;const dispatch=async()=>{effects++;return{output:'out.json'};};
 await p.execute('worker_file_write',{output:'out.json'},'first',dispatch);await p.execute('worker_file_write',{output:'out.json'},'second',dispatch);assert.equal(effects,1);
 const q=new RuntimePolicy(home,tools,{verifyArtifact:async c=>({...c,verified:true,sha256:'a'.repeat(64)})});q.begin(params);await q.execute('runtime_workflow_run',{stepId:'write'},'resume',dispatch);assert.equal(effects,1);
 q.cancel();assert.equal((await q.execute('runtime_workflow_run',{stepId:'write'},'stopped',dispatch)).error,'EXECUTION_CANCELLED');
});
