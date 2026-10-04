import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHost,sendGeneration} from '../src-tauri/codex-host.mjs';

test('actual Core treats explicit sponsor budget and changed-route rejection as terminal',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
  for(const code of ['SPONSOR_QUOTA_EXCEEDED','SPONSOR_CHANGED']){
    const home=mkdtempSync(join(tmpdir(),'geod-sponsor-error-'));let listener,models=0;
    const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{model:'deepseek-flash',contextWindow:128000,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
      if(event.type==='model'){models++;listener({type:'response',requestId:event.requestId,error:'Explicit sponsor route rejection',errorCode:code});}
    }});
    try{const result=await host.turn({conversationId:'sponsor-error-'+code,workspace:home,permission:'fullAccess',input:'Respond briefly.',history:[]},'sponsor-error-run');assert.equal(result.status,'failed');assert.equal(models,1,'Explicit configuration or budget rejection must not retry');}finally{await host.close();}
  }
});

test('missing supplier usage is not replaced with zero usage',()=>{
  const chunks=[];sendGeneration({write:chunk=>chunks.push(chunk),end(){}},{state:'settled',inputTokens:null,outputTokens:null,result:{content:'回答',toolCalls:[]}},'unknown');
  const completed=chunks.join('').split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(v=>v.type==='response.completed');assert.equal(completed.response.usage,null);
});
test('native Responses completion waits for durable native settlement',{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
  const home=mkdtempSync(join(tmpdir(),'geod-wire-settlement-'));let listener,models=0;const settled=new Set();
  const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{protocol:'responses',model:'deepseek-flash',contextWindow:128000,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:async event=>{
    if(event.type==='model'){
      const round=++models,id=`native_${round}`,call='call_native_settlement';
      const output=round===1?[{type:'function_call',id:'fc_native',status:'completed',call_id:call,name:'workspace_status',arguments:'{}'}]:[{type:'message',id:'msg_native',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'完成',annotations:[]}]}];
      listener({type:'wire',requestId:event.requestId,event:'response.created',value:{type:'response.created',response:{id,object:'response',status:'in_progress',output:[]}}});
      for(const item of output){listener({type:'wire',requestId:event.requestId,event:'response.output_item.added',value:{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress'}}});if(item.type==='message')listener({type:'wire',requestId:event.requestId,event:'response.output_text.delta',value:{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'完成'}});listener({type:'wire',requestId:event.requestId,event:'response.output_item.done',value:{type:'response.output_item.done',output_index:0,item}});}
      listener({type:'wire',requestId:event.requestId,event:'response.completed',value:{type:'response.completed',response:{id,object:'response',status:'completed',output,usage:{input_tokens:20,output_tokens:4,total_tokens:24,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}});
      await new Promise(r=>setTimeout(r,200));settled.add(round);
      listener({type:'response',requestId:event.requestId,value:{state:'settled',generationId:event.generationId,result:{content:round===1?null:'完成',toolCalls:[]}}});
    }
    if(event.type==='tool'){assert(settled.has(1),'Tool execution cannot precede durable generation settlement');listener({type:'response',requestId:event.requestId,value:{result:{permission:'fullAccess'}}});}
  }});
  try{const result=await host.turn({conversationId:'native-wire-proof',workspace:home,permission:'fullAccess',input:'检查工作区然后回答。',history:[]},'native-wire-run');assert.equal(result.status,'completed');assert.equal(result.text,'完成');assert.equal(models,2);assert(settled.has(2),'Turn completion cannot precede final generation settlement');}finally{await host.close();}
});
