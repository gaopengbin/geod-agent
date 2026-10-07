// Real pinned Core shell, fixture model, real RTK. No paid model request.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
import {codexRequest} from '../../../packages/codex-protocol/codex-contract.mjs';
const output=resolve('../../artifacts/rtk-20261007');mkdirSync(output,{recursive:true});
const catalog=JSON.parse(readFileSync(resolve('../../vendor/rtk-runtime.json'),'utf8'));
const root=mkdtempSync(join(output,'core-')),binary=join(root,'binary');mkdirSync(binary);
execFileSync('python',['-X','utf8',resolve('src-tauri/src/rtk_extract.py'),resolve('../../.dev-cache/rtk-0.40.0.zip'),binary,catalog.executableMember,String(catalog.executableBytes),catalog.executableSha256],{windowsHide:true});
const profile=join(root,'profile');for(const p of ['','temp','appdata','localappdata'])mkdirSync(join(profile,p),{recursive:true});
const settingsFile=join(root,'settings.json');writeFileSync(settingsFile,'{"enabled":true}');
const workspace=join(root,'workspace');mkdirSync(workspace);mkdirSync(join(workspace,'src'));
for(let file=0;file<8;file++)writeFileSync(join(workspace,'src',`file${file}.txt`),Array.from({length:45},(_,i)=>`test_match_${i}: text for the output compaction test, actual captured line ${i}`).join('\n'));
let listener,round=0,commandCalls=0;const requests=[],events=[];
const host=await createHost({codex:resolve('src-tauri/resources/codex/codex.exe'),home:join(root,'home'),toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{model:'deepseek-flash',contextWindow:128000,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
 if(event.type==='event')events.push(event);
 if(event.type==='model'){
  requests.push(event.request);round++;
  const contract=codexRequest(event.request);
  if(round===1){
   const entry=[...contract.definitions.entries()].find(([,v])=>v.name==='exec_command'||v.function?.name==='exec_command');
   if(!entry){writeFileSync(join(output,'core-tools.json'),JSON.stringify([...contract.definitions],null,2));throw new Error('Native exec_command not found');}
   const def=entry[1];console.log(JSON.stringify({tool:entry[0],definition:def}));
   commandCalls++;
   listener({type:'response',requestId:event.requestId,value:{state:'settled',generationId:event.generationId,inputTokens:20,outputTokens:20,result:{content:null,toolCalls:[{id:'rtk_exec',type:'function',namespace:def.namespace??'functions',function:{name:'exec_command',arguments:JSON.stringify({cmd:'rg -n test_match src',workdir:workspace,max_output_tokens:15000,yield_time_ms:10000})}}],finishReason:'tool_calls'}}});
  }else{
   writeFileSync(join(output,'core-outputs.json'),JSON.stringify(event.request.input.filter(i=>i.type.endsWith('_output')),null,2));
   listener({type:'response',requestId:event.requestId,value:{state:'settled',generationId:event.generationId,inputTokens:20,outputTokens:20,result:{content:'命令检查完成。',toolCalls:[],finishReason:'stop'}}});
  }
 }
}});
try{
 const result=await host.turn({conversationId:'rtk-core-fixture',workspace,permission:'fullAccess',input:'搜索工作区 src 中的 test_match，执行 rg -n test_match src。',history:[],rtkOutput:{executable:join(binary,'rtk.exe'),sha256:catalog.executableSha256,settingsFile,profile}},'rtk-core-fixture');
 assert.equal(result.status,'completed');assert.equal(round,2);assert.equal(commandCalls,1);
 const last=requests[1].input.find(i=>i.call_id==='rtk_exec'&&i.type==='function_call_output');assert(last,'Real shell output must reach the provider');assert(last.output.includes('[RTK summary'),last.output.slice(0,600));assert(last.output.includes('Process exited with code 0'));
 const sessions=join(root,'home','sessions'),rollout=readdirSync(sessions,{recursive:true}).find(n=>String(n).endsWith('.jsonl'));
 const rows=readFileSync(join(sessions,rollout),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const raw=rows.find(r=>r.type==='response_item'&&r.payload.call_id==='rtk_exec'&&r.payload.type==='function_call_output')?.payload.output;assert(raw?.includes('test_match_44'));assert(!raw.includes('[RTK summary'));assert(raw.length>last.output.length);
 const report={passed:true,realCore:true,realRtk:true,commandCalls,modelRounds:round,paidModelCalls:0,rawHistoryPreserved:true,exitCode:0,rawChars:raw.length,modelOutputChars:last.output.length,characterReductionPercent:Math.round(1000*(1-last.output.length/raw.length))/10};
 writeFileSync(join(output,'core-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await host.close();}
