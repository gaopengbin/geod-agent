// Isolated OAuth/model protocol fixtures; balances come from the real gateway
// HTTP routes and SQLite grant logic. No real account or hosted service is changed.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createGatewayServer,readConfig} from '../../../services/geod-agent-model-gateway/server.mjs';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/welcome-credits-20261004');mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'geod-welcome-ui-')),token=randomBytes(32).toString('base64url');
const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'isolated-model-fixture',
  GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'model.sqlite')});
const fetchImpl=async(url,options)=>url.endsWith('/api/geod/oauth/introspect')
  ?Response.json({active:JSON.parse(options.body).token===token?{userId:'isolated-account',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}:null})
  :Response.json({id:'isolated-model',model:'deepseek-flash',usage:{prompt_tokens:10000,prompt_cache_hit_tokens:8000,completion_tokens:100},choices:[{message:{role:'assistant',content:'Isolated model response',tool_calls:[]}}]});
let server,base;
async function start(){server=createGatewayServer(config,{fetchImpl});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;}
await start();
async function request(path,value){const res=await fetch(base+path,{method:value?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});assert.equal(res.status,200);return res.json();}
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:900}});
const errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
await page.exposeFunction('__readWelcomeSnapshot',async()=>({status:await request('/v1/payments/status'),wallet:await request('/v1/payments/wallet')}));
await page.addInitScript(()=>{
  window.isTauri=true;localStorage.setItem('geod-agent-language-v1',JSON.stringify({language:'zh-CN',replyLanguage:'auto'}));
  window.__TAURI_INTERNALS__={invoke:async command=>{if(command!=='agent_payment_snapshot')throw new Error('Unexpected native operation: '+command);return window.__readWelcomeSnapshot();}};
});
const dialog=page.getByRole('dialog'),trigger=page.locator('.conversation-account-trigger');
try{
  await page.goto('http://127.0.0.1:1420/test/credits-harness.html');
  await trigger.getByText('20,000 Credits',{exact:true}).waitFor();await trigger.click();
  await page.locator('.conversation-account-menu').getByRole('button',{name:'余额与订阅',exact:true}).click();
  await page.locator('.conversation-account-menu').waitFor({state:'hidden'});
  const grant=dialog.locator('[data-credit-grant="welcome"]');await grant.getByText('已到账 20,000 Credits',{exact:true}).waitFor();
  assert.equal(await grant.count(),1);assert.equal(await dialog.locator('.payment-product').count(),0);assert.equal(await dialog.getByText('∞ Credits',{exact:true}).count(),0);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:join(output,'welcome-credits-dark.png')});
  checks.push('First authenticated sign-in displays the actual SQLite grant and 20,000 spendable Credits without checkout or draft products');
  for(let i=0;i<3;i++)await dialog.getByRole('button',{name:'刷新支付状态',exact:true}).click();
  assert.equal((await request('/v1/payments/wallet')).grants.length,1);
  const generation=await request('/api/agent/generations',{generationId:randomUUID(),conversationId:'welcome-ui-check',messages:[{role:'user',content:'Isolated usage check'}]});
  assert.equal(generation.billing.chargeNanoCny,'10240000');
  await dialog.getByRole('button',{name:'刷新支付状态',exact:true}).click();
  await dialog.locator('.payment-balances strong').first().getByText('19,989.76 Credits',{exact:true}).waitFor();
  assert.equal(await grant.count(),1);
  checks.push('Actual gateway generation settles cached usage, UI refresh decreases the balance, and the original grant is not replenished');
  await new Promise(resolve=>server.close(resolve));await start();
  await dialog.getByRole('button',{name:'刷新支付状态',exact:true}).click();
  assert.equal((await request('/v1/payments/wallet')).availableNanoCny,'19989760000');
  await page.waitForFunction(()=>!document.querySelector('.payment-tabs-heading > button:last-child')?.disabled);
  checks.push('Gateway restart retains the once-only grant and consumed balance');
  await page.evaluate(async()=>{document.documentElement.dataset.theme='light';const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  await grant.getByText('Welcome Credits',{exact:true}).waitFor();await grant.getByText('20,000 Credits received',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'welcome-credits-light-en.png')});
  await page.setViewportSize({width:390,height:850});
  const bounds=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth};});
  assert(bounds.left>=0&&bounds.right<=bounds.width&&bounds.scroll<=bounds.client,JSON.stringify(bounds));
  await page.screenshot({path:join(output,'welcome-credits-narrow-en.png')});
  checks.push('Dark/light themes, English and 390px layout retain readable grant and balance without horizontal overflow');
  assert.equal(errors.length,0,errors.join('\n'));
  const report={passed:true,isolatedIdentityAndModel:true,realGatewayHttpAndSqlite:true,productionModified:false,realAccountGrants:0,checks,bounds,rendererErrors:errors};
  writeFileSync(join(output,'ui-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
