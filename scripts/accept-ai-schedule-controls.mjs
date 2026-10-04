/** Actual scheduled Codex cancellation, permission pause/retry and UI creation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule,evidencePath]=process.argv.slice(2);assert(path.isAbsolute(evidencePath));await fs.mkdir(evidencePath,{recursive:true});
const {chromium}=await import(playwrightModule),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,200));}assert(page);await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);const schedules=[],jobs=[];
const report={startedAt:new Date().toISOString(),actualHostedModel:true,cases:[]},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const save=()=>fs.writeFile(path.join(evidencePath,'controls-acceptance.json'),JSON.stringify(report,null,2));
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(value.error)throw value.error;return value.value;};
const wait=async(check,label,timeout=180000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(300);}throw Error('Timeout: '+label);};
const finish=async(name,details)=>{report.cases.push({name,pass:true,...details});await save();console.log(JSON.stringify({case:name,pass:true}));};
const overview=conversationId=>rpc('ai_schedules_list',{conversationId});
const create=async(conversationId,name,prompt)=>{const s=await rpc('ai_schedules_create',{conversationId,name,prompt,nextRunAt:new Date(Date.now()+3000).toISOString(),repeatSeconds:null,executionId:crypto.randomUUID()});schedules.push(s);return s;};
const runFor=async s=>(await overview(s.conversationId)).runs.find(r=>r.scheduleId===s.scheduleId);
const trace=async run=>{const value=await rpc('ai_schedules_run_events',{runId:run.runId});await fs.writeFile(path.join(evidencePath,run.runId+'.json'),JSON.stringify(value,null,2));return value;};
try{
  const status=await rpc('background_status');assert.equal(status.activeAiTurns,0);assert.equal(status.activeDownloads,0);
  const conversationId=crypto.randomUUID(),directory=path.join(evidencePath,'controls-'+conversationId);await fs.mkdir(directory,{recursive:true});
  await rpc('workspace_set',{conversationId,directory,permission:'fullAccess'});
  const s=await create(conversationId,'取消后台 AI 命令','取消能力验收：使用工作区命令运行 python，先等待 45 秒，再将 cancelled-test.txt 写入当前工作区，内容为 should-not-exist。仅这一个命令即可，不使用其他工具。');
  const running=await wait(async()=>{const r=await runFor(s);if(!r)return null;assert(!['failed','succeeded','waiting_input'].includes(r.state),JSON.stringify(r));const events=await rpc('ai_schedules_run_events',{runId:r.runId});return events.events.some(e=>e.method==='item/started'&&e.params?.item?.type==='commandExecution')?r:null;},'actual long command starts');
  let stopError;try{await rpc('background_stop');}catch(error){stopError=error;}assert.equal(stopError?.code,'BACKGROUND_BUSY');
  const cancelled=await rpc('ai_schedules_cancel_run',{runId:running.runId});assert.equal(cancelled.state,'cancelled');
  await wait(async()=>!(await rpc('background_status')).activeAiTurns,'cancel releases model worker',20000);
  assert.equal((await runFor(s)).state,'cancelled');assert.equal(await fs.access(path.join(directory,'cancelled-test.txt')).then(()=>true,()=>false),false);
  const cancelledTrace=await trace(cancelled);await finish('cancel-running-command-and-stop-busy',{runId:running.runId,cancelled:true,fileNotWritten:true,busyStopCode:stopError.code});
  const spec={schemaVersion:'0.1',kind:'imagery',sourceId:'esri-world-imagery',bounds:[116.39,39.90,116.40,39.91],zoomLevels:[12],outputFormats:['geotiff'],outputDirectory:path.join(directory,'approved-result'),limits:{maxTiles:1000,maxDecodedRgbaBytes:1073741824},exportOptions:{compression:'lzw',buildPyramid:false,generateSidecars:false,jpegQuality:90}};
  const plan=await rpc('plans_create',{conversationId,spec,toolExecutionId:crypto.randomUUID()});
  await rpc('workspace_set',{conversationId,directory,permission:'confirmEach'});
  const confirmation=await create(conversationId,'沿用工作区权限并重试',`请实际调用 jobs_start 尝试启动影像计划 ${plan.planId}。本次需要核验工具返回的真实权限结果；如工具要求确认就结束本次，不尝试绕过，不创建其他计划。如成功启动就简洁报告一次真实结果，不轮询。`);
  const paused=await wait(async()=>{const r=await runFor(confirmation);return r&&['waiting_input','succeeded','failed'].includes(r.state)?r:null;},'permission result');
  const pausedTrace=await trace(paused);assert.equal(paused.state,'waiting_input',JSON.stringify(paused));assert(pausedTrace.events.some(e=>e.type==='toolResult'&&e.tool==='jobs_start'&&e.result?.error?.code==='APPROVAL_REQUIRED'));
  const firstThread=cancelledTrace.events.find(e=>e.type==='thread')?.threadId,secondThread=pausedTrace.events.find(e=>e.type==='thread')?.threadId;assert(firstThread&&secondThread);assert.notEqual(firstThread,secondThread,'Separate schedules must not share Codex history');
  assert.equal(await rpc('jobs_for_plan',{planId:plan.planId}),null);
  await rpc('workspace_set',{conversationId,directory,permission:'fullAccess'});await rpc('ai_schedules_retry_run',{runId:paused.runId});
  const resumed=await wait(async()=>{const r=await runFor(confirmation);return r&&r.attempt===2&&['succeeded','waiting_input','failed'].includes(r.state)?r:null;},'actual retry result');
  const retryTrace=await trace(resumed);assert.equal(resumed.state,'succeeded',JSON.stringify(resumed));const started=retryTrace.events.filter(e=>e.type==='toolResult'&&e.tool==='jobs_start'&&e.result?.jobId).at(-1);assert(started);jobs.push(started.result.jobId);
  assert.equal(retryTrace.events.filter(e=>e.type==='thread').at(-1)?.threadId,secondThread,'Manual retry must retain the schedule thread');
  const job=await wait(async()=>{const r=await rpc('jobs_get',{jobId:started.result.jobId});assert(!['failed','partial','cancelled'].includes(r.state),JSON.stringify(r));return r.state==='completed'?r:null;},'real resumed download');
  const artifacts=await rpc('artifacts_inspect',{jobId:job.jobId});assert.equal(artifacts.quality.missingTiles,0);
  await finish('permission-pause-and-manual-retry',{runId:resumed.runId,attempt:resumed.attempt,jobId:job.jobId,state:job.state,quality:artifacts.quality,separateScheduleThreadIds:[firstThread,secondThread],retryRetainsThread:true});
  await page.locator('.sidebar-new-chat').click();const title='AI 定时入口验收 '+crypto.randomUUID().slice(0,8),at=new Date(Date.now()+300000).toISOString();
  const prompt=`请创建一个仅执行一次的 AI 定时任务，名称“${title}”，开始时间 ${at}。执行指令是：调用 workspace_status 检查工作区并简洁报告真实状态，不下载任何内容。请使用 ai_schedules_create 实际保存，不要只给出建议。`;
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const record=()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(k=>JSON.parse(localStorage.getItem(k)||'[]')));
  const chat=await wait(async()=>{const c=(await record()).find(c=>c.display.some(m=>m.role==='user'&&m.content===prompt));return c?.messages.at(-1)?.role==='assistant'&&!c.pendingId&&await page.getByRole('button',{name:'停止回复',exact:true}).count()===0?c:null;},'real UI model creates schedule');
  const saved=(await overview(chat.conversationId)).schedules.find(s=>s.name===title);assert(saved,chat.messages.at(-1)?.content);schedules.push(saved);assert.equal(saved.repeatSeconds,null);assert.equal(new Date(saved.nextRunAt).getTime(),new Date(at).getTime());
  if(await page.getByRole('button',{name:'打开任务与成果',exact:true}).isVisible())await page.getByRole('button',{name:'打开任务与成果',exact:true}).click();
  await page.getByRole('tab',{name:'定时',exact:true}).click();await page.locator('.ai-schedule-section').getByText(title,{exact:true}).waitFor();
  await page.screenshot({path:path.join(evidencePath,'ai-schedule-panel.png')});await page.locator('.ai-schedule-section .schedule-item').filter({hasText:title}).getByRole('button',{name:'暂停',exact:true}).click();
  await wait(async()=>!(await overview(chat.conversationId)).schedules.find(s=>s.scheduleId===saved.scheduleId).enabled,'UI pause persists');
  await fs.writeFile(path.join(evidencePath,'actual-ui-conversation.json'),JSON.stringify(chat,null,2));
  await finish('actual-conversation-creates-schedule-and-ui-pauses',{conversationId:chat.conversationId,scheduleId:saved.scheduleId,title,answer:chat.messages.at(-1)?.content});
  report.pass=true;report.finishedAt=new Date().toISOString();await save();
}catch(error){report.pass=false;report.failure=error.stack??JSON.stringify(error);await save();throw error;}
finally{
  for(const s of schedules){await rpc('ai_schedules_set_enabled',{scheduleId:s.scheduleId,enabled:false}).catch(()=>{});const r=await runFor(s).catch(()=>null);if(r&&['queued','running','waiting_input','interrupted'].includes(r.state))await rpc('ai_schedules_cancel_run',{runId:r.runId}).catch(()=>{});}
  for(const jobId of jobs)await rpc('jobs_cancel',{jobId}).catch(()=>{});await browser.close();
}
