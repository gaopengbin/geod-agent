/** Real Codex/hosted model execution in the actual windowless GeoD companion. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),[playwrightModule,evidencePath]=process.argv.slice(2);
assert(path.isAbsolute(evidencePath));await fs.mkdir(evidencePath,{recursive:true});
const {chromium}=await import(playwrightModule);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,page;const schedules=[],report={startedAt:new Date().toISOString(),actualHostedModel:true,cases:[]};
const save=()=>fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));
const connect=async()=>{for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9233');page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page){await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);return;}}catch{}await browser?.close().catch(()=>{});await sleep(200);}throw Error('Development WebView unavailable');};
const rpc=async(command,args={})=>{const reply=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!reply.ok)throw reply.error;return reply.value;};
const probe=async(command,args={})=>{const reply=JSON.parse((await exec('python',['-X','utf8','scripts/background-runtime-probe.py','rpc','--command',command,'--args',JSON.stringify(args)],{windowsHide:true,maxBuffer:16*1024*1024})).stdout);if(!reply.ok)throw reply.error;return reply.result;};
const wait=async(check,label,timeout=180000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(500);}throw Error('Timeout: '+label);};
const finish=async(name,details)=>{report.cases.push({name,pass:true,...details});await save();console.log(JSON.stringify({case:name,pass:true}));};
const create=async(conversationId,name,prompt,seconds=10,repeatSeconds=null)=>{const args={conversationId,name,prompt,nextRunAt:new Date(Date.now()+seconds*1000).toISOString(),repeatSeconds,executionId:crypto.randomUUID()};const s=await rpc('ai_schedules_create',args);schedules.push(s);return{s,args};};
const getRun=async(conversationId,scheduleId,read=probe)=>{const list=await read('ai_schedules_list',{conversationId});return list.runs.find(run=>run.scheduleId===scheduleId);};
try{
  await connect();const status=await rpc('background_status');assert.equal(status.activeAiTurns,0);assert.equal(status.activeDownloads,0);
  const conversationId=crypto.randomUUID(),directory=path.join(evidencePath,'workspace-'+conversationId);await fs.mkdir(directory,{recursive:true});
  await rpc('workspace_set',{conversationId,directory,permission:'fullAccess'});
  const nonce=String(crypto.randomInt(100000,1000000));
  await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({verificationCode:nonce,description:'Actual local scheduled AI acceptance'}));
  await fs.writeFile(path.join(directory,'sample-range.geojson'),JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'后台定时验收范围'},geometry:{type:'Polygon',coordinates:[[[116,40],[116.01,40],[116.01,40.01],[116,40.01],[116,40]]]}}]}));
  const prompt='先调用 workspace_status 和 workspace_gis_files_list 核对当前工作区，再使用工作区命令读取 verification.json 中的 verificationCode。最终简洁回答真实编号及发现的 GeoJSON 文件名，不创建或修改任何文件。';
  const {s,args}=await create(conversationId,'关窗后读取工作区',prompt);
  assert.equal((await rpc('ai_schedules_create',args)).scheduleId,s.scheduleId);
  let conflict;try{await rpc('ai_schedules_create',{...args,prompt:'不同的定时指令'});}catch(error){conflict=error;}assert.equal(conflict?.code,'AI_IDEMPOTENCY_CONFLICT');
  const pid=status.pid;await rpc('plugin:window|close',{label:'main'}).catch(()=>{});await browser.close();browser=null;page=null;
  const run=await wait(async()=>{const r=await getRun(conversationId,s.scheduleId);return r&&['succeeded','failed','waiting_input','interrupted'].includes(r.state)?r:null;},'actual scheduled model result');
  const trace=await probe('ai_schedules_run_events',{runId:run.runId});await fs.writeFile(path.join(evidencePath,'actual-background-run.json'),JSON.stringify(trace,null,2));
  assert.equal(run.state,'succeeded',JSON.stringify({error:run.error,result:run.result}));assert(run.result.text.includes(nonce),run.result.text);assert(run.result.text.includes('sample-range.geojson'),run.result.text);
  assert(trace.events.some(e=>e.type==='toolResult'&&e.tool==='workspace_status'));
  assert(trace.events.some(e=>e.type==='toolResult'&&e.tool==='workspace_gis_files_list'&&JSON.stringify(e.result).includes('sample-range.geojson')));
  const usage=trace.events.filter(e=>e.type==='generationResult').map(e=>e.generation);assert(usage.some(u=>(u.inputTokens??0)>0&&(u.outputTokens??0)>0),'Actual settled model usage absent');
  assert.equal((await probe('runtime_status')).pid,pid);
  await finish('windowless-real-model-tools-and-command',{conversationId,scheduleId:s.scheduleId,runId:run.runId,pid,expectedNonce:nonce,answer:run.result.text,settledGenerations:usage.map(u=>({generationId:u.generationId,inputTokens:u.inputTokens,outputTokens:u.outputTokens,state:u.state}))});
  await exec('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{windowsHide:true});await connect();assert.equal((await rpc('background_status')).pid,pid);
  const reopened=await rpc('ai_schedules_run_events',{runId:run.runId});assert.equal(reopened.run.result.text,run.result.text);
  assert.equal((await rpc('ai_schedules_create',args)).scheduleId,s.scheduleId,'Identical retry after due time must recover original schedule');
  await finish('reopen-retains-authoritative-result',{samePid:true,eventCount:reopened.events.length,retryAfterDueReturnsOriginal:true,changedInstructionError:conflict.code});
  const recurring=await create(conversationId,'暂停后不触发',prompt,60,60);await rpc('ai_schedules_set_enabled',{scheduleId:recurring.s.scheduleId,enabled:false});
  assert.equal((await rpc('ai_schedules_list',{conversationId})).schedules.find(item=>item.scheduleId===recurring.s.scheduleId).enabled,false);
  await finish('pause-and-idempotent-create',{idempotentScheduleId:s.scheduleId,pausedScheduleId:recurring.s.scheduleId});
  report.pass=true;report.finishedAt=new Date().toISOString();await save();
}catch(error){report.pass=false;report.failure=error.stack??JSON.stringify(error);await save();throw error;}
finally{
  for(const schedule of schedules){const read=page&&!page.isClosed()?rpc:probe;await read('ai_schedules_set_enabled',{scheduleId:schedule.scheduleId,enabled:false}).catch(()=>{});const r=await getRun(schedule.conversationId,schedule.scheduleId,read).catch(()=>null);if(r&&['running','queued','waiting_input','interrupted'].includes(r.state))await read('ai_schedules_cancel_run',{runId:r.runId}).catch(()=>{});}
  if(!page||page.isClosed())await exec('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{windowsHide:true}).catch(()=>{});
  await browser?.close().catch(()=>{});
}
