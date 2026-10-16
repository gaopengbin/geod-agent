// Actual bundled Codex app-server; model transport is a deterministic local fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
const codex=process.env.GEOD_CODEX_EXE;
test('real Core acknowledges send-now by queue ID and rejects a late steer without losing it',{skip:!codex,timeout:45000},async()=>{
  const workspace=mkdtempSync(join(tmpdir(),'geod-queue-control-'));let listener,held,models=0,ack=false,lateError;
  const events=[];
  const reply=event=>listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:12,outputTokens:8,result:{content:'已收到消息。',toolCalls:[]}}});
  const host=await createHost({codex,home:join(workspace,'home'),toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
    events.push(event);
    if(event.type==='model'){
      models++;if(models===1){held=event;void listener({type:'steer',requestId:'queued-one',text:'请补充项目编号。'});}else reply(event);
    }
    if(event.type==='steered'){assert.equal(event.requestId,'queued-one');ack=true;reply(held);}
    if(event.type==='commandError'&&event.requestId==='late-queue')lateError=event;
  }});
  try{
    const result=await host.turn({conversationId:'queue-control',workspace,input:'介绍项目交付',history:[]});
    assert.equal(result.status,'completed');assert.equal(ack,true);assert.equal(events.filter(e=>e.type==='steered').length,1);
    await listener({type:'steer',requestId:'late-queue',text:'下一条消息'});
    assert.equal(lateError.code,'CODEX_TURN_NOT_ACTIVE');assert(!events.some(e=>e.type==='steered'&&e.requestId==='late-queue'));
  }finally{await host.close();}
});
test('real Core manual stop tolerates repeated clicks and a stop at completion',{skip:!codex,timeout:45000},async()=>{
  const workspace=mkdtempSync(join(tmpdir(),'geod-stop-control-'));let listener;const errors=[];
  const host=await createHost({codex,home:join(workspace,'home'),toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
    if(event.type==='commandError')errors.push(event.message);
    if(event.type==='model'){void listener({type:'interrupt'});void listener({type:'interrupt'});}
    if(event.type==='event'&&event.method==='turn/completed')void listener({type:'interrupt'});
  }});
  try{
    const result=await host.turn({conversationId:'stop-control',workspace,input:'等待停止测试',history:[]});
    assert.equal(result.status,'interrupted');await listener({type:'interrupt'});assert.deepEqual(errors,[]);
  }finally{await host.close();}
});

test('real Core steers image and document context into the same turn; old stop cannot stop a new run',{skip:!codex,timeout:45000},async()=>{
  const workspace=mkdtempSync(join(tmpdir(),'geod-attachment-steer-'));let listener,held,models=0,acks=0;const requests=[];
  const pixel='data:image/png;base64,'+readFileSync(resolve('public/geod-symbol.png')).toString('base64');
  const reply=e=>listener({type:'response',requestId:e.requestId,value:{generationId:e.generationId,state:'settled',inputTokens:12,outputTokens:8,result:{content:'附件与参数已收到。',toolCalls:[]}}});
  const host=await createHost({codex,home:join(workspace,'home'),toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:e=>{
    if(e.type==='model'){models++;requests.push(e.request);if(models===1){held=e;void listener({type:'steer',runId:'attachment-run',requestId:'files:0',text:'交付说明文档：保持 EPSG:4326。',displayText:'请结合这张图和说明文档。',images:[pixel],imageIds:['image-1'],documentIds:['document-1']});}else{void listener({type:'interrupt',runId:'stale-run'});reply(e);}}
    if(e.type==='steered'){acks++;assert.equal(e.runId,'attachment-run');assert.equal(e.text,'请结合这张图和说明文档。');assert.deepEqual(e.documentIds,['document-1']);reply(held);}
  }});
  try{const result=await host.turn({conversationId:'attachments',workspace,input:'准备交付清单',history:[]},'attachment-run');assert.equal(result.status,'completed');assert.equal(acks,1);assert.ok(models>=2);assert.ok(JSON.stringify(requests.at(-1)).includes('input_image'));assert.ok(JSON.stringify(requests.at(-1)).includes('保持 EPSG:4326'));assert.ok(result.durationMs>0);}finally{await host.close();}
});
