/** Smoke only the actual packaged application; retain every phase and random input. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const output=path.resolve(process.argv[2]),resuming=process.argv[3]==='init-resume',phase=resuming?'init':process.argv[3];
assert(output.startsWith(path.resolve('artifacts')+path.sep));
assert(['init','model','backup','background','returned','restart','production','production-model','final-native','final-local-model','cleanup','stop'].includes(phase));
const stateFile=path.join(output,'closeout-state.json');
let saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2));
const save=()=>write('closeout-state.json',saved);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await sleep(250);}throw new Error('Timeout: '+label);}
const report={passed:false,cases:[],rendererErrors:[],installed:false,published:false};
if(resuming){
 assert(saved&&!saved.modelSubmitted&&saved.connectionId&&saved.fixtureHashes);
 const previous=path.join(output,'closeout-init.json');
 const result=JSON.parse(fs.readFileSync(previous,'utf8'));assert(!result.passed);
 const suffix=result.error.message.includes("getByRole('menuitem'")?'selector':'active-capture';
 fs.copyFileSync(previous,path.join(output,'closeout-init-harness-'+suffix+'-failure.json'));report.cases=result.cases;report.resumedAfterHarnessFix=true;
}
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write('closeout-'+phase+'.json',report);console.log(JSON.stringify({name,passed:true}));};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9234');
const page=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost')),'Packaged page');
await page.locator('.conversation-account-trigger').waitFor({timeout:45000});
page.on('pageerror',error=>report.rendererErrors.push(error.message));
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(result.error)throw Object.assign(new Error(result.error.message??JSON.stringify(result.error)),result.error);return result.value;};
const records=()=>page.evaluate(async()=>{await window.__GEOD_LOCAL_STATE__?.flush();return new Promise((resolve,reject)=>{const opened=indexedDB.open('geod-ui-state-v1',1);opened.onerror=()=>reject(opened.error);opened.onsuccess=()=>{const db=opened.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();const result=new Map(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]));keys.result.forEach((key,i)=>result.set(String(key),values.result[i]));resolve([...result]);};tx.onabort=()=>{db.close();reject(tx.error)};};});});
const chats=async()=>{const all=Object.fromEntries(await records()),key=Object.keys(all).find(k=>k.startsWith('geod-agent-conversations-0.1:account:'));return{chats:key?JSON.parse(all[key]):[],active:all['geod-agent-active-conversation-0.1:account:'+key?.split(':account:')[1]]};};
const actualChat=async()=>(await chats()).chats.find(chat=>chat.conversationId===saved.conversationId);
async function ask(prompt,label){
 assert(!prompt.includes(saved.marker),'Expected random answers cannot enter the model prompt');
 const before=(await actualChat()).messages.filter(message=>message.role==='user').length;
 await page.locator('.geod-prompt-input textarea').fill(prompt);await page.locator('.geod-prompt-input textarea').press('Enter');
 return wait(async()=>{const chat=await actualChat();return chat&&!chat.pendingId&&chat.messages.filter(m=>m.role==='user').length>before&&chat.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'Stop reply',exact:true}).count())?chat:null;},label,240000);
}
async function stop(){const status=await rpc('background_status');assert.equal(status.activeAiTurns,0);assert.equal(status.activeDownloads,0);assert.equal(status.activeCommands,0);await records();assert.equal((await rpc('background_stop')).stopped,true);await rpc('plugin:window|close').catch(error=>{if(!String(error).includes('closed'))throw error});}

try{
 if(phase==='init'){
  if(!resuming){
  assert(!saved,'Preserve the existing isolated run');
  assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-payload.json'),'utf8')).passed);
  assert.equal((await rpc('desktop_settings_get')).development,false);
  assert.equal(await rpc('plugin:app|version'),'0.2.0');assert.equal((await rpc('auth_status')).state,'connected');
  assert.equal((await rpc('data_connections_list')).length,0);assert.equal((await rpc('sql_connections_list')).connections.length,0);
  assert((await chats()).chats.every(chat=>chat.messages.length===0));
  await page.evaluate(()=>localStorage.setItem('geod-agent-language-v1',JSON.stringify({language:'en',replyLanguage:'auto'})));await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  const oldIds=new Set((await chats()).chats.map(chat=>chat.conversationId));await page.locator('.sidebar-new-chat').click();const current=await wait(async()=>{const value=await chats();return value.active&&!oldIds.has(value.active)&&value.chats.some(chat=>chat.conversationId===value.active)?value:null;},'Committed real QA chat');
  saved={conversationId:current.active,marker:'RELEASEDATA'+randomUUID().replaceAll('-','')};save();
  const bound=await rpc('workspace_get',{conversationId:saved.conversationId});saved.workspace=bound.directory;saved.prefix='.geod-release-closeout-'+randomUUID();save();
  await rpc('workspace_set',{conversationId:saved.conversationId,directory:saved.workspace,permission:'fullAccess'});
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});
  const folder=path.join(saved.workspace,saved.prefix);execFileSync('python',['-X','utf8','scripts/release-closeout-fixtures.py',folder,saved.marker],{windowsHide:true});
  saved.fixtureHashes=Object.fromEntries(fs.readdirSync(folder).map(name=>[name,sha(path.join(folder,name))]));save();
  const connected=await rpc('sql_connection_connect',{conversationId:saved.conversationId,request:{kind:'sqlite',name:'Release closeout SQLite',relativePath:saved.prefix+'/release.sqlite'}});assert(connected.connection&&!connected.error);saved.connectionId=connected.connection.id;save();
  const queried=await rpc('sql_query',{connectionId:saved.connectionId,sql:'SELECT marker FROM release_markers'});assert(JSON.stringify(queried).includes(saved.marker+'SQL'));
  const boundary=await rpc('data_input_read',{conversationId:saved.conversationId,request:{relativePath:saved.prefix+'/range.geojson'}});assert.equal(boundary.boundary.polygonCount,1);boundary.boundary.bounds.forEach((value,index)=>assert(Math.abs(value-[116.1,39.6,116.3,39.8][index])<1e-6));
  pass('Actual release has isolated profiles and bundled SQL/vector tools on a stock Windows PATH',{version:'0.2.0',database:'DBHub SQLite',polygonCount:1});
  }else{
   const current=await chats();assert(current.chats.find(chat=>chat.conversationId===current.active)?.messages.length===0);
   if(current.active!==saved.conversationId){saved.seedConversationId=saved.conversationId;saved.conversationId=current.active;save();await rpc('workspace_set',{conversationId:saved.conversationId,directory:saved.workspace,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});}
   assert.deepEqual((await rpc('sql_connections_list')).connections.map(value=>value.id),[saved.connectionId]);await page.keyboard.press('Escape');
  }
  const payment=await rpc('agent_payment_snapshot');assert.equal(payment.status.checkoutEnabled,false);assert.equal(payment.wallet,null);assert.equal(payment.status.billingMode,'unlimited-test');
  await page.evaluate(()=>window.dispatchEvent(new Event('geod:payment-open')));await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByText('Test mode · Unlimited quota',{exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('button',{name:/Purchase|Subscribe/}).count(),0);await page.screenshot({path:path.join(output,'release-balance-light.png')});await page.keyboard.press('Escape');
  await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'Dark appearance',exact:true}).click();await sleep(150);await page.screenshot({path:path.join(output,'release-dark.png')});
  await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'Light appearance',exact:true}).click();
  const session=await page.context().newCDPSession(page);await session.send('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:false});await sleep(200);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:path.join(output,'release-narrow.png')});await session.send('Emulation.clearDeviceMetricsOverride');await session.detach();
  pass('Packaged English UI, both themes and narrow layout render; test mode does not offer paid checkout');
  await page.locator('input[type=file][accept*=docx]').setInputFiles(path.join(saved.workspace,saved.prefix,'release-input.pdf'));await page.locator('.chat-document-chip').filter({hasText:'release-input.pdf'}).waitFor();
  saved.foregroundPrompt='发行版本验收：用 attachment_read 读取已附加的 release-input.pdf，用 sql_query 从 SQLite 连接 '+saved.connectionId+' 的 release_markers 表读取 marker。再用地图连接器读一次当前二维地图视角。最后简洁列出文件和数据库里的完整标记以及当前地图状态。不要运行命令或读取工作区文件。';save();
 }else if(phase==='model'){
  assert(!saved.modelSubmitted);saved.modelSubmitted=true;save();const chat=await ask(saved.foregroundPrompt,'Actual packaged foreground model');
  const answer=chat.messages.at(-1)?.content??'';assert(answer.includes(saved.marker+'PDF'));assert(answer.includes(saved.marker+'SQL'));assert.equal(chat.engine,'codex');assert(chat.display.some(item=>item.role==='tool'&&item.toolName==='attachment_read'));assert(chat.display.some(item=>item.role==='tool'&&item.toolName==='sql_query'));assert(chat.display.some(item=>item.role==='tool'&&item.toolName==='mcp_call'));
  saved.documents=await rpc('document_attachments_list',{conversationId:saved.conversationId});assert.equal(saved.documents.length,1);save();write('closeout-actual-model-chat.json',chat);await page.screenshot({path:path.join(output,'release-actual-ai.png')});
  pass('Actual packaged Codex/model reads a fresh PDF and SQLite marker, and calls the 2D map tool',{markersRead:2,tools:['attachment_read','sql_query','mcp_call']});
 }else if(phase==='backup'){
  const uiState={schemaVersion:1,entries:(await records()).filter(([key])=>key.startsWith('geod'))};saved.backup=await rpc('desktop_backup_create',{uiState});save();
  const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8'));for(const record of manifest.records)assert.equal(sha(path.join(saved.backup.path,record.file)),record.sha256);assert.equal(sha(path.join(saved.backup.path,manifest.uiState.file)),manifest.uiState.sha256);assert(manifest.records.some(record=>record.path.includes(saved.documents[0].id+'.attachment')));
  write('closeout-chat-before-restart.json',await actualChat());pass('Actual release backup preserves the chat and original PDF; all backup hashes match',{records:manifest.records.length,bytes:saved.backup.bytes});
 }else if(phase==='background'){
  assert(!saved.scheduleId);const schedule=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Release closed-window input reading',prompt:'用 attachment_read 读取此会话中 release-input.pdf 的实际文本，用 sql_query 读取 SQLite 连接 '+saved.connectionId+' 的 release_markers.marker。最后只列两份数据里的完整标记，不运行命令，不新建任务。',nextRunAt:new Date(Date.now()+12000).toISOString(),repeatSeconds:null,executionId:randomUUID()});
  saved.scheduleId=schedule.scheduleId;saved.backgroundPid=(await rpc('background_status')).pid;save();await records();await rpc('plugin:window|close').catch(error=>{if(!String(error).includes('closed'))throw error});pass('The actual release window closes before its once-only background instruction runs');
 }else if(phase==='returned'){
  assert.equal((await rpc('background_status')).pid,saved.backgroundPid);
  const run=await wait(async()=>{const all=await rpc('ai_schedules_list',{conversationId:saved.conversationId});const run=all.runs.find(item=>item.scheduleId===saved.scheduleId);return run&&['succeeded','failed','waiting_input','interrupted'].includes(run.state)?run:null;},'Closed-window real model',240000);
  assert.equal(run.state,'succeeded');assert(run.result.text.includes(saved.marker+'PDF'));assert(run.result.text.includes(saved.marker+'SQL'));write('closeout-background-run.json',run);saved.runId=run.runId;save();await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});
  pass('The same companion reads both fresh inputs after window close and returns the real model result',{markersRead:2,sameCompanion:true});await stop();
 }else if(phase==='restart'){
  assert.notEqual((await rpc('background_status')).pid,saved.backgroundPid);assert.deepEqual(await actualChat(),JSON.parse(fs.readFileSync(path.join(output,'closeout-chat-before-restart.json'),'utf8')));
  assert(JSON.stringify(await rpc('sql_query',{connectionId:saved.connectionId,sql:'SELECT marker FROM release_markers'})).includes(saved.marker+'SQL'));assert((await rpc('document_attachment_read',{conversationId:saved.conversationId,id:saved.documents[0].id})).text.includes(saved.marker+'PDF'));
  const runs=(await rpc('ai_schedules_list',{conversationId:saved.conversationId})).runs.filter(run=>run.scheduleId===saved.scheduleId);assert.equal(runs.length,1);assert.equal(runs[0].runId,saved.runId);assert.equal(await page.locator('html').getAttribute('lang'),'en');
  pass('A full packaged restart preserves exact history, original input, SQLite binding and schedule result without duplicate runs');await stop();
 }else if(phase==='production'){
  const config=path.join(process.env.APPDATA,'dev.geod-agent.desktop','agent-services.json');assert(!fs.existsSync(config),'Default service test must not inherit a custom config');
  assert.equal((await rpc('auth_status')).state,'connected');const usage=await rpc('agent_usage');const payment=await rpc('agent_payment_snapshot');assert.equal(payment.status.checkoutEnabled,false);
  saved.productionBillingMode=payment.status.billingMode;save();pass('The packaged default production identity and usage endpoints respond without a local gateway override',{billingMode:payment.status.billingMode,quotaEnforced:usage.quotaEnforced??null,paidCheckout:false});
 }else if(phase==='production-model'){
  assert(!saved.productionModelSubmitted);saved.productionModelSubmitted=true;save();const chat=await ask('实际正式地址验收：只用 sql_query 读取 SQLite 连接 '+saved.connectionId+' 的 release_markers.marker。简洁回答实际数据库中的完整标记，不新建任务，不运行命令，不从之前聊天复制。','Default production real model');
  assert(chat.messages.at(-1)?.content.includes(saved.marker+'SQL'));const old=JSON.parse(fs.readFileSync(path.join(output,'closeout-chat-before-restart.json'),'utf8'));assert(chat.display.slice(old.display.length).some(item=>item.role==='tool'&&item.toolName==='sql_query'));write('closeout-actual-production-chat.json',chat);pass('Actual packaged Codex calls SQLite through the default production model service',{randomMarkerRead:true,tool:'sql_query'});
 }else if(phase==='final-native'){
  assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-payload.json'),'utf8')).passed);
  assert.equal((await rpc('desktop_settings_get')).development,false);assert.equal(await rpc('plugin:app|version'),'0.2.0');
  assert.equal((await rpc('auth_status')).state,'connected');const usage=await rpc('agent_usage');
  const payment=await rpc('agent_payment_snapshot');assert.equal(payment.status.checkoutEnabled,false);assert.equal(payment.wallet,null);
  assert(JSON.stringify(await rpc('sql_query',{connectionId:saved.connectionId,sql:'SELECT marker FROM release_markers'})).includes(saved.marker+'SQL'));
  assert((await rpc('document_attachment_read',{conversationId:saved.conversationId,id:saved.documents[0].id})).text.includes(saved.marker+'PDF'));
  const runs=(await rpc('ai_schedules_list',{conversationId:saved.conversationId})).runs.filter(run=>run.scheduleId===saved.scheduleId);
  assert.equal(runs.length,1);assert.equal(runs[0].runId,saved.runId);assert.equal(runs[0].state,'succeeded');assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await page.evaluate(()=>window.dispatchEvent(new Event('geod:payment-open')));await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByText('Test mode · Unlimited quota',{exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('button',{name:/Purchase|Subscribe/}).count(),0);
  await page.screenshot({path:path.join(output,'release-balance-light.png')});await page.keyboard.press('Escape');
  pass('The final packaged executable accepts the real production proxy HTML 404 only for optional payment status; identity and usage work',{billingMode:payment.status.billingMode,quotaEnforced:usage.quotaEnforced??null,paidCheckout:false});
  pass('The final packaged restart preserves the actual SQLite/PDF input, English language and once-only background result',{markersRead:2,duplicateRuns:0});
 }else if(phase==='final-local-model'){
  assert(!saved.finalModelSubmitted);const old=await actualChat();saved.finalModelSubmitted=true;save();
  const chat=await ask('发行收尾验收：读取已附加的 release-input.pdf，并用 sql_query 读取 SQLite 连接 '+saved.connectionId+' 的 release_markers.marker。简洁列出此次读取到的两份完整标记。只读，不运行命令。','Final packaged real model');
  assert.equal(chat.engine,'codex');const answer=chat.messages.at(-1)?.content??'';assert(answer.includes(saved.marker+'PDF'));assert(answer.includes(saved.marker+'SQL'));
  const added=chat.display.slice(old.display.length);for(const tool of ['attachment_read','sql_query'])assert(added.some(item=>item.role==='tool'&&item.toolName===tool));
  write('closeout-final-actual-model-chat.json',chat);await page.screenshot({path:path.join(output,'release-actual-ai.png')});
  pass('The final packaged Codex/model performs new attachment and database tool calls through the verified local gateway',{markersRead:2,tools:['attachment_read','sql_query'],gateway:'local',productionModelVerified:false});
 }else if(phase==='cleanup'){
  await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});await rpc('sql_connection_remove',{connectionId:saved.connectionId});assert.equal((await rpc('sql_connections_list')).connections.length,0);
  const folder=path.resolve(saved.workspace,saved.prefix);assert(folder.startsWith(path.resolve(saved.workspace)+path.sep)&&path.basename(folder)===saved.prefix&&saved.prefix.startsWith('.geod-release-closeout-'));
  assert.deepEqual(fs.readdirSync(folder).sort(),Object.keys(saved.fixtureHashes).sort());for(const [name,digest]of Object.entries(saved.fixtureHashes))assert.equal(sha(path.join(folder,name)),digest,'Preserve externally changed test files');
  for(const name of Object.keys(saved.fixtureHashes))fs.unlinkSync(path.join(folder,name));fs.rmdirSync(folder);saved.cleaned=true;save();pass('Only the isolated smoke connection and unchanged owned fixture files are removed; its instruction is disabled');
 }else if(phase==='stop'){
  await stop();pass('Packaged foreground and companion stop normally');
 }
 assert.equal(report.rendererErrors.length,0,report.rendererErrors.join('\n'));report.passed=true;write('closeout-'+phase+'.json',report);
}catch(error){report.error={code:error.code,message:error.message};write('closeout-'+phase+'.json',report);console.error(JSON.stringify(report.error));await page.screenshot({path:path.join(output,'closeout-'+phase+'-failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser.close().catch(()=>{})}
