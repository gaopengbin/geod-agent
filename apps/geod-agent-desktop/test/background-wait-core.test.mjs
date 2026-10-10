import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
const codex=process.env.GEOD_CODEX_EXE;
const params={conversationId:'native-wait-core',input:'下载确认的影像，EPSG:4326，保留其他要求',workspace:null,history:[],permission:'fullAccess',outputCrs:'EPSG:4326'};
const proof=id=>({jobId:id,state:'completed',verified:true,artifact:{quality:{status:'complete',missingTiles:0},assets:[{id:'raster',bytes:100,sha256:'a'.repeat(64),crs:'EPSG:4326'}]}});
function response(listener,event,result){listener({type:'response',requestId:event.requestId,value:result});}
function model(listener,event,call,content){response(listener,event,{generationId:event.generationId,state:'settled',inputTokens:10,outputTokens:5,result:{content:call?null:content,toolCalls:call?[{id:'native-start',type:'function',function:{name:call,arguments:'{"planId":"owned-plan"}'}}]:[]}});}

test('bundled Core waits below the model, keeps heartbeats, and registers verified completion without polling/bookkeeping',{skip:!codex,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-native-wait-'));let listener,models=0,submissions=0,waits=0,heartbeats=0,waitModelCount;
 const host=await createHost({codex,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{runtimePolicyNative:true,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='policyState')response(listener,event,{permission:'fullAccess',outputCrs:'EPSG:4326',imagery:{available:true,tasks:[]}});
  if(event.type==='heartbeat')heartbeats++;
  if(event.type==='model'){
   models++;
   if(models===1)model(listener,event,'jobs_start');
   else{assert.equal(models,2);const outputs=event.request.input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output)),wire=JSON.stringify(event.request.input);assert(outputs.some(output=>JSON.stringify(output).includes('"verified":true')),JSON.stringify(outputs));assert(wire.includes('submitted-native-resources'));model(listener,event,null,'下载和核验完成，EPSG:4326。');}
  }
  if(event.type==='tool'){assert.equal(event.tool,'jobs_start');submissions++;response(listener,event,{result:{jobId:'native-job',state:'queued'}});}
  if(event.type==='backgroundWait'){
   waits++;waitModelCount=models;
   setTimeout(()=>{assert.equal(models,waitModelCount,'no model generation during native wait');response(listener,event,proof('native-job'));},3400);
  }
 }});
 try{const result=await host.turn({...params,workspace:home});assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(models,2);assert.equal(submissions,1);assert.equal(waits,1);assert(heartbeats>0);const state=JSON.parse(readFileSync(join(home,'execution-checkpoint.json')));assert.equal(state.run.completionRegistration.complete,true);assert.deepEqual(state.run.resourceIds,['native-job']);assert.equal(state.nativeResources['native-job'].verified,true);assert(!readFileSync(join(home,'execution-decisions.jsonl'),'utf8').includes('goal-update'));}
 finally{await host.close();}
});

test('bundled Core stop detaches native waiting without cancelling or submitting the download twice',{skip:!codex,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-native-stop-'));let listener,submissions=0,waits=0,cancellations=0;
 const host=await createHost({codex,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{runtimePolicyNative:true,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='policyState')response(listener,event,{permission:'fullAccess',outputCrs:'EPSG:4326'});
  if(event.type==='model')model(listener,event,'jobs_start');
  if(event.type==='tool'){assert.equal(event.tool,'jobs_start');submissions++;response(listener,event,{result:{jobId:'running-job',state:'queued'}});}
  if(event.type==='backgroundWait'){waits++;setTimeout(()=>listener({type:'interrupt'}),50);}
  if(event.type==='backgroundWaitCancel')cancellations++;
 }});
 try{const result=await host.turn({...params,workspace:home});assert.equal(result.status,'interrupted');assert.equal(submissions,1);assert.equal(waits,1);assert.equal(cancellations,1);const state=JSON.parse(readFileSync(join(home,'execution-checkpoint.json')));assert.notEqual(state.nativeResources['running-job']?.verified,true);}
 finally{await host.close();}
});

test('native approval failure never starts a wait or creates completion evidence',{skip:!codex,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-native-approval-'));let listener,models=0,waits=0;
 const host=await createHost({codex,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{runtimePolicyNative:true,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='policyState')response(listener,event,{permission:'confirmEach',outputCrs:'EPSG:4326'});
  if(event.type==='model')model(listener,event,++models===1?'jobs_start':null,'需要在任务面板确认。');
  if(event.type==='tool')response(listener,event,{result:{error:'APPROVAL_REQUIRED'}});
  if(event.type==='backgroundWait')waits++;
 }});
 try{await host.turn({...params,workspace:home,permission:'confirmEach'});assert.equal(waits,0);const state=JSON.parse(readFileSync(join(home,'execution-checkpoint.json')));assert.deepEqual(state.nativeResources,{});}
 finally{await host.close();}
});
