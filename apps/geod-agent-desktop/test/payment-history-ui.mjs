// Real local signed SDK fixture + HTTP + SQLite; IPC is adapted for browser UI
// checks. Native credential/streaming acceptance is recorded separately.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {fixture} from '../../../services/geod-agent-model-gateway/test/helpers/payment-fixture.mjs';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/payment-history-20261005','fixture-'+randomBytes(8).toString('hex'));mkdirSync(output,{recursive:true});
const f=await fixture({maxDailyFen:1_000_000}),checks=[],errors=[],reads=[],actions=[],exports=[];
let browser,fault=null,at=Date.now();
try{
  for(let i=0;i<138;i++){
    f.clock=at-(i===0?60:1)*86_400_000;
    const order=await f.makePaid();await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});
  }
  f.clock=at;const pending=(await f.request('/v1/payments/orders',{method:'POST',value:{productId:'ai-credit-10',requestKey:'ui-pending'}})).data;
  const before=f.ledger.summary('geod-alice');
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('__paymentHistoryFixture',async(command,args)=>{
    if(command==='agent_payment_snapshot')return {status:{candidate:true,checkoutEnabled:true,paymentHistoryEnabled:true,creditHistoryEnabled:true,environment:'fixture',fixture:true,billingMode:'prepaid',products:[]},wallet:f.ledger.summary('geod-alice')};
    if(command==='agent_credit_history'){
      reads.push(args.query);const injected=fault;fault=null;
      if(injected==='error')throw new Error('支付记录查询未完成，请重试');
      if(injected==='missing')return {__error:{code:'PAYMENT_HISTORY_UNAVAILABLE',message:'Unavailable'}};
      const query=args.query,url=new URL('http://127.0.0.1/v1/payments/history/'+query.kind);for(const key of ['from','to','cursor','limit'])if(query[key]!=null)url.searchParams.set(key,String(query[key]));
      const result=await f.request(url.pathname+url.search);assert.equal(result.status,200);return result.data;
    }
    if(command==='plugin:dialog|save')return join(output,'filtered-'+exports.length+'.csv');
    if(command==='agent_credit_history_export'){
      const query=args.query,url=new URL('http://127.0.0.1/v1/payments/history/'+query.kind+'/export.csv');for(const key of ['from','to'])if(query[key]!=null)url.searchParams.set(key,String(query[key]));
      const result=await f.request(url.pathname+url.search);assert.equal(result.status,200);
      // fetch.text strips BOM; use the ledger stream for exact fixture bytes.
      const statement=f.ledger.statement('geod-alice',query.kind,query);try{
        const data=Buffer.from([...statement.chunks()].join(''));assert.equal(createHash('sha256').update(data).digest('hex'),statement.sha256);writeFileSync(args.path,data);
        exports.push({kind:query.kind,records:statement.count,bytes:statement.bytes,sha256:statement.sha256});return {records:statement.count,bytes:statement.bytes,sha256:statement.sha256,asOf:statement.asOf};
      }finally{statement.close();}
    }
    if(command==='agent_payment_action'){
      actions.push(args);assert.equal(args.action,'cancel','This UI acceptance cannot initiate a payment or refund');assert.equal(args.orderId,pending.orderId);
      const result=await f.request(`/v1/payments/orders/${args.orderId}/cancel`,{method:'POST',value:{}});assert.equal(result.status,200);return result.data;
    }
    throw new Error('Unexpected operation '+command);
  });
  await page.addInitScript(()=>{window.isTauri=true;localStorage.setItem('geod-agent-language-v1',JSON.stringify({language:'zh-CN',replyLanguage:'auto'}));window.__TAURI_INTERNALS__={invoke:async(command,args)=>{const result=await window.__paymentHistoryFixture(command,args);if(result?.__error)throw result.__error;return result;}};});
  await page.goto('http://127.0.0.1:1426/test/credits-harness.html');const dialog=page.getByRole('dialog'),trigger=page.locator('.conversation-account-trigger');await trigger.click();
  await page.locator('.conversation-account-menu').getByRole('button',{name:'余额与订阅',exact:true}).click();await dialog.waitFor();assert.equal(reads.length,0);
  await dialog.getByRole('tab',{name:'支付记录 · 139',exact:true}).click();await dialog.getByText('第 1–20 条，共 139 条',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-order-id]').count(),20);
  const first=await dialog.locator('[data-order-id]').evaluateAll(els=>els.map(e=>e.dataset.orderId));
  await dialog.getByRole('button',{name:'下一页支付记录',exact:true}).click();await dialog.getByText('第 21–40 条，共 139 条',{exact:true}).waitFor();
  const second=await dialog.locator('[data-order-id]').evaluateAll(els=>els.map(e=>e.dataset.orderId));assert(second.every(id=>!first.includes(id)));
  await dialog.getByRole('button',{name:'上一页支付记录',exact:true}).click();await dialog.getByText('第 1–20 条，共 139 条',{exact:true}).waitFor();assert.deepEqual(await dialog.locator('[data-order-id]').evaluateAll(els=>els.map(e=>e.dataset.orderId)),first);
  fault='error';await dialog.getByRole('button',{name:'下一页支付记录',exact:true}).click();await dialog.getByRole('alert').waitFor();await dialog.getByRole('button',{name:'重新查询',exact:true}).click();await dialog.getByText('第 21–40 条，共 139 条',{exact:true}).waitFor();assert.deepEqual(await dialog.locator('[data-order-id]').evaluateAll(els=>els.map(e=>e.dataset.orderId)),second);
  checks.push('139 orders use lazy loading, 20 rows per page and restored previous pages');
  const select=async(name,label)=>{await dialog.getByRole('combobox',{name,exact:true}).click();await page.getByRole('option',{name:label,exact:true}).click();};
  await select('支付时间范围','最近 30 天');await dialog.getByText('第 1–20 条，共 138 条',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'导出 CSV',exact:true}).click();await dialog.getByText('已导出 138 条记录',{exact:true}).waitFor();assert.equal(exports[0].records,138);
  await select('支付记录类型','退款');await dialog.getByText('第 1–20 条，共 137 条',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-refund-id]').count(),20);
  await dialog.locator('[data-refund-id]').first().getByText('退款明细',{exact:true}).click();await dialog.locator('[data-refund-id]').first().getByText('原订单',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'导出 CSV',exact:true}).click();await dialog.getByText('已导出 137 条记录',{exact:true}).waitFor();assert.equal(exports[1].records,137);
  checks.push('Orders and refunds have independent date filtering and full exports beyond one page');
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(output,'refunds-dark-zh.png')});
  await page.evaluate(async()=>{document.documentElement.dataset.theme='light';const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  await dialog.getByRole('button',{name:'Export CSV',exact:true}).waitFor();await page.screenshot({path:join(output,'refunds-light-en.png')});
  await page.setViewportSize({width:390,height:850});await page.screenshot({path:join(output,'refunds-narrow-en.png')});
  const bounds=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth};});assert(bounds.left>=0&&bounds.right<=bounds.width&&bounds.scroll<=bounds.client,JSON.stringify(bounds));
  assert.equal((await dialog.locator('.payment-history').innerText()).match(/[\u3400-\u9fff]/u),null);
  await dialog.getByRole('combobox',{name:'Payment date range'}).focus();await page.keyboard.press('Enter');await page.getByRole('listbox').waitFor();await page.keyboard.press('Escape');await page.getByRole('listbox').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Payment date range');
  checks.push('Light/dark, English/Chinese, 390px layout and keyboard focus pass');
  fault='error';await select('Payment date range','Last 7 days');await dialog.getByRole('alert').waitFor();await dialog.getByRole('button',{name:'Check again',exact:true}).click();await dialog.getByText('1–20 of 137 records',{exact:true}).waitFor();
  fault='missing';await select('Payment date range','All time');await dialog.getByText('Full payment history is unavailable on this service. Only recent records are shown.',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-order-id]').count(),100);assert.equal(await dialog.getByRole('button',{name:'Export CSV',exact:true}).count(),0);
  checks.push('Failed reads recover; missing routes clearly fall back to recent 100 records');
  await page.setViewportSize({width:1100,height:900});await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await dialog.getByRole('button',{name:'取消订单',exact:true}).click();await dialog.getByText('第 1–20 条，共 139 条',{exact:true}).waitFor();
  const after=f.ledger.summary('geod-alice');assert.equal(after.orders.find(o=>o.orderId===pending.orderId).status,'cancel-requested');assert.equal(actions.length,1);assert.equal(after.balanceNanoCny,before.balanceNanoCny);assert.equal(after.refundCount,before.refundCount);
  checks.push('Existing order cancellation still addresses its original ID and does not create payment or refund');
  await dialog.getByRole('button',{name:'完成',exact:true}).click();await dialog.waitFor({state:'hidden'});assert(await trigger.evaluate(el=>el===document.activeElement));
  assert.equal(errors.length,0,errors.join('\n'));writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,scope:'local signed protocol fixtures and browser IPC adapters; no real money',checks,exports,rendererErrors:errors,reads:reads.length,actions},null,2));
  console.log(JSON.stringify({passed:true,checks,output},null,2));
}catch(error){writeFileSync(join(output,'failure.json'),JSON.stringify({passed:false,message:error.stack,checks,errors},null,2));throw error;}
finally{if(browser)await browser.close();await f.close();}
