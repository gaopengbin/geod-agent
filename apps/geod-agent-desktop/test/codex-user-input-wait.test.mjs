import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';import {inputWaitDeadline} from '../src-tauri/codex-input-wait.mjs';
function clock(){let now=0,next=0;const timers=new Map();return {setTimer(fn,ms){const id=++next;timers.set(id,{at:now+ms,fn});return id;},clearTimer(id){timers.delete(id);},advance(ms){now+=ms;for(const [id,value] of timers)if(value.at<=now){timers.delete(id);value.fn();}}};}
for(const tool of ['ask_user','plan_imagery'])test(`real Core waits for ${tool} input beyond the old tool deadline`,{skip:!process.env.GEOD_CODEX_EXE,timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'geod-input-wait-')),time=clock();let listener,models=0,toolEvent;const outputs=[];
 const host=await createHost({codex:process.env.GEOD_CODEX_EXE,home:root,toolsFile:resolve('src-tauri/codex-tools.json'),requestDeadline:(timeout,expire)=>inputWaitDeadline(timeout,expire,time),receive:fn=>{listener=fn;return()=>{};},emit:event=>{
  if(event.type==='model'){
   models++;outputs.push(event.request.input);
   listener({type:'response',requestId:event.requestId,value:{generationId:event.generationId,state:'settled',inputTokens:20,outputTokens:10,result:{content:models===1?null:'输入后继续完成',toolCalls:models===1?[{id:'call_wait_user',type:'function',function:{name:tool,arguments:tool==='ask_user'?JSON.stringify({questions:[{id:'q',header:'坐标系',question:'使用哪个投影？',options:[{label:'EPSG:2363',description:'西安80'}]}]}):JSON.stringify({sourceId:'fixture',bounds:[116.37,39.97,116.42,40.01],zoom:18,outputFormats:['geotiff']})}}]:[]}}});
  }else if(event.type==='tool'){toolEvent=event;listener({type:'userInputState',requestId:event.requestId,waiting:true});}
 }});
 try{
  const operation=host.turn({conversationId:'waiting-'+tool,workspace:root,input:'先询问，再继续。',history:[],permission:'confirmEach'});
  for(let i=0;i<150&&!toolEvent;i++)await new Promise(r=>setTimeout(r,20));assert(toolEvent);
  time.advance(20*60000);await new Promise(r=>setTimeout(r,100));assert.equal(models,1,'No model round may proceed while the user has not answered');
  const result=tool==='ask_user'?{answers:{q:{answers:['EPSG:2363']}},answeredBy:'user'}:{planId:'fixture-plan',targetCrs:'EPSG:2363'};
  listener({type:'userInputState',requestId:toolEvent.requestId,waiting:false});listener({type:'response',requestId:toolEvent.requestId,value:{result}});
  const completed=await operation;assert.equal(completed.status,'completed');assert.equal(models,2);assert.equal(completed.text,'输入后继续完成');assert(JSON.stringify(outputs[1]).includes('EPSG:2363'));
 }finally{await host.close();}
});
