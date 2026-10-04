// Real release Rust binary + WebView IPC + loopback gateway + Windows credential.
// Requires a QA build with identifier dev.geod-agent.credit-history-qa and remote
// embedded frontend with normal local capabilities. Never launch the shipping identifier.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGatewayServer,readConfig} from '../../../services/geod-agent-model-gateway/server.mjs';
import {createPaymentLedgerCandidate} from '../../../services/geod-agent-model-gateway/payment-ledger-candidate.mjs';

const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/credit-history-native-20261004');mkdirSync(output,{recursive:true});
const helper=resolve('test/credit-history-native-support.py'),exe=resolve('src-tauri/target/release/geod-agent-desktop.exe');
const qaConfig=JSON.parse(readFileSync(join(output,'tauri-qa.json'),'utf8'));
assert.equal(qaConfig.identifier,'dev.geod-agent.credit-history-qa');
assert.equal(qaConfig.app.windows[0].url,undefined,'Use the packaged local frontend with normal capabilities');
assert.equal(qaConfig.app.security,undefined,'Do not change the default capabilities');
assert(readFileSync(exe).includes(Buffer.from(qaConfig.identifier)),'The binary must contain the isolated QA identifier');
const support=(action,value={})=>{
  const result=spawnSync('python',['-X','utf8',helper,action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
};
const checks=[],rendererErrors=[],owned=[];
const originalProcesses=support('snapshot');assert(!originalProcesses.processes.some(p=>p.exe.toLowerCase()===exe.toLowerCase()));
assert.equal(originalProcesses.startup['GeoD Agent'],null,'Shared autostart must remain disabled during isolated QA');
const originalBrowser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const originalPage=originalBrowser.contexts().flatMap(ctx=>ctx.pages()).find(p=>p.url()==='http://127.0.0.1:1420/');assert(originalPage);
async function existingState(){
  const value=await originalPage.evaluate(async()=>{
    await window.__GEOD_LOCAL_STATE__?.flush();
    const records=await new Promise((resolve,reject)=>{
      const open=indexedDB.open('geod-ui-state-v1',1);open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{const db=open.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();
        tx.oncomplete=()=>{db.close();const items=Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]));keys.result.forEach((k,i)=>items[k]=values.result[i]);resolve(items);};tx.onabort=()=>reject(tx.error);};
    });
    const key=Object.keys(records).find(k=>k.startsWith('geod-agent-conversations-0.1:account:'));if(!key)throw new Error('Existing account history unavailable');
    const chats=JSON.parse(records[key]),{api}=await import('/src/api.ts');
    return {chats:chats.map(c=>({conversationId:c.conversationId,title:c.title??null,messages:c.messages,display:c.display,planId:c.planId??null,planIds:c.planIds??[]})),
      active:records['geod-agent-active-conversation-0.1:account:'+key.split(':account:')[1]],payment:await api.agentPaymentSnapshot(),background:await api.backgroundStatus()};
  });
  return {chatCount:value.chats.length,chatSha256:createHash('sha256').update(JSON.stringify(value.chats)).digest('hex'),active:value.active,payment:value.payment,background:value.background};
}
const before=await existingState();
const root=join(output,'fixture-'+randomBytes(8).toString('hex'));mkdirSync(root);
const token=randomBytes(32).toString('base64url'),account='credit-history-native-fixture',generations=new Map();
const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'isolated-native-fixture',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'model.sqlite')});
let at=Date.now(),server,browser,page,child,identityOrigin,fault=null,upstreamCalls=0;
const seed=createPaymentLedgerCandidate(config.dbPath+'-credits.sqlite',{welcomeCredit:config.welcomeCredit,loadGeneration:(_account,id)=>generations.get(id),now:()=>at});
seed.grantWelcome(account);
for(let i=0;i<138;i++){
  const generationId='native-history-'+String(i).padStart(3,'0'),value={generationId,state:'reserved',model:'deepseek-flash',billingScope:'hosted'};
  generations.set(generationId,value);at=Date.now()-(i===0?60:1)*86_400_000;
  await seed.reserveGeneration(account,generationId,'100000000');
  if(i<137){Object.assign(value,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:10});await seed.settleGeneration(account,generationId);}
}
seed.close();
const fetchImpl=async(url,options)=>{
  if(!url.endsWith('/api/geod/oauth/introspect')){upstreamCalls++;throw new Error('Actual model requests are forbidden in this fixture');}
  return Response.json({active:JSON.parse(options.body).token===token?{userId:account,clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}:null});
};
async function startGateway(port=0){
  server=createGatewayServer(config,{fetchImpl});
  server.prependListener('request',(req,res)=>{
    if(!req.url.startsWith('/v1/payments/history/'))return;
    const injected=fault;fault=null;if(!injected)return;
    const write=res.writeHead.bind(res);
    res.writeHead=(status,headers)=>write(injected==='missing'?404:status,{...headers,
      ...(injected==='bad-digest'?{'x-geod-statement-sha256':'0'.repeat(64)}:{}),
      ...(injected==='missing'?{'content-type':'text/html'}:{})});
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return server.address().port;
}
async function waitForCdp(){
  for(let i=0;i<60;i++){
    try{const res=await fetch('http://127.0.0.1:9235/json/list');if(res.ok&& (await res.json()).some(item=>item.type==='page'))return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Isolated native WebView did not become available');
}
async function launch(){
  child=spawn(exe,[],{env:{...process.env,GEOD_AGENT_IDENTITY_ORIGIN:identityOrigin,GEOD_AGENT_GATEWAY_ORIGIN:identityOrigin,
    GEOD_AGENT_DEV_GATEWAY_ORIGIN:undefined,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9235'},
    cwd:resolve('src-tauri/target/release'),windowsHide:true,stdio:['ignore',openSync(join(root,'desktop.log'),'a'),openSync(join(root,'desktop-errors.log'),'a')]});
  child.on('error',()=>{});await waitForCdp();
  const live=support('snapshot').processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase());
  for(const p of live)if(!owned.some(old=>old.pid===p.pid&&old.created===p.created))owned.push(p);
  assert(live.some(p=>!p.background));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9235');
  page=browser.contexts().flatMap(ctx=>ctx.pages()).find(p=>/^https?:\/\/tauri\.localhost\/?/.test(p.url()));assert(page);
  page.on('pageerror',error=>rendererErrors.push(error.message));page.setDefaultTimeout(15000);
  await page.locator('.conversation-account-trigger').waitFor();
  const status=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('auth_status'));
  assert.equal(status.state,'connected',JSON.stringify(status));assert.equal(status.userId,account);
  assert(await page.evaluate(()=>!!window.__TAURI_INTERNALS__?.invoke));
  const background=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('background_status'));
  assert.equal(background.running,true);
  const ready=support('snapshot').processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase());
  assert(ready.some(p=>p.background&&p.pid===background.pid));
  for(const p of ready)if(!owned.some(old=>old.pid===p.pid&&old.created===p.created))owned.push(p);
  return background;
}
async function call(command,args){
  const result=await page.evaluate(async({command,args})=>{
    try{return {value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {error};}
  },{command,args});
  if('error' in result)throw result.error;return result.value;
}
async function openUsage(){
  await page.locator('.conversation-account-trigger').click();
  await page.locator('.conversation-account-menu').getByRole('button',{name:'余额与订阅',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('tab',{name:'AI 用量',exact:true}).click();
  await dialog.getByText('第 1–20 条，共 137 条',{exact:true}).waitFor();return dialog;
}
async function save(query,path){
  const result=await call('agent_credit_history_export',{query,path}),data=readFileSync(path);
  assert.equal(createHash('sha256').update(data).digest('hex'),result.sha256);assert.equal(data.length,result.bytes);return result;
}
try{
  const port=await startGateway();identityOrigin='http://127.0.0.1:'+port;
  support('seed',{identity_origin:identityOrigin,access_token:token,refresh_token:randomBytes(32).toString('base64url'),user_id:account,access_expires_at:Math.floor(Date.now()/1000)+3600});
  const background=await launch();
  assert.notEqual(background.pid,before.background.pid);checks.push('QA window uses a separate native profile, credential and background process');
  const dialog=await openUsage(),first=await dialog.locator('[data-charge-id]').evaluateAll(els=>els.map(el=>el.dataset.chargeId));assert.equal(first.length,20);
  await dialog.getByRole('button',{name:'下一页用量',exact:true}).click();await dialog.getByText('第 21–40 条，共 137 条',{exact:true}).waitFor();
  const second=await dialog.locator('[data-charge-id]').evaluateAll(els=>els.map(el=>el.dataset.chargeId));assert(second.every(id=>!first.includes(id)));
  await dialog.getByRole('button',{name:'上一页用量',exact:true}).click();await dialog.getByText('第 1–20 条，共 137 条',{exact:true}).waitFor();
  assert.deepEqual(await dialog.locator('[data-charge-id]').evaluateAll(els=>els.map(el=>el.dataset.chargeId)),first);
  checks.push('Actual release WebView reads 137 records through Rust IPC, paginates and restores the previous page');
  const select=async(name,label)=>{await dialog.getByRole('combobox',{name,exact:true}).click();await page.getByRole('option',{name:label,exact:true}).click();};
  await select('用量时间范围','最近 30 天');await dialog.getByText('第 1–20 条，共 136 条',{exact:true}).waitFor();
  await select('用量状态','费用预留');await dialog.getByText('第 1–1 条，共 1 条',{exact:true}).waitFor();
  assert.equal(await dialog.locator('[data-reservation-id]').count(),1);await select('用量状态','已结算用量');
  await dialog.getByText('第 1–20 条，共 136 条',{exact:true}).waitFor();
  await dialog.locator('.payment-usage-details').first().getByText('计费明细',{exact:true}).click();
  await page.screenshot({path:join(output,'actual-native-history.png')});
  checks.push('Native UI date filtering, reservations and collapsed billing details show real ledger records');
  await dialog.getByRole('button',{name:'导出 CSV',exact:true}).click();
  let picker;
  for(let i=0;i<40;i++){
    const windows=support('dialogs',{pid:child.pid});
    if(windows.length){picker=windows;break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert(picker);writeFileSync(join(output,'save-dialog-controls.json'),JSON.stringify(picker,null,2));
  const uiExport=join(root,'系统保存窗口导出.csv');
  support('save-dialog',{pid:child.pid,path:uiExport});
  await dialog.getByText('已导出 136 条记录',{exact:true}).waitFor();
  const uiCsv=readFileSync(uiExport,'utf8');assert.equal(uiCsv.split('\r\n').filter(Boolean).length,137);
  assert(!uiCsv.includes('native-history-000'));checks.push('Actual Export CSV button opens the Windows save dialog and saves all 136 filtered records through the native bridge');
  const now=Date.now(),query={kind:'usage',from:now-30*86400000,to:now+1},csv=join(output,'原生用量记录.csv');
  const saved=await save(query,csv);assert.equal(saved.records,136);assert(!readFileSync(csv,'utf8').includes('native-history-000'));
  checks.push('Actual Rust native streaming saves all 136 filtered records with Chinese file name and verifies exact length and SHA-256');
  fault='bad-digest';const previous=readFileSync(csv);let exportError;
  try{await call('agent_credit_history_export',{query,path:csv});}catch(error){exportError=error;}
  assert.equal(exportError?.code,'PAYMENT_STATEMENT_INVALID');assert.deepEqual(readFileSync(csv),previous);
  checks.push('A corrupt real HTTP export returns an error through IPC and preserves the previous CSV');
  const all=await call('agent_credit_history',{query:{kind:'usage',limit:20}});assert.equal(all.totalCount,137);assert(all.nextCursor);
  const afterFirst=await call('agent_payment_snapshot');assert.equal(afterFirst.wallet.chargeCount,137);assert.equal(afterFirst.wallet.grants.length,1);
  await browser.close();browser=null;
  const foreground=owned.find(p=>!p.background&&p.pid===child.pid);assert(foreground);support('terminate',foreground);
  await new Promise(resolve=>server.close(resolve));await startGateway(port);
  const recovered=await launch();assert.equal(recovered.pid,background.pid);
  const next=await call('agent_credit_history',{query:{kind:'usage',limit:20,cursor:all.nextCursor}});assert.equal(next.totalCount,137);
  assert(next.items.every(item=>!all.items.some(old=>old.generationId===item.generationId)));
  const afterRestart=await call('agent_payment_snapshot');assert.deepEqual(afterRestart.wallet,afterFirst.wallet);
  await save(query,join(output,'重启后用量记录.csv'));
  checks.push('Foreground and gateway restart preserve the native login, signed page cursor, wallet and same isolated background process');
  const restartedDialog=await openUsage();
  fault='missing';await restartedDialog.getByRole('combobox',{name:'用量时间范围',exact:true}).click();await page.getByRole('option',{name:'最近 7 天',exact:true}).click();
  await restartedDialog.getByText('当前服务尚未开放完整用量记录，可查看最近记录',{exact:true}).waitFor();assert.equal(await restartedDialog.locator('[data-charge-id]').count(),100);
  checks.push('An actual gateway 404 passes through the native compatibility fallback to the real recent 100 records');
  assert.equal(rendererErrors.length,0,rendererErrors.join('\n'));assert.equal(upstreamCalls,0);
  const after=await existingState();assert.deepEqual(after,before);
  const state=support('snapshot');assert.deepEqual(state.startup,originalProcesses.startup);
  for(const original of originalProcesses.processes)assert(state.processes.some(p=>p.pid===original.pid&&p.created===original.created));
  checks.push('Original 31 conversations, active chat, wallet, processes and autostart settings remain unchanged');
  const result={passed:true,actualReleaseRustAndWebView:true,actualNativeIpc:true,actualNativeCsvSave:true,
    systemFilePickerOperated:true,realAccountCharges:0,upstreamModelCalls:upstreamCalls,installedOrPublished:false,
    qaIdentifier:qaConfig.identifier,binarySha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),
    records:137,filteredExportRecords:saved.records,originalConversations:before.chatCount,originalChatSha256:before.chatSha256,
    originalProcessesPreserved:true,originalBackgroundPid:before.background.pid,qaBackgroundPid:background.pid,checks,rendererErrors};
  writeFileSync(join(output,'native-acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){
  writeFileSync(join(output,'native-failure.json'),JSON.stringify({error:String(error),checks,rendererErrors},null,2));
  if(page&&!page.isClosed())await page.screenshot({path:join(output,'native-failure.png')}).catch(()=>{});throw error;
}finally{
  if(page&&!page.isClosed())await call('background_stop',{}).catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  for(const process of support('snapshot').processes){
    if(process.exe.toLowerCase()===exe.toLowerCase()&&!originalProcesses.processes.some(p=>p.pid===process.pid&&p.created===process.created))support('terminate',process);
  }
  const credential=identityOrigin?support('delete',{identity_origin:identityOrigin}):null;
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  const cleaned=support('snapshot');
  assert.deepEqual(cleaned.processes,originalProcesses.processes);
  assert.deepEqual(cleaned.startup,originalProcesses.startup);
  writeFileSync(join(output,'native-cleanup.json'),JSON.stringify({passed:true,qaProcessesExited:true,
    originalProcessesPreserved:true,autostartPreserved:true,fixtureCredentialRemoved:credential?.fixtureCredentialRemoved===true},null,2));
  await originalBrowser.close();
}
