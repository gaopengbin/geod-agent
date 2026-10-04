import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
import {codexRequest, codexResult} from '../../../packages/codex-protocol/codex-contract.mjs';
import {TOOLS} from '../../../services/geod-agent-model-gateway/server.mjs';

const request = input => codexRequest({input, tools:TOOLS.map(({function:t})=>({type:'function',...t}))}).messages;
test('Responses history preserves instructions, environment and tool pairs',()=>{
 const result=request([
  {role:'developer',content:[{type:'input_text',text:'personal instructions'}]},
  {role:'user',content:[{type:'input_text',text:'<environment_context>machine paths</environment_context>'}]},
  {role:'user',content:[{type:'input_text',text:'查询图源'}]},
  {type:'function_call',name:'sources_list',call_id:'call-id',arguments:'{}'},
  {type:'function_call_output',call_id:'call-id',output:'{"sources":[]}'},
  {role:'assistant',content:[{type:'output_text',text:'没有图源'}]}
 ]);
 assert.equal(result.length,6);assert.equal(result[3].tool_calls[0].function.name,'sources_list');
 assert.equal(result[4].tool_call_id,'call-id');assert.equal(result[0].role,'system');assert.ok(JSON.stringify(result).includes('personal instructions'));
});
test('disabled tools remain readable as history without becoming callable',()=>{
 const result=request([{type:'function_call',namespace:'shell',name:'exec',call_id:'x',arguments:'{}'},{type:'function_call_output',call_id:'x',output:'past output'}]);
 assert.equal(result[1].content,'past output');
 assert.throws(()=>codexResult({tool_calls:[result[0].tool_calls[0]]},new Map()),/UNDECLARED_TOOL/);
});
test('parallel tool calls remain paired in one Chat Completions assistant message',()=>{
 const result=request([
  {type:'function_call',call_id:'one',name:'workspace_status',arguments:'{}'},
  {type:'function_call',call_id:'two',name:'sources_list',arguments:'{}'},
  {type:'function_call_output',call_id:'one',output:'{}'},
  {type:'function_call_output',call_id:'two',output:'{}'},
 ]);
 assert.equal(result.length,3);assert.deepEqual(result[0].tool_calls.map(c=>c.id),['one','two']);
 assert.deepEqual(result.slice(1).map(m=>m.tool_call_id),['one','two']);
});
test('desktop tool contract preserves shared gateway and conversation-scoped native definitions',()=>{
 const desktop=JSON.parse(readFileSync(new URL('../src-tauri/codex-tools.json',import.meta.url),'utf8'));
 const native=JSON.parse(readFileSync(new URL('../src-tauri/native-tools.json',import.meta.url),'utf8'));
 const definitions=new Map(desktop.map(tool=>[tool.function.name,tool]));
 const nativeNames=new Set(native.map(tool=>tool.function.name));
 assert.equal(definitions.size,desktop.length,'Duplicate callable tools are not allowed');
 assert.equal(nativeNames.size,native.length,'Native tool names must be unique');
 assert.deepEqual([...definitions.keys()].sort(),[...new Set([...TOOLS,...native].map(tool=>tool.function.name))].sort(),'No missing or undeclared callable tools');
 for(const tool of native)assert.deepEqual(definitions.get(tool.function.name),tool,'Native schema must match its actual executor');
 for(const tool of TOOLS)if(!nativeNames.has(tool.function.name))assert.deepEqual(definitions.get(tool.function.name),tool,'Shared gateway schema must be preserved');
});

const codex=process.env.GEOD_CODEX_EXE;
test('real Codex returns job tool results to the model instead of injecting a host answer',{skip:!codex,timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'geod-codex-host-'));const home=join(root,'home');
 const toolsFile=resolve('src-tauri/codex-tools.json');let listener;
 const receive=fn=>{listener=fn;return()=>{listener=null;};};
 let mode='normal';let modelCalls=0;let runModelCalls=0;const calls=[];const events=[];
 const emit=event=>{
  if(process.env.GEOD_CODEX_TEST_TRACE)console.log(JSON.stringify({type:event.type,method:event.method,stage:event.stage,tool:event.tool,requestId:event.requestId}));
  events.push(event);
  if(event.type==='model'){
   const contract=codexRequest(event.request);assert.ok(contract.messages.some(m=>m.role==='system'),'Real Codex instructions reach the gateway contract');assert.ok(contract.tools.length>27,'Native Codex tools are preserved');
   modelCalls++;
   runModelCalls++;
   listener({type:'delta',requestId:event.requestId,part:'reasoning',text:''});
   if(mode==='interrupt'){listener({type:'interrupt'});return;}
   const tool=mode==='handoff'&&runModelCalls===1?'jobs_start':mode==='normal'&&modelCalls===1?'workspace_status':null;
   const generation={generationId:event.generationId,state:'settled',inputTokens:123,outputTokens:20,result:{content:tool?null:'真实引擎调用完成',toolCalls:tool?[{id:'call_fixture_123',type:'function',function:{name:tool,arguments:tool==='jobs_start'?'{"planId":"test-plan"}':'{}'}}]:[]}};
   listener({type:'response',requestId:event.requestId,value:generation});
  }else if(event.type==='tool'){
   calls.push(event.tool);
   listener({type:'response',requestId:event.requestId,value:mode==='handoff'?{result:{jobId:'fixture-job',state:'queued'},finishText:'FAKE_HOST_ANSWER'}:{result:{permission:'fullAccess'}}});
  }
 };
 const params={conversationId:'isolated-host-conversation',workspace:root,input:'测试',history:[]};
 const host=await createHost({codex,home,toolsFile,emit,receive});
 try {
 const first=await host.turn(params);const pid=host.processId;
 assert.equal(first.status,'completed');assert.equal(first.text,'真实引擎调用完成');assert.deepEqual(calls,['workspace_status']);
 assert.ok(events.some(e=>e.type==='event'&&e.method==='thread/tokenUsage/updated'));
 assert.ok(events.some(e=>e.type==='event'&&e.method==='item/agentMessage/delta'),'The real engine emits streaming text');
 assert.ok(!events.some(e=>e.type==='event'&&e.params?.item?.type==='reasoning'),'Empty upstream reasoning chunks cannot invent an unfinished thinking item');
 mode='handoff';runModelCalls=0;const before=modelCalls;
 const second=await host.turn({...params,permission:'fullAccess'});assert.equal(host.processId,pid,'Consecutive turns reuse the engine process');
 assert.equal(second.threadId,first.threadId);assert.equal(second.status,'completed');assert.equal(second.text,'真实引擎调用完成');
 assert.equal(modelCalls-before,2,'The model receives the job result and produces its own final answer');
 assert.ok(!second.text.includes('FAKE_HOST_ANSWER'));
 mode='interrupt';const stopped=await host.turn({...params,permission:'confirmEach'});
 assert.equal(stopped.status,'interrupted');assert.equal(stopped.threadId,first.threadId);
 const sessions=join(home,'sessions');const rollout=readdirSync(sessions,{recursive:true}).find(name=>String(name).endsWith('.jsonl'));
 const contexts=readFileSync(join(sessions,rollout),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.type==='turn_context').map(item=>item.payload);
 assert.deepEqual(contexts.map(item=>item.sandbox_policy.type),['read-only','workspace-write','read-only'],'Switching permission changes the actual reused thread for every turn');
 assert.deepEqual(contexts.map(item=>item.approval_policy),['on-request','never','on-request']);
 console.log(JSON.stringify({engine:'Codex 0.159.2',model:'fixture',threadId:first.threadId,modelCalls,calls,profile:home}));
 } finally { await host.close(); }
});

test('namespaced custom tools and reasoning are preserved in both directions',()=>{
 const tools=[{type:'namespace',name:'functions',tools:[{type:'custom',name:'apply_patch',description:'Apply a patch',format:{type:'text'}}]}];
 const adapted=codexRequest({instructions:'Keep the real base prompt.',tools,input:[{role:'user',content:'Edit the file.'}]});
 const name=adapted.tools[0].function.name;
 const result=codexResult({reasoning_content:'Inspect the file first.',tool_calls:[{id:'p1',type:'function',function:{name,arguments:JSON.stringify({input:'*** Begin Patch\n*** End Patch'})}}]},adapted.definitions);
 assert.equal(result.toolCalls[0].namespace,'functions');assert.equal(result.toolCalls[0].input,'*** Begin Patch\n*** End Patch');assert.equal(result.reasoning,'Inspect the file first.');
 const continued=codexRequest({tools,input:[{type:'custom_tool_call',call_id:'p1',namespace:'functions',name:'apply_patch',input:'patch'},{type:'custom_tool_call_output',call_id:'p1',output:'done'}]});
 assert.equal(continued.messages[0].tool_calls[0].function.name,name);assert.equal(continued.messages[1].content,'done');
 assert.throws(()=>codexRequest({tools:[],input:[{role:'user',content:[{type:'input_image',image_url:'data:'}]}]}),/IMAGE_INVALID/);
 assert.throws(()=>codexResult({tool_calls:[{id:'x',function:{name:'invented',arguments:'{}'}}]},adapted.definitions),/UNDECLARED_TOOL/);
});
