// Real isolated Rust/WebView IPC + signed local protocol ledger. No cash/model
// requests leave loopback. The shipping app and active schedule QA stay open.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture} from '../services/geod-agent-model-gateway/test/helpers/payment-fixture.mjs';
import {handleCreditHistory} from '../services/geod-agent-model-gateway/credit-history.mjs';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const base=resolve('artifacts/payment-history-native-20261005'),build=resolve(process.argv[2]??'');
assert(build.startsWith(base+'\\build-'));
const buildReceipt=JSON.parse(readFileSync(join(build,'result.json'),'utf8'));assert(buildReceipt.passed);assert.equal(buildReceipt.identifier,'dev.geod-agent.cash-history-qa');
const exe=buildReceipt.executable;assert.equal(createHash('sha256').update(readFileSync(exe)).digest('hex'),buildReceipt.executableSha256);
const profile=join(process.env.APPDATA,buildReceipt.identifier);assert(!existsSync(profile),'Do not reuse an existing QA profile');
const output=join(base,'fixture-'+randomBytes(8).toString('hex'));mkdirSync(output);
const helper=resolve('scripts/payment-history-native-support.py');
const support=(action,value={})=>{const result=spawnSync('python',['-X','utf8',helper,action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
const beforeProcesses=support('snapshot'),checks=[],errors=[],owned=[];
const original=await chromium.connectOverCDP('http://127.0.0.1:9233');
const originalPage=original.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://127.0.0.1:1420/');assert(originalPage);
async function originalState(){
  const state=await originalPage.evaluate(async()=>{
    const result=Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]));
    const rows=await new Promise((resolve,reject)=>{const request=indexedDB.open('geod-ui-state-v1',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();resolve(Object.fromEntries(keys.result.map((key,i)=>[key,values.result[i]])));};tx.onabort=()=>reject(tx.error);};});
    Object.assign(result,rows);const key=Object.keys(result).find(key=>key.startsWith('geod-agent-conversations-0.1:account:'));if(!key)throw new Error('Original history missing');
    return {history:result[key],active:result['geod-agent-active-conversation-0.1:account:'+key.split(':account:')[1]],pending:Object.fromEntries(Object.entries(result).filter(([key])=>key.includes('pending'))),language:result['geod-agent-language-v1']};
  });
  return {count:JSON.parse(state.history).length,sha256:createHash('sha256').update(state.history).digest('hex'),active:state.active,pending:Object.fromEntries(Object.entries(state.pending).map(([key,value])=>[key,createHash('sha256').update(String(value)).digest('hex')])),language:state.language};
}
const before=await originalState();assert.equal(before.count,31);writeFileSync(join(output,'original-before.json'),JSON.stringify(before,null,2));
let f,server,browser,page,child,origin,fault=null,credentialCreated=false,passed=false,failure;
try{
  f=await fixture({maxDailyFen:1_000_000});const at=Date.now();
  for(let i=0;i<138;i++){f.clock=at-(i===0?60:1)*86_400_000;const order=await f.makePaid();await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});}
  f.clock=at;f.ledger.createOrder('geod-alice','native-pending','ai-credit-10');const walletBefore=f.ledger.summary('geod-alice');
  const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));
  server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.headers.authorization!=='Bearer '+f.aliceToken){json(res,401,{error:{code:'AUTH_REQUIRED'}});return;}
      if(req.method!=='GET'){json(res,405,{error:{code:'READ_ONLY_NATIVE_FIXTURE'}});return;}
      if(url.pathname.startsWith('/v1/payments/history/')){
        const injected=fault;fault=null;
        if(injected==='missing'){json(res,404,{error:{code:'PAYMENT_HISTORY_UNAVAILABLE'}});return;}
        if(injected==='digest'){const write=res.writeHead.bind(res);res.writeHead=(status,headers)=>write(status,{...headers,'x-geod-statement-sha256':'0'.repeat(64)});}
        if(await handleCreditHistory(req,res,url,f.ledger,'geod-alice'))return;
      }
      if(url.pathname==='/v1/payments/status'){json(res,200,{candidate:true,checkoutEnabled:false,paymentHistoryEnabled:true,creditHistoryEnabled:true,environment:'fixture',fixture:true,billingMode:'prepaid',products:[]});return;}
      if(url.pathname==='/v1/payments/wallet'){json(res,200,f.ledger.summary('geod-alice'));return;}
      if(url.pathname==='/v1/models'){json(res,200,{models:[]});return;}
      if(url.pathname==='/v1/usage'){json(res,200,{quotaEnforced:false,limitTokens:null,remainingTokens:null,committedTokens:0,reservedTokens:0,pendingReconcile:0});return;}
      json(res,404,{error:{code:'NOT_FOUND'}});
    }catch(error){if(res.headersSent)res.destroy();else json(res,error.status??500,{error:{code:error.code??'FIXTURE_ERROR'}});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  support('seed',{identity_origin:origin,access_token:f.aliceToken,refresh_token:randomBytes(32).toString('base64url'),user_id:'geod-alice',access_expires_at:Math.floor(Date.now()/1000)+3600});credentialCreated=true;
  child=spawn(exe,[],{cwd:build,windowsHide:true,env:{...process.env,GEOD_AGENT_IDENTITY_ORIGIN:origin,GEOD_AGENT_GATEWAY_ORIGIN:origin,GEOD_AGENT_DEV_GATEWAY_ORIGIN:undefined,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9237'},stdio:['ignore',openSync(join(output,'desktop.log'),'a'),openSync(join(output,'desktop-errors.log'),'a')]});
  child.on('error',error=>errors.push(error.message));
  for(let i=0;i<60;i++){try{const res=await fetch('http://127.0.0.1:9237/json/list');if(res.ok&&(await res.json()).some(p=>p.type==='page'))break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9237');
  for(let i=0;i<40;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>/^https?:\/\/tauri\.localhost\/?/.test(p.url()));if(page)break;await new Promise(resolve=>setTimeout(resolve,250));}
  writeFileSync(join(output,'native-page-urls.json'),JSON.stringify(browser.contexts().flatMap(c=>c.pages()).map(p=>p.url())));
  assert(page,'QA must load its embedded frontend, not the existing dev server');page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.conversation-account-trigger').waitFor();
  const call=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return {value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {error};}},{command,args});if(result.error)throw result.error;return result.value;};
  assert.equal((await call('auth_status')).userId,'geod-alice');
  const background=await call('background_status');assert(background.running);assert.notEqual(background.pid,34480);assert.notEqual(background.pid,92204);
  const current=support('snapshot');owned.push(...current.processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase()));assert(owned.some(p=>p.background));assert(owned.some(p=>!p.background));
  checks.push('Current-source embedded frontend uses its own QA profile, Windows credential and background process');
  const first=await call('agent_credit_history',{query:{kind:'orders',limit:20}});assert.equal(first.totalCount,139);assert.equal(first.items.length,20);assert(first.nextCursor);
  f.restart();const next=await call('agent_credit_history',{query:{kind:'orders',limit:20,cursor:first.nextCursor}});assert.equal(next.totalCount,139);assert(next.items.every(item=>!first.items.some(prior=>prior.orderId===item.orderId)));
  const refunds=await call('agent_credit_history',{query:{kind:'refunds',limit:20}});assert.equal(refunds.totalCount,138);assert.equal(refunds.items.length,20);
  checks.push('Real Rust IPC paginates orders/refunds beyond 100 and continues its signed cursor after ledger restart');
  await page.locator('.conversation-account-trigger').click();await page.locator('.conversation-account-menu').getByRole('button',{name:'余额与订阅',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('tab',{name:'支付记录 · 139',exact:true}).click();await dialog.getByText('第 1–20 条，共 139 条',{exact:true}).waitFor();
  assert(await dialog.getByRole('button',{name:'继续支付',exact:true}).isDisabled());assert(await dialog.getByRole('button',{name:'取消订单',exact:true}).isDisabled());
  checks.push('A service with checkout disabled keeps cash actions disabled while read-only history remains available');
  await dialog.getByRole('button',{name:'下一页支付记录',exact:true}).click();await dialog.getByText('第 21–40 条，共 139 条',{exact:true}).waitFor();
  await dialog.getByRole('combobox',{name:'支付时间范围',exact:true}).click();await page.getByRole('option',{name:'最近 30 天',exact:true}).click();await dialog.getByText('第 1–20 条，共 138 条',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'native-orders.png')});
  await dialog.getByRole('button',{name:'导出 CSV',exact:true}).click();let picker;
  for(let i=0;i<40;i++){const found=support('dialogs',{pid:child.pid});if(found.length){picker=found;break;}await new Promise(resolve=>setTimeout(resolve,250));}assert(picker);writeFileSync(join(output,'system-save-controls.json'),JSON.stringify(picker,null,2));
  const uiPath=join(output,'系统保存窗口支付记录.csv');support('save-dialog',{pid:child.pid,path:uiPath});await dialog.getByText('已导出 138 条记录',{exact:true}).waitFor();assert.equal(readFileSync(uiPath,'utf8').split('\r\n').filter(Boolean).length,139);
  checks.push('Actual export button and Windows save picker write all 138 filtered orders');
  await dialog.getByRole('combobox',{name:'支付记录类型',exact:true}).click();await page.getByRole('option',{name:'退款',exact:true}).click();await dialog.getByText('第 1–20 条，共 137 条',{exact:true}).waitFor();await dialog.locator('[data-refund-id]').first().getByText('退款明细',{exact:true}).click();await page.screenshot({path:join(output,'native-refunds.png')});
  const query={kind:'refunds',from:at-30*86_400_000,to:Date.now()+1},csv=join(output,'原生退款记录.csv');
  const saved=await call('agent_credit_history_export',{query,path:csv}),previous=readFileSync(csv);assert.equal(saved.records,137);assert.equal(previous.length,saved.bytes);assert.equal(createHash('sha256').update(previous).digest('hex'),saved.sha256);
  fault='digest';let rejected;try{await call('agent_credit_history_export',{query,path:csv});}catch(error){rejected=error;}assert.equal(rejected?.code,'PAYMENT_STATEMENT_INVALID');assert.deepEqual(readFileSync(csv),previous);
  checks.push('Native refund CSV verifies byte length/hash and a corrupt stream preserves the existing file');
  fault='missing';await dialog.getByRole('combobox',{name:'支付时间范围',exact:true}).click();await page.getByRole('option',{name:'最近 7 天',exact:true}).click();await dialog.getByText('当前服务尚未开放完整支付记录，仅显示最近记录',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-order-id]').count(),100);assert.equal(await dialog.getByRole('button',{name:'导出 CSV',exact:true}).count(),0);
  checks.push('Actual gateway 404 maps through Rust to the explicit recent-record fallback');
  assert.deepEqual(f.ledger.summary('geod-alice'),walletBefore);assert.equal(errors.length,0,errors.join('\n'));assert.deepEqual(await originalState(),before);passed=true;
}catch(error){failure=error.stack??String(error);if(page&&!page.isClosed())await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}
finally{
  const cleanup=[];
  if(page&&!page.isClosed())try{await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('background_stop'));}catch(error){cleanup.push('Background stop: '+JSON.stringify(error));}
  if(browser)await browser.close().catch(error=>cleanup.push(String(error)));
  for(const process of support('snapshot').processes){if(process.exe.toLowerCase()===exe.toLowerCase()&&!beforeProcesses.processes.some(prior=>prior.pid===process.pid&&prior.created===process.created))try{support('terminate',process);}catch(error){cleanup.push(String(error));}}
  if(credentialCreated)try{support('delete',{identity_origin:origin});}catch(error){cleanup.push(String(error));}
  if(server?.listening)await new Promise(resolve=>server.close(resolve));if(f)await f.close();
  const after=support('snapshot');for(const process of beforeProcesses.processes)if(!after.processes.some(item=>item.pid===process.pid&&item.created===process.created))cleanup.push('Original process missing '+process.pid);
  if(JSON.stringify(after.startup)!==JSON.stringify(beforeProcesses.startup))cleanup.push('Startup registry changed');
  if(after.processes.some(item=>item.exe.toLowerCase()===exe.toLowerCase()))cleanup.push('QA process remains');
  let originalAfter;try{originalAfter=await originalState();assert.deepEqual(originalAfter,before);}catch(error){cleanup.push(String(error));}
  writeFileSync(join(output,'cleanup.json'),JSON.stringify({passed:cleanup.length===0,errors:cleanup,fixtureCredentialRemoved:credentialCreated,originalBefore:before,originalAfter,owned,afterProcesses:after},null,2));
  await original.close();const result={passed:passed&&cleanup.length===0,failure,checks,errors,actualRustIpc:checks.some(c=>c.startsWith('Real Rust IPC')),systemSavePickerOperated:checks.some(c=>c.startsWith('Actual export')),scope:'local protocol fixtures; no real money or model calls',buildSha256:buildReceipt.executableSha256,originalConversations:before.count,cleanupPassed:cleanup.length===0,output};writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
