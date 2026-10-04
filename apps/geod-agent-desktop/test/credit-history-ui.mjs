// Real isolated gateway HTTP + SQLite with native IPC adapters for browser QA.
// Native streaming/atomic save is checked separately by Rust HTTP tests.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createGatewayServer,readConfig} from '../../../services/geod-agent-model-gateway/server.mjs';
import {createPaymentLedgerCandidate} from '../../../services/geod-agent-model-gateway/payment-ledger-candidate.mjs';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/credit-history-20261004');mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'geod-credit-history-ui-')),token=randomBytes(32).toString('base64url'),generations=new Map();
const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'isolated-model-fixture',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'model.sqlite')});
let at=Date.now(),fault=null;
const seed=createPaymentLedgerCandidate(config.dbPath+'-credits.sqlite',{welcomeCredit:config.welcomeCredit,loadGeneration:(_account,id)=>generations.get(id),now:()=>at});
seed.grantWelcome('isolated-account');
for(let i=0;i<138;i++){
  const generationId='isolated-history-'+String(i).padStart(3,'0'),value={generationId,state:'reserved',model:'deepseek-flash',billingScope:'hosted'};
  generations.set(generationId,value);at=Date.now()-(i===0?60:1)*86_400_000;
  await seed.reserveGeneration('isolated-account',generationId,'100000000');
  if(i<137){Object.assign(value,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:10});await seed.settleGeneration('isolated-account',generationId);}
}
seed.close();
const fetchImpl=async(url,options)=>{
  assert(url.endsWith('/api/geod/oauth/introspect'),'This UI check must not call the model');
  return Response.json({active:JSON.parse(options.body).token===token?{userId:'isolated-account',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}:null});
};
const server=createGatewayServer(config,{fetchImpl});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
async function request(path){const res=await fetch(base+path,{headers:{authorization:'Bearer '+token}});assert.equal(res.status,200);return res;}
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:900}});
const errors=[],checks=[],calls=[],exports=[];page.on('pageerror',error=>errors.push(error.message));
const route=query=>{
  const url=new URL('/v1/payments/history/'+query.kind,base);
  for(const key of ['from','to','cursor','limit'])if(query[key]!=null)url.searchParams.set(key,String(query[key]));
  return url.pathname+url.search;
};
await page.exposeFunction('__creditHistoryNative',async(command,args)=>{
  calls.push(command);
  if(command==='agent_payment_snapshot')return {status:await (await request('/v1/payments/status')).json(),wallet:await (await request('/v1/payments/wallet')).json()};
  if(command==='agent_credit_history'){
    if(fault==='history'){fault=null;throw new Error('用量查询未完成，请重试');}
    if(fault==='unavailable'){fault=null;return {__isolatedError:{code:'PAYMENT_HISTORY_UNAVAILABLE',message:'当前服务尚未开放完整用量记录，可查看最近记录'}};}
    return (await request(route(args.query))).json();
  }
  if(command==='plugin:dialog|save')return join(output,'usage-filtered.csv');
  if(command==='agent_credit_history_export'){
    const url=new URL(route(args.query),base);url.pathname+='/export.csv';const res=await request(url.pathname+url.search),data=Buffer.from(await res.arrayBuffer());
    assert.equal(createHash('sha256').update(data).digest('hex'),res.headers.get('x-geod-statement-sha256'));
    writeFileSync(args.path,data);const records=Number(res.headers.get('x-geod-record-count'));exports.push({records,query:args.query});return {records,bytes:data.length,asOf:Number(res.headers.get('x-geod-statement-as-of')),sha256:res.headers.get('x-geod-statement-sha256')};
  }
  throw new Error('Unexpected native operation: '+command);
});
await page.addInitScript(()=>{window.isTauri=true;localStorage.setItem('geod-agent-language-v1',JSON.stringify({language:'zh-CN',replyLanguage:'auto'}));window.__TAURI_INTERNALS__={invoke:async(command,args)=>{const result=await window.__creditHistoryNative(command,args);if(result?.__isolatedError)throw result.__isolatedError;return result;}};});
const dialog=page.getByRole('dialog'),trigger=page.locator('.conversation-account-trigger');
const select=async(name,label)=>{await dialog.getByRole('combobox',{name,exact:true}).click();await page.getByRole('option',{name:label,exact:true}).click();};
try{
  await page.goto('http://127.0.0.1:1420/test/credits-harness.html');await trigger.getByText('18,497.12 Credits',{exact:true}).waitFor();await trigger.click();
  await page.locator('.conversation-account-menu').getByRole('button',{name:'余额与订阅',exact:true}).click();await dialog.waitFor();
  assert(!calls.includes('agent_credit_history'),'History is lazy-loaded');await dialog.getByRole('tab',{name:'AI 用量',exact:true}).click();
  await dialog.getByText('第 1–20 条，共 137 条',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-charge-id]').count(),20);
  const first=await dialog.locator('[data-charge-id]').evaluateAll(elements=>elements.map(el=>el.dataset.chargeId));
  await dialog.getByRole('button',{name:'下一页用量',exact:true}).click();await dialog.getByText('第 21–40 条，共 137 条',{exact:true}).waitFor();
  const second=await dialog.locator('[data-charge-id]').evaluateAll(elements=>elements.map(el=>el.dataset.chargeId));assert(second.every(id=>!first.includes(id)));
  await dialog.getByRole('button',{name:'上一页用量',exact:true}).click();await dialog.getByText('第 1–20 条，共 137 条',{exact:true}).waitFor();
  assert.deepEqual(await dialog.locator('[data-charge-id]').evaluateAll(elements=>elements.map(el=>el.dataset.chargeId)),first);
  checks.push('Actual gateway paginates 137 records, loads 20 at a time and restores the previous page without duplicate records');
  await select('用量时间范围','最近 30 天');await dialog.getByText('第 1–20 条，共 136 条',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'导出 CSV',exact:true}).click();await dialog.getByText('已导出 136 条记录',{exact:true}).waitFor();
  assert.equal(exports[0].records,136);assert(!readFileSync(join(output,'usage-filtered.csv'),'utf8').includes('isolated-history-000'));
  checks.push('Export includes all 136 filtered records, not just the page, with exact credit amounts and a verified digest');
  await select('用量状态','费用预留');await dialog.getByText('第 1–1 条，共 1 条',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-reservation-id]').count(),1);assert.equal(await dialog.locator('[data-charge-id]').count(),0);
  await select('用量状态','已结算用量');await dialog.getByText('第 1–20 条，共 136 条',{exact:true}).waitFor();
  fault='history';await select('用量时间范围','最近 7 天');await dialog.getByRole('alert').getByText('用量查询未完成，请重试',{exact:true}).waitFor();await dialog.getByRole('button',{name:'重新查询',exact:true}).click();await dialog.getByText('第 1–20 条，共 136 条',{exact:true}).waitFor();
  checks.push('Reservation and charge views remain separate; an actual failed read shows a retry, then restores server records');
  await dialog.locator('.payment-usage-details').first().getByText('计费明细',{exact:true}).click();
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(output,'credit-history-dark.png')});
  await page.evaluate(async()=>{document.documentElement.dataset.theme='light';const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  await dialog.getByRole('button',{name:'Export CSV',exact:true}).waitFor();await page.screenshot({path:join(output,'credit-history-light-en.png')});
  await page.setViewportSize({width:390,height:850});
  const bounds=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth};});
  assert(bounds.left>=0&&bounds.right<=bounds.width&&bounds.scroll<=bounds.client,JSON.stringify(bounds));
  assert.equal((await dialog.locator('.credit-history').innerText()).match(/[\u3400-\u9fff]/u),null);
  await page.screenshot({path:join(output,'credit-history-narrow-en.png')});
  checks.push('Dark/light, English and 390px layout keep the toolbar, amounts and expanded details readable without horizontal overflow');
  fault='unavailable';await select('Usage date range','All time');await dialog.getByText('Full usage history is not available on this service yet. Recent records are available.',{exact:true}).waitFor();
  assert.equal(await dialog.locator('[data-charge-id]').count(),100);assert.equal(await dialog.getByRole('button',{name:'Export CSV',exact:true}).count(),0);
  checks.push('A missing history route falls back to the real recent 100 records without fabricating a complete history');
  assert.equal(errors.length,0,errors.join('\n'));
  const after=await (await request('/v1/payments/wallet')).json();assert.equal(after.availableNanoCny,'18497120000');assert.equal(after.grants.length,1);assert.equal(after.chargeCount,137);
  const report={passed:true,realGatewayHttpAndSqlite:true,nativeIpcAdapters:true,actualNativeSave:false,productionModified:false,realAccountGrants:0,checks,bounds,rendererErrors:errors};writeFileSync(join(output,'ui-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('geod-credit-history-ui-'));rmSync(root,{recursive:true,force:true});}
