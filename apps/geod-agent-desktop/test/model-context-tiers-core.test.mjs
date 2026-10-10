import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
const codex=process.env.GEOD_CODEX_EXE;
test('real Core host recreation restores exact offloaded history through paged context reads while retaining confirmed task text',{skip:!codex,timeout:60000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-context-tiers-core-'));let listener,mode='seed',requests=0,host,archiveId,pageOffset=0,recovered='',firstThread,seedRecord;
 const raw={sources:[{id:'confirmed-source',detail:'EXACT_RECOVERY_SENTINEL '+('source field 中文 '.repeat(3500))}]};
 const observed=[];
 const start=()=>createHost({codex,home,toolsFile:resolve('src-tauri/codex-tools.json'),receive:fn=>{listener=fn;return()=>{};},emit:e=>{
  if(e.type==='tool'){assert.equal(e.tool,'sources_list');listener({type:'response',requestId:e.requestId,value:{result:raw}});}
  if(e.type!=='model')return;
  requests++;observed.push({mode,requestBytes:Buffer.byteLength(JSON.stringify(e.request))});let tool,args={},content;
  if(mode==='seed'){
   seedRecord=e.request.input.find(item=>item.type==='function_call_output'&&String(item.output).includes('EXACT_RECOVERY_SENTINEL'))??seedRecord;tool=seedRecord?null:'sources_list';content=tool?null:'图源记录已读取，保留用户已确定的 Z16 和 EPSG:4326。';
  }else{
   assert(JSON.stringify(e.request.input).includes('Z16 EPSG:4326'),'literal human requirements remain live');
   const history=e.request.input.filter(item=>item.type==='function_call_output').map(item=>{try{return JSON.parse(item.output);}catch{return null;}});
   const latest=history.filter(item=>item?.section==='history').at(-1);
   if(!latest){assert(!JSON.stringify(e.request.input).includes('EXACT_RECOVERY_SENTINEL'));tool='runtime_context_read';args={section:'history',query:'EXACT_RECOVERY_SENTINEL',maxChars:512};}
   else{
    const page=latest.entries[0];archiveId=page.recordId;recovered+=page.text;pageOffset=page.nextTextOffset;
    if(pageOffset!==null){tool='runtime_context_read';args={section:'history',recordId:archiveId,textOffset:pageOffset,maxChars:512};}
    else{assert.deepEqual(JSON.parse(recovered).item,seedRecord,'retrieval must restore the exact original Core record, including native receipt metadata');content='已从本地原始历史恢复完整记录，原参数继续保留。';}
   }
  }
  listener({type:'response',requestId:e.requestId,value:{generationId:e.generationId,state:'settled',inputTokens:100,outputTokens:5,result:{content,toolCalls:tool?[{id:'fixture-'+requests,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]:[]}}});
 }});
 try{
  host=await start();const seed=await host.turn({conversationId:'tiers-fixture',workspace:home,input:'请读取图源记录，已确定任务参数为 Z16 EPSG:4326',history:[],permission:'confirmEach'},'tiers-seed');firstThread=seed.threadId;assert.equal(seed.status,'completed');await host.close();
  mode='recover';host=await start();const next=await host.turn({conversationId:'tiers-fixture',workspace:home,input:'继续刚才的任务，保持已确定参数',history:[],permission:'confirmEach'},'tiers-recover');assert.equal(next.threadId,firstThread);assert.equal(next.status,'completed',next.error?.message?.slice(0,400));assert(archiveId);assert(recovered.length>1000);assert(requests>=5,'the real tool loop must retrieve multiple pages');
  const output=resolve('../../artifacts/context-tiers-20261010');mkdirSync(output,{recursive:true});writeFileSync(join(output,'core-recovery.json'),JSON.stringify({passed:true,paidModelRequests:0,fixtureRequests:requests,sameCoreThread:true,hostRecreated:true,recoveredCharacters:recovered.length,exactResultRecovered:true,humanParametersPreserved:true,observed},null,2));
 }finally{await host?.close();}
});
