import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
import {PRODUCT_IDENTITY} from '../src-tauri/model-input-context.mjs';
const codex=process.env.GEOD_CODEX_EXE;
test('real Core: greeting has no tools; lazy discovery enables exact task schemas; resumes history without lost capability',{skip:!codex,timeout:90000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-input-core-'));let listener,mode='greeting',models=0,externalTools=0;
 const observed=[],seenSchemas=[];
 const host=await createHost({codex,home,toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='model'){
   models++;observed.push({mode,request:event.request});
   const names=event.request.tools.flatMap(tool=>tool.type==='namespace'?tool.tools.map(member=>member.name):[tool.name]);seenSchemas.push(names);
   const round=observed.filter(row=>row.mode===mode).length;
   if(mode==='greeting'){
    assert(JSON.stringify(event.request.input).includes(PRODUCT_IDENTITY),'supplier receives the geographic product identity');
    assert.equal(names.length,0);listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:100,outputTokens:5,result:{content:'你好！',toolCalls:[]}}});
   }else if(mode==='rules'){
    if(round===2)assert(JSON.stringify(event.request.input).includes('For every data export'),'the exact export rule is recovered through the real Core tool loop');
    listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:100,outputTokens:5,result:{content:round===1?null:'已读取完整规则',toolCalls:round===1?[{id:'rules-fixture',type:'function',function:{name:'runtime_context_read',arguments:'{"section":"rules","query":"export_requirements"}'}}]:[]}}});
   }else{
    const tool=round===1?'runtime_tools_search':round===2?'cache_inventory':null;
    if(round===1)assert(!names.includes('cache_inventory'));
    if(round===2)assert(names.includes('cache_inventory'));
    listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:100,outputTokens:5,result:{content:tool?null:'任务已完成',toolCalls:tool?[{id:'fixture-'+round,type:'function',function:{name:tool,arguments:tool==='runtime_tools_search'?'{"names":["cache_inventory"]}':'{}'}}]:[]}}});
   }
  }
  if(event.type==='tool'){externalTools++;assert.equal(event.tool,'cache_inventory');listener({type:'response',requestId:event.requestId,value:{result:{entries:[],verified:true}}});}
 }});
 try{
  const greeting=await host.turn({conversationId:'context-fixture',workspace:home,input:'你好，请简短回复，不调用工具。',history:[],permission:'confirmEach'},'greeting-fixture');
  assert.equal(greeting.text,'你好！');assert.equal(models,1);assert.equal(externalTools,0);
  mode='task';const task=await host.turn({conversationId:'context-fixture',workspace:home,input:'请完成这项操作',history:[],permission:'confirmEach'},'task-fixture');
  assert.equal(task.status,'completed');assert.equal(task.threadId,greeting.threadId);assert.equal(models,4);assert.equal(externalTools,1);
  const last=observed.at(-1).request;
  assert(JSON.stringify(last.input).includes('你好！'),'normal work sees preserved Core history');
  assert(JSON.stringify(last.input).includes('Clarify missing consequential requirements'),'common clarification and native authority remain live');
  assert(!JSON.stringify(last.input).includes('For every data export'),'an unrelated cache read does not eagerly load the export rule');
  assert(JSON.stringify(last.input).includes(PRODUCT_IDENTITY),'normal work keeps the same product identity');
  assert(last.input.some(item=>item.type==='function_call_output'&&String(item.output).includes('schemaActivated')));
  mode='rules';const rules=await host.turn({conversationId:'context-fixture',workspace:home,input:'请读取导出方面的完整产品规则',history:[],permission:'confirmEach'},'rules-fixture');assert.equal(rules.status,'completed');assert.equal(rules.threadId,task.threadId);assert.equal(models,6);
  const audit=readFileSync(join(home,'model-input-audit.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit[0].sentToolCount,0);assert(audit[0].sentBytes<audit[0].originalBytes*.2);
  assert.equal(audit.length,6);assert(audit.slice(1).every(row=>row.profile==='task'));
  const output=resolve('../../artifacts/input-optimization-20261010');mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'core-acceptance.json'),JSON.stringify({passed:true,realCodex:true,modelCalls:0,fixtureRequests:models,externalReadTools:externalTools,threadPreserved:task.threadId===greeting.threadId,audit},null,2));
 }finally{await host.close();}
});
