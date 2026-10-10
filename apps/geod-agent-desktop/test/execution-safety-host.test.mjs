import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
import {inputWaitDeadline} from '../src-tauri/codex-input-wait.mjs';

// Real bundled Core with a deterministic, unpaid gateway fixture.
test('a progressing task exceeds 12 requests and a review continues the same process and turn', {skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-long-task-'));let listener,models=0,tools=0,paused=false,heartbeat=false;const threads=new Set();
 const deadlines=[];
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),
  // Compress the model callback timeout so the test proves a human wait can
  // exceed it. Real execution uses 180 seconds, rather than a fixed turn limit.
  requestDeadline:(timeout,expire)=>{const d=inputWaitDeadline(timeout===180000?120:timeout,expire);deadlines.push(d);return d;},
  receive:fn=>{listener=fn;return()=>{};},emit:async event=>{
   if(event.type==='thread')threads.add(event.threadId);
   if(event.type==='heartbeat'&&paused)heartbeat=true;
   if(event.type==='model'){
    const round=++models;
    if(round===14){paused=true;listener({type:'userInputState',requestId:event.requestId,waiting:true});const pid=host.processId;
      await new Promise(r=>setTimeout(r,3500));assert.equal(models,14,'Waiting cannot create more model requests');assert.equal(host.processId,pid);assert(heartbeat,'Core host stays alive while waiting');
      paused=false;listener({type:'userInputState',requestId:event.requestId,waiting:false});
    }
    listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:10,outputTokens:5,result:round<16?{content:null,toolCalls:[{id:`call_progress_${round}`,type:'function',function:{name:'workspace_status',arguments:'{}'}}]}:{content:'长任务完成',toolCalls:[]}}});
   }
   if(event.type==='tool'){tools++;listener({type:'response',requestId:event.requestId,value:{result:{progress:tools}}});}
  }});
 try{const result=await host.turn({conversationId:'long-unpaid-fixture',workspace:home,input:'完成多步任务',history:[],permission:'fullAccess'},'long-fixture-run');assert.equal(result.status,'completed');assert.equal(result.text,'长任务完成');assert.equal(models,16);assert.equal(tools,15);assert.equal(threads.size,1);}
 finally{await host.close();for(const d of deadlines)d.close();}
});

test('human stop while a model is held exits without sending a paid request', {skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-review-stop-'));let listener,models=0;
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
   if(event.type==='model'){models++;listener({type:'userInputState',requestId:event.requestId,waiting:true});setTimeout(()=>listener({type:'interrupt'}),100);}
 }});
 try{const result=await host.turn({conversationId:'stop-unpaid-fixture',workspace:home,input:'测试停止',history:[]},'stop-fixture-run');assert.equal(result.status,'interrupted');assert.equal(models,1);}
 finally{await host.close();}
});
