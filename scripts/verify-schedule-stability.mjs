// Actual packaged WebView, Rust IPC, detached native companion and DeepSeek.
// No browser IPC adapters, changed due dates, system clock changes or installation.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createGatewayServer,readConfig} from '../services/geod-agent-model-gateway/server.mjs';

const root=resolve(process.env.GEOD_QA_STABILITY_ROOT??'');
assert(root.startsWith(resolve('artifacts/schedule-stability-native-20261005')+'\\fixture-'));
const providerKey=process.env.GEOD_QA_DEEPSEEK_KEY;
delete process.env.GEOD_QA_DEEPSEEK_KEY;delete process.env.DEEPSEEK_API_KEY;
assert(providerKey);
const cycles=Number(process.env.GEOD_QA_STABILITY_CYCLES),offlineSeconds=Number(process.env.GEOD_QA_STABILITY_OFFLINE_SECONDS);
assert(cycles>=8&&cycles<=30&&offlineSeconds>=185&&offlineSeconds<=600);
const exe=join(root,'target/release/geod-agent-desktop.exe');
assert.equal(createHash('sha256').update(readFileSync(exe)).digest('hex'),'4b5f8ca2b213090da27785d7fc17d01e67532742126273bb7c56b880c79bd885');
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const helper=resolve('scripts/schedule-stability-support.py'),credentialHelper=resolve('apps/geod-agent-desktop/test/credit-history-native-support.py');
function support(action,value={}){
  const completed=spawnSync('python',['-X','utf8',helper,action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  assert.equal(completed.status,0,completed.stderr);return JSON.parse(completed.stdout);
}
function credential(action,value){
  const completed=spawnSync('python',['-X','utf8',credentialHelper,action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true});
  assert.equal(completed.status,0,completed.stderr);return JSON.parse(completed.stdout);
}
function probe(command='runtime_status',args={}){
  const result=support('rpc',{command,args});if(!result.ok)throw result.error;return result.result;
}
const report={passed:false,startedAt:new Date().toISOString(),cases:[],samples:[],provider:'DeepSeek Flash',
  modelScope:'personal',profile:'dev.geod-agent.credit-history-qa',qaBinaryVersion:'0.2.1',
  shippingCandidateModified:false,installed:false,productionModified:false,systemRebootPerformed:false,systemClockModified:false,dueDatesModified:false};
const save=()=>writeFileSync(join(root,'result.json'),JSON.stringify(report,null,2));
const casePassed=(name,details={})=>{report.cases.push({name,passed:true,...details});save();console.log(JSON.stringify({case:name,passed:true}));};
const started=performance.now(),deadline=started+cycles*60000+offlineSeconds*1000+600000;
function bounded(){assert(performance.now()<deadline,'Bounded native acceptance deadline exceeded');}
async function wait(check,label,timeout=90000,period=500){
  const end=performance.now()+timeout;while(performance.now()<end){bounded();const value=await check();if(value)return value;await sleep(period);}throw Error('Timeout: '+label);
}
const beforeProcesses=support('snapshot'),owned=[];
assert.equal(beforeProcesses.startup['GeoD Agent'],null,'Shared shipping startup must remain disabled during isolated QA');
assert(!beforeProcesses.processes.some(p=>p.exe.toLowerCase().includes('credit-history')||p.exe.toLowerCase().includes('schedule-stability')),'The existing QA identity must be stopped');
const originalBrowser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const originalPage=originalBrowser.contexts().flatMap(ctx=>ctx.pages()).find(page=>page.url()==='http://127.0.0.1:1420/');assert(originalPage);
async function originalState(){
  const value=await originalPage.evaluate(async()=>{
    await window.__GEOD_LOCAL_STATE__?.flush();
    const records=await new Promise((resolve,reject)=>{
      const open=indexedDB.open('geod-ui-state-v1',1);open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{const db=open.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();
        tx.oncomplete=()=>{db.close();const records=Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]));keys.result.forEach((k,i)=>records[k]=values.result[i]);resolve(records);};tx.onabort=()=>reject(tx.error);};
    });
    const key=Object.keys(records).find(k=>k.startsWith('geod-agent-conversations-0.1:account:'));assertNeverAbsent(key);
    function assertNeverAbsent(value){if(!value)throw Error('Original history unavailable');}
    const chats=JSON.parse(records[key]),{api}=await import('/src/api.ts');
    return {chats:chats.map(c=>({conversationId:c.conversationId,title:c.title??null,messages:c.messages,display:c.display,planId:c.planId??null,planIds:c.planIds??[]})),
      active:records['geod-agent-active-conversation-0.1:account:'+key.split(':account:')[1]],payment:await api.agentPaymentSnapshot(),background:await api.backgroundStatus(),sourceCount:(await api.sourcesList()).length};
  });
  return {chatCount:value.chats.length,chatSha256:createHash('sha256').update(JSON.stringify(value.chats)).digest('hex'),active:value.active,payment:value.payment,background:value.background,sourceCount:value.sourceCount};
}
const originalBefore=await originalState();
const token=randomBytes(32).toString('base64url'),account='credit-history-native-fixture';
const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'no-hosted-model-calls-in-this-test',
  GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'model.sqlite')});
let server,browser,page,child,identityOrigin,channel,channelReferences=[],conversationId,currentDaemon,upstreamCalls=0;
const schedules=[],completedRuns=[];
const fetchImpl=async(url,options)=>{
  if(!url.endsWith('/api/geod/oauth/introspect')){upstreamCalls++;throw Error('Hosted model calls are forbidden in this personal-channel test');}
  return Response.json({active:JSON.parse(options.body).token===token?{userId:account,clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+3600000}:null});
};
const remember=value=>{if(!owned.some(old=>old.pid===value.pid&&old.created===value.created))owned.push(value);return value;};
function ownedProcess(pid){const value=support('snapshot').processes.find(p=>p.pid===pid&&p.exe.toLowerCase()===exe.toLowerCase());assert(value,'Explicit QA process identity missing');return remember(value);}
async function launch(){
  assert.match(identityOrigin,/^http:\/\/127\.0\.0\.1:[1-9]\d*$/,'Require the explicit loopback fixture before launching any QA window');
  child=spawn(exe,[],{cwd:join(root,'target/release'),env:{...process.env,GEOD_AGENT_IDENTITY_ORIGIN:identityOrigin,GEOD_AGENT_GATEWAY_ORIGIN:identityOrigin,
    GEOD_AGENT_DEV_GATEWAY_ORIGIN:undefined,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9236'},windowsHide:true,
    stdio:['ignore',openSync(join(root,'desktop.log'),'a'),openSync(join(root,'desktop-errors.log'),'a')]});
  child.on('error',()=>{});remember(ownedProcess(child.pid));
  await wait(async()=>{try{const response=await fetch('http://127.0.0.1:9236/json/list');return response.ok&&(await response.json()).some(p=>p.type==='page');}catch{return false;}},'isolated actual WebView',45000);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
  page=browser.contexts().flatMap(ctx=>ctx.pages()).find(page=>/^https?:\/\/tauri\.localhost\/?/.test(page.url()));assert(page);
  page.setDefaultTimeout(20000);page.on('pageerror',error=>{report.rendererErrors??=[];report.rendererErrors.push(error.message);});
  await page.locator('.conversation-account-trigger').waitFor();
  const status=await call('auth_status');assert.equal(status.state,'connected');assert.equal(status.userId,account);
  const background=await call('background_status');assert.equal(background.running,true);
  currentDaemon=ownedProcess(background.pid);assert.notEqual(background.pid,originalBefore.background.pid);
  return background;
}
async function call(command,args={}){
  const result=await page.evaluate(async({command,args})=>{try{return {value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {error};}},{command,args});
  if('error' in result)throw result.error;return result.value;
}
async function closeWindow(){
  await page.evaluate(()=>window.__GEOD_LOCAL_STATE__?.flush());
  const foreground=ownedProcess(child.pid);
  await call('plugin:window|close',{label:'main'}).catch(()=>{});
  await browser.close();browser=null;page=null;
  await wait(()=>!support('sample',foreground).alive,'only the QA foreground closes',15000);
}
async function startBackground(){
  const value=remember(support('start-background',{exe,identityOrigin}));
  await wait(()=>{try{return probe().pid===value.pid;}catch{return false;}},'explicit isolated native background starts',20000);
  currentDaemon=value;return value;
}
const overview=()=>probe('ai_schedules_list',{conversationId});
const runsFor=id=>overview().runs.filter(run=>run.scheduleId===id);
const isTerminal=run=>['succeeded','failed','waiting_input','interrupted','cancelled'].includes(run.state);
async function finished(id){return wait(()=>{const run=runsFor(id).find(isTerminal);return run??null;},'actual scheduled model finishes',180000);}
function validate(run,fileName,phase){
  assert.equal(run.state,'succeeded',JSON.stringify({state:run.state,error:run.error,result:run.result}));
  assert(run.result.text.includes(fileName),run.result.text);
  const trace=probe('ai_schedules_run_events',{runId:run.runId});
  const generations=trace.events.filter(event=>event.type==='generationResult').map(event=>event.generation);
  assert(generations.length>=2,'Model must call tools and then produce a fresh response');
  assert(generations.every(g=>g.billingScope==='personal'&&g.channelId===channel.id&&g.selectedModel==='deepseek-flash'&&g.inputTokens>0&&g.outputTokens>0));
  for(const tool of ['workspace_status','workspace_gis_files_list'])assert(trace.events.some(e=>e.type==='toolResult'&&e.tool===tool),'Fresh native tool missing: '+tool);
  assert(trace.events.some(e=>e.type==='toolResult'&&e.tool==='workspace_gis_files_list'&&JSON.stringify(e.result).includes(fileName)));
  writeFileSync(join(root,`trace-${phase}-${run.runId}.json`),JSON.stringify(trace,null,2));
  const result={runId:run.runId,scheduleId:run.scheduleId,scheduledAt:run.scheduledAt,startedAt:run.startedAt,finishedAt:run.finishedAt,attempt:run.attempt,
    inputTokens:generations.reduce((sum,g)=>sum+g.inputTokens,0),outputTokens:generations.reduce((sum,g)=>sum+g.outputTokens,0),generationIds:generations.map(g=>g.generationId)};
  completedRuns.push(result);return result;
}
async function create(name,nextRunAt,repeatSeconds,prompt){
  const draft={conversationId,name,prompt,nextRunAt,repeatSeconds,executionId:randomUUID(),history:[]};
  const value=probe('ai_schedules_create',draft);assert.equal(value.modelRoute.channel.id,channel.id);schedules.push(value);return {value,draft};
}
async function idle(){await wait(()=>probe().activeAiTurns===0,'own native AI becomes idle',20000);}
try{
  server=createGatewayServer(config,{fetchImpl});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  identityOrigin='http://127.0.0.1:'+server.address().port;
  credential('seed',{identity_origin:identityOrigin,access_token:token,refresh_token:randomBytes(32).toString('base64url'),user_id:account,access_expires_at:Math.floor(Date.now()/1000)+3600});
  await launch();
  const workspace=join(root,'workspace');mkdirSync(workspace);
  const fileName='真实周期-'+randomBytes(5).toString('hex')+'.geojson';
  const contents=JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:fileName},geometry:{type:'Polygon',coordinates:[[[116,40],[116.01,40],[116.01,40.01],[116,40.01],[116,40]]]}}]});
  writeFileSync(join(workspace,fileName),contents);const workspaceSha=createHash('sha256').update(contents).digest('hex');
  // Use the real workspace picker so the new native binding is never redirected
  // from its immutable original directory or seeded in shared user Documents.
  const foreground=ownedProcess(child.pid);
  await page.locator('.conversation-sidebar-head').getByRole('button',{name:'添加工作区',exact:true}).click();
  const observed=await wait(()=>{const values=support('dialogs',foreground);return values.some(d=>d.text==='选择或创建文件夹作为 GeoD Agent 工作区')?values:null;},'actual owned folder dialog',20000);
  writeFileSync(join(root,'workspace-dialog-controls.json'),JSON.stringify(observed,null,2));
  support('select-folder',{...foreground,path:workspace});
  await wait(()=>!support('dialogs',foreground).length,'actual folder selection completes',20000);
  const active=page.locator('.conversation-item.active[data-conversation-id]');await active.waitFor({state:'attached'});conversationId=await active.getAttribute('data-conversation-id');assert(conversationId);
  const bound=await call('workspace_get',{conversationId});
  const canonical=value=>value.replace(/^\\\\\?\\/,'').toLowerCase();assert.equal(canonical(bound.directory),canonical(workspace));
  await call('workspace_set',{conversationId,directory:bound.directory,permission:'fullAccess'});
  channel=await call('ai_channel_save',{draft:{name:'稳定性验收 · DeepSeek',baseUrl:'https://api.deepseek.com/v1',protocol:'chatCompletions',enabled:true,apiKey:providerKey,
    models:[{id:'deepseek-flash',name:'DeepSeek Flash',contextWindow:128000,maxOutputTokens:2048,inputModalities:['text'],thinking:'enabled'}]}});
  assert(!JSON.stringify(channel).includes(providerKey));
  const keyAudit=support('channel-credentials',{channelId:channel.id});channelReferences=keyAudit.references;assert.equal(keyAudit.credentials.length,1);assert(keyAudit.credentials[0].credentialExists);
  await call('ai_model_select',{conversationId,channelId:channel.id,modelId:'deepseek-flash'});
  const prompt='这次是新的一轮核验，不沿用之前的工具结果。必须重新调用 workspace_status 和 workspace_gis_files_list，核对当前工作区。最后只简短列出工具实际发现的全部 GeoJSON 文件名。不修改文件，不下载，不安排其他任务。';
  const soak=await create('真实周期稳定性 · 每分钟',new Date(Date.now()+10000).toISOString(),60,prompt);
  const replay=probe('ai_schedules_create',soak.draft);assert.equal(replay.scheduleId,soak.value.scheduleId);
  let conflict;try{probe('ai_schedules_create',{...soak.draft,prompt:soak.draft.prompt+' 不同请求'});}catch(error){conflict=error;}
  assert.equal(conflict?.code,'AI_IDEMPOTENCY_CONFLICT');
  await closeWindow();
  const initialSample=support('sample',currentDaemon);assert.equal(initialSample.visibleWindows,0);assert.equal(initialSample.webviewChildren,0);
  casePassed('isolated-native-window-closes-while-personal-schedule-remains',{originalBackgroundPid:originalBefore.background.pid,qaBackgroundPid:currentDaemon.pid,visibleWindows:0,clockAndDueDatesUntouched:true});
  let seen=0,duplicateVerified=false,lastSample=0,lastProgress=0;
  const soakStarted=performance.now();
  while(seen<cycles){
    bounded();const runs=runsFor(soak.value.scheduleId).sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt));
    const terminal=runs.filter(isTerminal);
    while(seen<terminal.length){const result=validate(terminal[seen],fileName,'soak');seen++;console.log(JSON.stringify({phase:'closed-window-cycles',completed:seen,target:cycles,runId:result.runId}));save();}
    if(seen>=3&&!duplicateVerified){
      const endpointBefore=probe(),duplicate=remember(support('start-background',{exe,identityOrigin}));
      await wait(()=>!support('sample',duplicate).alive,'duplicate companion refuses the active lease',15000);
      assert.equal(probe().pid,endpointBefore.pid);assert.equal(probe().fingerprint,endpointBefore.fingerprint);duplicateVerified=true;
      assert.equal(support('snapshot').processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase()&&p.background).length,1);
      casePassed('duplicate-background-launch-does-not-replace-or-recover-live-worker',{activePid:currentDaemon.pid,rejectedPid:duplicate.pid});
    }
    if(performance.now()-lastSample>10000){const sample=support('sample',currentDaemon);assert(sample.alive);assert.equal(sample.visibleWindows,0);assert.equal(sample.webviewChildren,0);report.samples.push({elapsedSeconds:Math.round((performance.now()-soakStarted)/1000),completed:seen,...sample});lastSample=performance.now();save();}
    if(performance.now()-lastProgress>30000){console.log(JSON.stringify({phase:'closed-window-cycles',completed:seen,target:cycles,backgroundPid:currentDaemon.pid}));lastProgress=performance.now();}
    await sleep(1000);
  }
  probe('ai_schedules_set_enabled',{scheduleId:soak.value.scheduleId,enabled:false});await idle();
  const soakRuns=runsFor(soak.value.scheduleId).sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt));assert.equal(soakRuns.length,cycles);
  for(let i=0;i<soakRuns.length;i++){assert.equal(soakRuns[i].attempt,1);if(i)assert.equal(Date.parse(soakRuns[i].scheduledAt)-Date.parse(soakRuns[i-1].scheduledAt),60000);}
  assert.equal(new Set(soakRuns.map(r=>r.runId)).size,cycles);
  report.samples.push({elapsedSeconds:Math.round((performance.now()-soakStarted)/1000),completed:cycles,...support('sample',currentDaemon)});
  const warmed=report.samples.filter(s=>s.completed>=2),last=report.samples.at(-1),warm=warmed[0];assert(warm&&last);
  assert(last.privateBytes<=warm.privateBytes+128*1024*1024,'Unexpected native private-memory growth after warmup');
  assert(last.handles<=warm.handles+256,'Unexpected native handle growth after warmup');
  assert(last.children.length<=warm.children.length+1,'Unexpected retained model-child accumulation');
  casePassed('real-intervals-complete-with-fresh-model-tools-and-no-duplicates',{cycles,elapsedSeconds:Math.round((performance.now()-soakStarted)/1000),repeatSeconds:60,
    warmPrivateBytes:warm.privateBytes,lastPrivateBytes:last.privateBytes,warmHandles:warm.handles,lastHandles:last.handles,warmChildren:warm.children.length,lastChildren:last.children.length});
  // Record real future times, then actually leave the companion stopped. No DB edits.
  const missed=await create('真实停机 · 合并错过周期',new Date(Date.now()+10000).toISOString(),60,prompt);
  const once=await create('真实停机 · 一次性补执行',new Date(Date.now()+20000).toISOString(),null,prompt);
  const stopped=currentDaemon;probe('runtime_stop');await wait(()=>!support('sample',stopped).alive,'own idle daemon exits normally',15000);
  const offlineStarted=performance.now();let lastOffline=0;
  while(performance.now()-offlineStarted<offlineSeconds*1000){
    bounded();assert(!support('sample',stopped).alive,'The explicitly stopped daemon must stay stopped');
    assert.equal(support('snapshot').processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase()).length,0);
    if(performance.now()-lastOffline>30000){console.log(JSON.stringify({phase:'actual-offline',elapsedSeconds:Math.round((performance.now()-offlineStarted)/1000),targetSeconds:offlineSeconds}));lastOffline=performance.now();}
    await sleep(5000);
  }
  const actualOffline=performance.now()-offlineStarted;assert(actualOffline>=offlineSeconds*1000);
  await startBackground();
  const claimed=await wait(()=>runsFor(missed.value.scheduleId)[0]??null,'overdue occurrence is claimed',15000);
  probe('ai_schedules_set_enabled',{scheduleId:missed.value.scheduleId,enabled:false});
  const savedMissed=overview().schedules.find(s=>s.scheduleId===missed.value.scheduleId);
  assert.equal(claimed.scheduledAt,missed.value.nextRunAt);
  const skipped=(Date.parse(savedMissed.nextRunAt)-Date.parse(missed.value.nextRunAt))/60000;assert(skipped>=3&&Number.isInteger(skipped));
  assert(Date.parse(savedMissed.nextRunAt)>Date.parse(claimed.startedAt));
  const caught=validate(await finished(missed.value.scheduleId),fileName,'catchup'),one=validate(await finished(once.value.scheduleId),fileName,'once');
  assert.equal(runsFor(missed.value.scheduleId).length,1);assert.equal(runsFor(once.value.scheduleId).length,1);await idle();
  casePassed('actual-downtime-coalesces-missed-periods-and-runs-once-only',{actualOfflineSeconds:Math.round(actualOffline/1000),missedIntervals:skipped,
    originalDueAt:missed.value.nextRunAt,nextDueAt:savedMissed.nextRunAt,catchupRunId:caught.runId,onceRunId:one.runId,timestampsNeverModified:true});
  const previous=currentDaemon,ids=overview().runs.map(r=>r.runId).sort();probe('runtime_stop');await wait(()=>!support('sample',previous).alive,'second own idle exit',15000);await startBackground();
  await sleep(5000);assert.deepEqual(overview().runs.map(r=>r.runId).sort(),ids);assert(overview().runs.every(r=>r.state==='succeeded'));
  casePassed('normal-background-restart-preserves-results-without-replay',{previousPid:previous.pid,newPid:currentDaemon.pid,retainedRuns:ids.length});
  const crash=await create('异常退出 · 用户重试',new Date(Date.now()+10000).toISOString(),null,prompt);
  const live=await wait(()=>runsFor(crash.value.scheduleId).find(r=>r.state==='running')??null,'actual native run starts before deliberate crash',20000,100);
  const liveTrace=probe('ai_schedules_run_events',{runId:live.runId});writeFileSync(join(root,'trace-before-crash.json'),JSON.stringify(liveTrace,null,2));
  const crashed=currentDaemon,exited=support('terminate',crashed);assert(exited.ownedProcessExited);
  const persistedAtCrash=support('run-ledger',{runId:live.runId});assert.equal(persistedAtCrash.run.state,'running');
  assert.deepEqual(persistedAtCrash.events.slice(0,liveTrace.events.length),liveTrace.events);
  assert.deepEqual(persistedAtCrash.sequences,persistedAtCrash.sequences.map((_,i)=>i+1));
  writeFileSync(join(root,'persisted-at-crash.json'),JSON.stringify(persistedAtCrash,null,2));
  await startBackground();
  const interrupted=await wait(()=>runsFor(crash.value.scheduleId).find(r=>r.state==='interrupted')??null,'same run is marked interrupted on recovery',15000);
  assert.equal(interrupted.runId,live.runId);assert.equal(interrupted.error.code,'BACKGROUND_INTERRUPTED');assert.equal(interrupted.attempt,1);
  await sleep(15000);assert.equal(runsFor(crash.value.scheduleId).length,1);assert.equal(runsFor(crash.value.scheduleId)[0].state,'interrupted');assert.equal(probe().activeAiTurns,0);
  const recoveredTrace=probe('ai_schedules_run_events',{runId:live.runId});assert.deepEqual(recoveredTrace.events,persistedAtCrash.events);
  casePassed('crashed-run-is-preserved-for-explicit-retry-without-automatic-replay',{runId:live.runId,crashedPid:crashed.pid,recoveredPid:currentDaemon.pid,
    retainedEvents:persistedAtCrash.events.length,observationSeconds:15,descendantsAtCrash:exited.descendantsAtTermination});
  probe('ai_schedules_retry_run',{runId:live.runId});
  const retried=validate(await finished(crash.value.scheduleId),fileName,'retry');assert.equal(retried.runId,live.runId);assert.equal(retried.attempt,2);
  const finalTrace=probe('ai_schedules_run_events',{runId:live.runId});assert.deepEqual(finalTrace.events.slice(0,persistedAtCrash.events.length),persistedAtCrash.events);
  assert.equal(runsFor(crash.value.scheduleId).length,1);await idle();
  casePassed('explicit-retry-uses-the-existing-run-and-appends-real-tool-results',{runId:live.runId,attempt:2,eventsBefore:persistedAtCrash.events.length,eventsAfter:finalTrace.events.length});
  await launch();
  const screen=page.locator('.schedules-page:not([hidden])');await page.locator('.conversation-sidebar-head').getByRole('button',{name:'定时任务',exact:true}).click();
  await screen.waitFor();await screen.locator('[aria-busy="false"]').waitFor();
  for(const schedule of schedules)assert.equal(await screen.locator(`[data-schedule-id="${schedule.scheduleId}"]`).count(),1);
  await screen.locator(`[data-schedule-id="${soak.value.scheduleId}"] .schedules-row-title`).click();
  const details=screen.locator('.schedules-detail');await details.locator('.schedule-item').waitFor();
  assert((await details.locator('.schedule-history summary').textContent()).includes(String(cycles)));
  await details.locator('.ai-run-controls .schedule-run-row').click();await details.locator('.ai-run-result .geod-message-body').waitFor();
  assert((await details.locator('.ai-run-result .geod-message-body').textContent()).includes(fileName));
  await page.screenshot({path:join(root,'actual-native-completed-schedules.png')});
  assert.equal((report.rendererErrors??[]).length,0);assert.equal(await screen.getByRole('alert').count(),0);
  assert.equal(createHash('sha256').update(readFileSync(join(workspace,fileName))).digest('hex'),workspaceSha);
  assert.equal(upstreamCalls,0);
  casePassed('reopened-native-ui-shows-real-history-and-result-with-original-input-preserved',{schedules:schedules.length,runs:cycles+3,workspaceSha256:workspaceSha,hostedUpstreamCalls:0});
  report.completedRuns=completedRuns;report.totalInputTokens=completedRuns.reduce((sum,r)=>sum+r.inputTokens,0);report.totalOutputTokens=completedRuns.reduce((sum,r)=>sum+r.outputTokens,0);
  report.finishedAt=new Date().toISOString();report.elapsedSeconds=Math.round((performance.now()-started)/1000);report.passed=true;save();
}catch(error){report.failure=error.stack??JSON.stringify(error);save();if(page&&!page.isClosed())await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});throw error;}
finally{
  const cleanup={passed:false};
  try{
    if(identityOrigin){
      if(!page||page.isClosed())await launch();
      for(const schedule of schedules)await call('ai_schedules_set_enabled',{scheduleId:schedule.scheduleId,enabled:false}).catch(()=>{});
      if(conversationId)for(const run of (await call('ai_schedules_list',{conversationId})).runs.filter(r=>!isTerminal(r)))await call('ai_schedules_cancel_run',{runId:run.runId}).catch(()=>{});
      if(channel){await call('ai_channel_remove',{channelId:channel.id});const keys=support('channel-credentials',{channelId:channel.id,references:channelReferences});assert.equal(keys.references.length,0);assert(keys.credentials.every(c=>!c.credentialExists));cleanup.personalCredentialRemoved=true;}
      await wait(()=>probe().activeAiTurns===0,'own executions stop for cleanup',30000).catch(()=>{});
      await call('background_stop').catch(()=>{});
    }else cleanup.fixtureNotStarted=true;
  }catch(error){cleanup.cleanupFailure=error.stack??JSON.stringify(error);}
  await browser?.close().catch(()=>{});
  // Setup may fail before the foreground has read back its newly spawned daemon.
  for(const value of support('snapshot').processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase()))remember(value);
  for(const value of [...owned].reverse())support('terminate',value);
  if(identityOrigin)cleanup.identity=credential('delete',{identity_origin:identityOrigin});
  await new Promise(resolve=>server?server.close(resolve):resolve());
  const after=support('snapshot');assert.deepEqual(after.processes,beforeProcesses.processes);assert.deepEqual(after.startup,beforeProcesses.startup);
  const originalAfter=await originalState();assert.deepEqual(originalAfter,originalBefore);await originalBrowser.close();
  Object.assign(cleanup,{passed:!cleanup.cleanupFailure,originalProcessesPreserved:true,originalStartupPreserved:true,originalStatePreserved:true,
    originalConversations:originalAfter.chatCount,originalChatSha256:originalAfter.chatSha256,originalBackgroundPid:originalAfter.background.pid});
  writeFileSync(join(root,'cleanup.json'),JSON.stringify(cleanup,null,2));assert(cleanup.passed,'Scoped QA cleanup must finish');
  console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,completedModelRuns:completedRuns.length,elapsedSeconds:report.elapsedSeconds,originalConversations:cleanup.originalConversations}));
}
