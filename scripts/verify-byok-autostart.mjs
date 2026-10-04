/** Actual registry command, windowless companion and real personal model schedules. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const providerKey=process.env.GEOD_QA_DEEPSEEK_KEY;delete process.env.GEOD_QA_DEEPSEEK_KEY;delete process.env.DEEPSEEK_API_KEY;assert(providerKey);
const {chromium}=await import('file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const output=path.resolve('artifacts/product-gaps-20261004/autostart');await fs.mkdir(output,{recursive:true});
let browser,page,channel,original,entryBefore;const schedules=[],report={passed:false,systemRebootPerformed:false,realProvider:'DeepSeek Flash',cases:[]};
const save=()=>fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
const wait=async(check,label,timeout=180000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(500);}throw Error('Timeout: '+label);};
const connect=async()=>{await wait(async()=>{try{browser=await chromium.connectOverCDP('http://127.0.0.1:9233');page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(page){await page.locator('textarea:not([disabled])').waitFor({timeout:1000});return true;}}catch{}await browser?.close().catch(()=>{});browser=null;return false;},'actual desktop',45000);};
const rpc=async(command,args={})=>{const response=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error};}},{command,args});if(!response.ok)throw response.error;return response.value;};
const probe=async(command='runtime_status',args={})=>{const response=JSON.parse((await exec('python',['-X','utf8','scripts/background-runtime-probe.py','rpc','--command',command,'--args',JSON.stringify(args)],{windowsHide:true,maxBuffer:16*1024*1024})).stdout);if(!response.ok)throw response.error;return response.result;};
const registry=async()=>{try{return (await exec('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','GeoD Agent (development)'],{windowsHide:true})).stdout.trim();}catch{return null;}};
const processInfo=async pid=>JSON.parse((await exec('python',['-X','utf8','scripts/native-process-evidence.py','--pid',String(pid)],{windowsHide:true})).stdout);
const finish=async(name,value)=>{report.cases.push({name,passed:true,...value});await save();console.log(JSON.stringify({name,passed:true}));};
const overview=conversationId=>probe('ai_schedules_list',{conversationId});
const resultFor=async(conversationId,scheduleId)=>wait(async()=>{const list=await overview(conversationId),run=list.runs.find(run=>run.scheduleId===scheduleId);return run&&['succeeded','failed','waiting_input','interrupted','cancelled'].includes(run.state)?run:null;},'real model schedule result');
try{
  await connect();assert.equal(await page.locator('.conversation-running-dot').count(),0);
  let initial=await rpc('background_status');if(initial.running===false)initial=await rpc('background_start');initial=await wait(async()=>{const status=await rpc('background_status');return status.activeAiTurns===0?status:null;},'existing AI execution settles',45000);for(const key of ['activeDownloads','activeCommands','activeAiTurns'])assert.equal(initial[key],0);assert.equal(initial.maintenanceActive,false);
  original={settings:await rpc('desktop_settings_get'),default:(await rpc('ai_channels_list')).default};entryBefore=await registry();
  channel=await rpc('ai_channel_save',{draft:{name:'系统启动验收 · 临时 DeepSeek',baseUrl:'https://api.deepseek.com/v1',protocol:'chatCompletions',enabled:true,apiKey:providerKey,models:[{id:'deepseek-flash',name:'DeepSeek Flash',contextWindow:128000,maxOutputTokens:4096,inputModalities:['text'],thinking:'enabled'}]}});
  assert(!JSON.stringify(channel).includes(providerKey));
  const conversationId=crypto.randomUUID(),directory=path.join(output,`workspace-${conversationId}`),nonce=crypto.randomBytes(6).toString('hex');await fs.mkdir(directory,{recursive:true});
  const fileName=`actual-range-${nonce}.geojson`;await fs.writeFile(path.join(directory,fileName),JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:nonce},geometry:{type:'Polygon',coordinates:[[[116,40],[116.01,40],[116.01,40.01],[116,40.01],[116,40]]]}}]}));
  await rpc('workspace_set',{conversationId,directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId,channelId:channel.id,modelId:'deepseek-flash'});
  const prompt='调用 workspace_status 和 workspace_gis_files_list 读取当前工作区。最终简洁报告工具实际发现的全部 GeoJSON 文件名。不下载、不改文件。';
  const once=await rpc('ai_schedules_create',{conversationId,name:'自带 Key · 系统启动后单次执行',prompt,nextRunAt:new Date(Date.now()+300000).toISOString(),repeatSeconds:null,executionId:crypto.randomUUID()});schedules.push(once);
  const recurring=await rpc('ai_schedules_create',{conversationId,name:'自带 Key · 错过多个周期后合并执行',prompt,nextRunAt:new Date(Date.now()+300000).toISOString(),repeatSeconds:60,executionId:crypto.randomUUID()});schedules.push(recurring);
  assert.equal(once.modelRoute.channel.id,channel.id);assert.equal(recurring.modelRoute.channel.id,channel.id);
  await rpc('desktop_autostart_set',{enabled:true});const entry=await registry();assert(entry?.includes('--background-runtime'));
  const value=entry.match(/REG_SZ\s+(.+)$/m)?.[1].trim(),parsed=value?.match(/^(?:"([^"\r\n]+)"|([^\s"\r\n]+))\s+--background-runtime$/);assert(parsed,'Expected exact registered executable and background argument');
  assert(parsed[1],'Native startup command must quote the executable, including installed paths containing spaces');
  const executable=path.resolve(parsed[1]??parsed[2]);assert.equal(executable.toLowerCase(),path.resolve('apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').toLowerCase());
  await rpc('background_stop');await wait(async()=>!(await processInfo(initial.pid)).alive,'old idle companion stops',15000);
  // Only fixture schedule timestamps are moved backwards while all writers are stopped.
  const overdue=new Date(Date.now()-310000).toISOString();
  const fixtureMutation=await exec('python',['-X','utf8','-c',"import json,os,sqlite3,sys; from pathlib import Path; from datetime import datetime; db=sqlite3.connect(Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'); pairs=[(sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4])];\nfor sid,at in pairs:\n row=db.execute('SELECT body FROM ai_schedules WHERE id=?',(sid,)).fetchone(); body=json.loads(row[0]); body['nextRunAt']=at; db.execute('UPDATE ai_schedules SET next_at=?,body=? WHERE id=?',(datetime.fromisoformat(at.replace('Z','+00:00')).timestamp(),json.dumps(body),sid))\ndb.commit(); print(json.dumps({'ownFixtureOnly':True}))",recurring.scheduleId,overdue,once.scheduleId,new Date(Date.now()+30000).toISOString()],{windowsHide:true});assert(JSON.parse(fixtureMutation.stdout).ownFixtureOnly);
  const daemonEnv={...process.env};for(const key of ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','GEOD_AGENT_DEV_UPDATE_CONFIG','GEOD_AGENT_DEV_GATEWAY_ORIGIN','GEOD_CODEX_EXE','GEOD_CODEX_NODE'])delete daemonEnv[key];
  const launch=JSON.parse((await exec('python',['-X','utf8','-c',"import json,subprocess,sys; process=subprocess.Popen([sys.argv[1],'--background-runtime'],cwd=__import__('pathlib').Path(sys.argv[1]).parent,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,creationflags=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_BREAKAWAY_FROM_JOB); print(json.dumps({'pid':process.pid}))",executable],{env:daemonEnv,windowsHide:true})).stdout);
  const status=await wait(async()=>{try{const value=await probe();return value.pid!==initial.pid?value:null;}catch{return null;}},'registered command starts companion',20000);assert.equal(status.pid,launch.pid);assert.equal(status.windowRequired,false);
  const nativeProcess=await processInfo(status.pid);report.windowInspection=nativeProcess;await save();assert.equal(nativeProcess.visibleWindows,0);assert(!nativeProcess.children.some(child=>/msedgewebview/i.test(child.name)));
  await finish('registered-login-command-starts-windowless-native-companion',{commandMatchesRegistry:true,previousPid:initial.pid,pid:status.pid,visibleWindows:nativeProcess.visibleWindows,webviewChildren:false});
  await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();});await rpc('plugin:window|close',{label:'main'}).catch(()=>{});await browser.close();browser=null;page=null;
  const runs=[];
  for(const schedule of [once,recurring]){
    const run=await resultFor(conversationId,schedule.scheduleId),trace=await probe('ai_schedules_run_events',{runId:run.runId});await fs.writeFile(path.join(output,`${schedule===once?'once':'recurring'}-actual-run.json`),JSON.stringify(trace,null,2));
    assert.equal(run.state,'succeeded',JSON.stringify({error:run.error,result:run.result}));assert(run.result.text.includes(fileName),run.result.text);
    const generations=trace.events.filter(event=>event.type==='generationResult').map(event=>event.generation);assert(generations.length>=2);assert(generations.every(generation=>generation.billingScope==='personal'&&generation.channelId===channel.id&&generation.selectedModel==='deepseek-flash'&&generation.inputTokens>0&&generation.outputTokens>0));
    assert(trace.events.some(event=>event.type==='toolResult'&&event.tool==='workspace_gis_files_list'&&JSON.stringify(event.result).includes(fileName)));runs.push({runId:run.runId,scheduleId:schedule.scheduleId,state:run.state,answer:run.result.text,attempt:run.attempt,generations:generations.map(generation=>({channelId:generation.channelId,model:generation.selectedModel,inputTokens:generation.inputTokens,outputTokens:generation.outputTokens,billingScope:generation.billingScope}))});
  }
  await probe('ai_schedules_set_enabled',{scheduleId:recurring.scheduleId,enabled:false});
  const list=await overview(conversationId),recurringRuns=list.runs.filter(run=>run.scheduleId===recurring.scheduleId),savedRecurring=list.schedules.find(schedule=>schedule.scheduleId===recurring.scheduleId);assert.equal(recurringRuns.length,1);assert(new Date(savedRecurring.nextRunAt).getTime()>Date.now()-60000);assert.equal(new Date(recurringRuns[0].scheduledAt).toISOString(),overdue);
  assert.equal((await probe()).pid,status.pid);await finish('byok-real-model-runs-after-window-close',{conversationId,fileName,runs,sameCompanionPid:true});
  await finish('multiple-missed-periods-coalesce-on-restart',{declaredClockFixture:'Only the temporary schedule due time was set 310 seconds earlier while daemon was stopped; no system clock changes or actual system reboot',repeatSeconds:60,runCount:recurringRuns.length,scheduledAt:recurringRuns[0].scheduledAt,nextRunAt:savedRecurring.nextRunAt});
  await exec('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{windowsHide:true});await connect();assert.equal((await rpc('background_status')).pid,status.pid);
  const retained=await rpc('ai_schedules_list',{conversationId});assert.equal(retained.runs.filter(run=>run.state==='succeeded').length,2);await finish('reopen-retains-native-results',{samePid:true,completedRuns:2});report.passed=true;await save();
}catch(error){report.failure=error.stack??JSON.stringify(error);await save();throw error;}
finally{
  if(page&&!page.isClosed())await rpc('background_start').catch(()=>{});
  for(const schedule of schedules){await probe('ai_schedules_set_enabled',{scheduleId:schedule.scheduleId,enabled:false}).catch(()=>{});const list=await probe('ai_schedules_list',{conversationId:schedule.conversationId}).catch(()=>null);for(const run of list?.runs??[])if(run.scheduleId===schedule.scheduleId&&['queued','running','waiting_input','interrupted'].includes(run.state))await probe('ai_schedules_cancel_run',{runId:run.runId}).catch(()=>{});}
  if(!page||page.isClosed()){await exec('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{windowsHide:true}).catch(()=>{});await connect().catch(()=>{});}
  if(page&&!page.isClosed()){
    if(original){await rpc('desktop_autostart_set',{enabled:original.settings.autostart}).catch(()=>{});await rpc('ai_model_select',{conversationId:'default',...original.default}).catch(()=>{});}
    if(channel)await rpc('ai_channel_remove',{channelId:channel.id}).catch(()=>{});
    await rpc('background_start').catch(()=>{});
  }
  if(original)assert.equal(await registry(),entryBefore,'Original development startup entry must be restored');await browser?.close().catch(()=>{});
}
