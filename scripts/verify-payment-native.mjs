// Actual Tauri IPC and desktop UI acceptance against generated-key loopback
// payment fixtures. None of these receipts represent real money or AI output.
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const phase=process.argv[2]??'initial',visualOnly=process.argv.includes('--visual'),usageOnly=process.argv.includes('--usage'),retryOnly=process.argv.includes('--retry');
assert(Number(visualOnly)+Number(usageOnly)+Number(retryOnly)<=1);const root=resolve('artifacts/product-gaps-20261004/payments/native-ui'+(visualOnly?'/visual-pass':usageOnly?'/usage-pass':retryOnly?'/retry-pass':''));mkdirSync(root,{recursive:true});
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let i=0;i<80&&!page;i++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,250));}assert(page);
const report={phase,passed:false,actualNative:true,realPayments:false,realRefunds:false,realModels:false,checks:[]};
const pass=(name)=>{report.checks.push({name,passed:true});console.log(name);};
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
function control(action,options={}){
  const args=['-X','utf8','scripts/payment-native-qa.py','control','--action',action];
  if(visualOnly)args.push('--visual');
  if(usageOnly)args.push('--usage');
  if(retryOnly)args.push('--retry');
  if(options.orderId)args.push('--order-id',options.orderId);if(options.value)args.push('--value',options.value);
  const result=spawnSync('python',args,{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);
}
const dialog=()=>page.getByRole('dialog',{name:/余额与订阅|Balance & subscription/});
async function open(){
  if(await dialog().isVisible())await closeDialog();
  await page.getByRole('button',{name:/^账号与设置$|^Account & settings$/}).click();
  await page.getByRole('button',{name:/^余额与订阅$|^Balance & subscription$/}).click();
  await dialog().waitFor();await dialog().getByText(/本机支付演练|Local payment test/).waitFor({timeout:20000});
  await page.evaluate(()=>document.fonts.ready);
}
async function locale(language,theme){await page.evaluate(async({language,theme})=>{(await import('/src/i18n.ts')).setLanguagePreferences({language,replyLanguage:'auto'});document.documentElement.dataset.theme=theme;},{language,theme});}
async function closeDialog(){await dialog().getByRole('button',{name:/^完成$|^Done$/}).click();await dialog().waitFor({state:'hidden'});}
async function refresh(){await dialog().getByRole('button',{name:/^刷新支付状态$|^Refresh payment status$/}).click();await page.waitForFunction(()=>!document.querySelector('.payment-dialog .animate-spin'));}
async function layout(name){
  const metrics=await dialog().evaluate(element=>{const r=element.getBoundingClientRect();return{viewport:[innerWidth,innerHeight],rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},horizontal:element.scrollWidth>element.clientWidth+1,documentHorizontal:document.documentElement.scrollWidth>innerWidth+1,text:element.innerText};});
  assert(metrics.rect.left>=0&&metrics.rect.top>=0&&metrics.rect.right<=metrics.viewport[0]+1&&metrics.rect.bottom<=metrics.viewport[1]+1);assert(!metrics.horizontal&&!metrics.documentHorizontal);
  await page.screenshot({path:join(root,name+'.png')});writeFileSync(join(root,name+'.json'),JSON.stringify(metrics,null,2));
}
try{
 if(phase==='initial'){
  const preferences=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:localStorage.getItem('geod-agent-theme'),htmlTheme:document.documentElement.dataset.theme,paymentKeys:Object.keys(localStorage).filter(key=>key.startsWith('geod-agent-payment-requests-v1:'))}));
  assert.equal(preferences.paymentKeys.length,0);writeFileSync(join(root,'original-ui.json'),JSON.stringify(preferences,null,2));
  const native=await rpc('agent_payment_snapshot');assert(native.status.fixture&&native.status.checkoutEnabled&&native.status.billingMode==='prepaid');assert.equal(native.wallet.balanceNanoCny,'0');
  await locale('zh-CN','light');await open();await layout('zh-light-balance');
  assert.equal(await dialog().getByRole('button',{name:'演练下单',exact:true}).count(),3);pass('Actual account menu opens the fixture-labelled native wallet and proposed server catalogue');
  for(const [language,theme] of [['zh-CN','dark'],['en','light'],['en','dark']]){await locale(language,theme);await layout(language+'-'+theme+'-balance');}
  await page.setViewportSize({width:390,height:700});await layout('en-dark-narrow');await page.setViewportSize({width:1440,height:900});await locale('zh-CN','dark');pass('Chinese and English, both themes and 390px viewport stay inside the modal with usable buttons');
  await dialog().getByRole('button',{name:'演练下单',exact:true}).first().click();
  await dialog().getByText('演练收银台已打开，不会真实扣款。',{exact:true}).waitFor({timeout:30000});
  let snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.orders.length,1);assert.equal(snapshot.wallet.balanceNanoCny,'0');
  const order=snapshot.wallet.orders[0];assert.equal(order.status,'pending');writeFileSync(join(root,'pending-order.json'),JSON.stringify(order,null,2));
  await layout('zh-dark-pending');await closeDialog();await open();await dialog().getByRole('tab',{name:/支付记录/}).click();
  assert.equal(await dialog().locator('[data-order-id]').count(),1);pass('Creating and opening signed checkout does not credit money; closing and reopening restores the same pending order');
  // Leave an order pending across a genuine native foreground/background exit.
  await closeDialog();writeFileSync(join(root,'initial-snapshot.json'),JSON.stringify(await rpc('agent_payment_snapshot'),null,2));
 }else if(phase==='restarted'){
  const order=JSON.parse(readFileSync(join(root,'pending-order.json'),'utf8'));
  const restored=await rpc('agent_payment_snapshot');assert.equal(restored.wallet.orders[0].orderId,order.orderId);assert.equal(restored.wallet.balanceNanoCny,'0');
  let snapshot;
  if(restored.wallet.orders[0].status==='pending'){
  await locale('zh-CN','dark');await open();await dialog().getByRole('tab',{name:/支付记录/}).click();await layout('restored-pending');pass('Actual desktop process restart restores the original awaiting-payment order and request ID');
  control('paid',{orderId:order.orderId});await refresh();snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.balanceNanoCny,'10000000000');assert.equal(snapshot.wallet.orders[0].status,'paid');
  await dialog().getByText('已到账',{exact:true}).waitFor();pass('Generated-key callback traverses the real gateway and native wallet; verified fixture credit appears once');
  control('refundLost');await dialog().getByRole('button',{name:'申请退款',exact:true}).click();await dialog().getByRole('button',{name:'演练退款',exact:true}).click();
  await dialog().getByRole('alert').waitFor({timeout:30000});assert.match(await dialog().getByRole('alert').innerText(),/尚未确认/);
  snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.balanceNanoCny,'0');assert.equal(snapshot.wallet.refunds[0].status,'uncertain');assert.equal(snapshot.wallet.orders[0].status,'refunding');
  await layout('zh-dark-refund-uncertain');writeFileSync(join(root,'uncertain-refund.json'),JSON.stringify(snapshot,null,2));pass('Lost refund response shows uncertainty and freezes fixture credit without declaring a completed refund');
  control('restart');control('refundNormal');await dialog().getByRole('button',{name:'核对退款',exact:true}).click();await dialog().getByText('已退款',{exact:true}).waitFor({timeout:30000});
  }else{
    assert.equal(restored.wallet.orders[0].status,'refunded');
    report.checks=JSON.parse(readFileSync(join(root,'restarted-acceptance.json'),'utf8')).checks;
    if(!await dialog().isVisible())await open();
    await dialog().getByRole('tab',{name:/支付记录/}).click();
  }
  control('refundNormal');
  snapshot=await rpc('agent_payment_snapshot');const state=JSON.parse(readFileSync(join(root,'gateway-state.json'),'utf8'));
  assert.equal(snapshot.wallet.refunds[0].refundId,JSON.parse(readFileSync(join(root,'uncertain-refund.json'),'utf8')).wallet.refunds[0].refundId);assert.equal(snapshot.wallet.refunds[0].status,'refunded');assert.equal(state.refunds,1);
  const submitted=state.providerCalls.filter(call=>call.method==='alipay.trade.refund');assert(submitted.length>=1);assert.equal(new Set(submitted.map(call=>call.refundId)).size,1);assert(state.providerCalls.some(call=>call.method==='alipay.trade.fastpay.refund.query'));
  await layout('zh-dark-refunded');pass('Gateway ledger recreation resumes and queries the original refund ID with one provider money effect');
  await dialog().getByRole('tab',{name:'余额与方案',exact:true}).click();await dialog().getByRole('button',{name:'演练下单',exact:true}).nth(1).click();await dialog().getByText('演练收银台已打开，不会真实扣款。',{exact:true}).waitFor({timeout:30000});
  snapshot=await rpc('agent_payment_snapshot');const second=snapshot.wallet.orders.find(item=>item.product.id==='ai-credit-20');assert(second);assert.equal(second.status,'pending');
  writeFileSync(join(root,'second-pending-order.json'),JSON.stringify(second,null,2));await closeDialog();
 }else if(phase==='settlement'){
  const second=JSON.parse(readFileSync(join(root,'second-pending-order.json'),'utf8'));
  let snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.orders.find(item=>item.orderId===second.orderId).status,'pending');
  assert.equal(snapshot.wallet.refunds[0].status,'refunded');assert.equal(snapshot.wallet.balanceNanoCny,'0');
  await locale('zh-CN','dark');await open();await dialog().getByRole('tab',{name:/支付记录/}).click();
  pass('Recorded native foreground and background process exit preserves both pending checkout and prior verified refund');
  control('paid',{orderId:second.orderId});await refresh();
  const generation=await rpc('agent_generate',{generationId:randomUUID(),conversationId:'payment-ui-protocol-fixture',messages:[{role:'user',content:'本机支付模型协议验收，无真实模型请求。'}]});
  assert.equal(generation.billing.chargeNanoCny,'10240000');assert.equal(generation.state,'settled');snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.balanceNanoCny,'19989760000');assert.equal(snapshot.wallet.reservedNanoCny,'0');
  await dialog().getByRole('tab',{name:'余额与方案',exact:true}).click();await refresh();await layout('zh-dark-credit-settled');pass('Actual native generation IPC settles server-owned fixture usage and displays released reservations');
  await dialog().getByRole('tab',{name:/支付记录/}).click();await dialog().locator(`[data-order-id="${second.orderId}"]`).getByRole('button',{name:'申请退款',exact:true}).click();await dialog().getByRole('button',{name:'演练退款',exact:true}).click();
  await dialog().getByRole('alert').waitFor({timeout:30000});assert.match(await dialog().getByRole('alert').innerText(),/已使用/);assert.equal((await rpc('agent_payment_snapshot')).wallet.balanceNanoCny,'19989760000');pass('A used top-up cannot silently be refunded; native UI gives the server review requirement');
  await closeDialog();writeFileSync(join(root,'restarted-snapshot.json'),JSON.stringify(snapshot,null,2));
 }else if(phase==='visual'){
  if(!existsSync(join(root,'original-ui.json'))){const preferences=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:localStorage.getItem('geod-agent-theme'),htmlTheme:document.documentElement.dataset.theme,paymentKeys:Object.keys(localStorage).filter(key=>key.startsWith('geod-agent-payment-requests-v1:'))}));writeFileSync(join(root,'original-ui.json'),JSON.stringify(preferences,null,2));}
  await locale('zh-CN','light');await open();
  for(const [language,theme] of [['zh-CN','light'],['zh-CN','dark'],['en','light'],['en','dark']]){await locale(language,theme);await layout(language+'-'+theme+'-final');}
  await page.setViewportSize({width:390,height:700});await layout('en-dark-narrow-final');
  const viewport=dialog().locator('[data-radix-scroll-area-viewport]');await viewport.hover();await page.mouse.wheel(0,600);
  await dialog().getByRole('button',{name:'Test checkout',exact:true}).last().waitFor();assert(await dialog().getByRole('button',{name:'Test checkout',exact:true}).last().isVisible());
  const scroll=await viewport.evaluate(element=>({scrollTop:element.scrollTop,overflow:element.scrollHeight>element.clientHeight}));assert(scroll.overflow&&scroll.scrollTop>0);
  await layout('en-dark-narrow-scrolled-final');pass('Final shared scroll area exposes the subscription on a narrow screen without default native scrollbars');
  await page.setViewportSize({width:1440,height:900});await locale('zh-CN','dark');
  await dialog().getByRole('tab',{name:/支付记录/}).click();
  const usedOrder=dialog().locator('.payment-order').filter({has:page.getByRole('button',{name:'申请退款',exact:true})});
  if(await usedOrder.count()){
  await usedOrder.getByRole('button',{name:'申请退款',exact:true}).click();await dialog().getByRole('button',{name:'演练退款',exact:true}).click();await dialog().getByRole('alert').waitFor({timeout:30000});
  await page.setViewportSize({width:390,height:700});await layout('zh-dark-narrow-refund-error-final');
  assert.equal(await dialog().getByRole('button',{name:'演练退款',exact:true}).count(),0);pass('Refund error retains the server message, closes the confirmation and keeps narrow-screen completion controls reachable');
  }
  await page.setViewportSize({width:1440,height:900});
  const firstTab=dialog().getByRole('tab',{name:'余额与方案',exact:true});await firstTab.click();await firstTab.focus();await page.keyboard.press('ArrowRight');assert.equal(await dialog().getByRole('tab',{name:/支付记录/}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');assert.equal(await firstTab.getAttribute('aria-selected'),'true');await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.conversation-account-trigger'),{},{timeout:5000});pass('Shared tabs support arrow and Home keys; Escape restores focus to the account menu');
  }else if(phase==='usage'){
   if(!existsSync(join(root,'original-ui.json'))){const preferences=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:localStorage.getItem('geod-agent-theme'),htmlTheme:document.documentElement.dataset.theme,paymentKeys:Object.keys(localStorage).filter(key=>key.startsWith('geod-agent-payment-requests-v1:'))}));writeFileSync(join(root,'original-ui.json'),JSON.stringify(preferences,null,2));}
   const idsPath=join(root,'usage-ids.json'),ids=existsSync(idsPath)?JSON.parse(readFileSync(idsPath,'utf8')):{settled:randomUUID(),reserved:randomUUID()};writeFileSync(idsPath,JSON.stringify(ids,null,2));
   const snapshotBefore=await rpc('agent_payment_snapshot');assert(snapshotBefore.status.fixture);assert.equal(snapshotBefore.status.billingMode,'prepaid');
   const first=await rpc('agent_payment_action',{action:'create',productId:'ai-credit-10',requestKey:'native-usage-audit-main-v1'});
   if(first.status==='pending')control('paid',{orderId:first.orderId});
   if(!snapshotBefore.wallet.charges?.some(charge=>charge.generationId===ids.settled)){
     control('modelMode',{value:'ok'});const charged=await rpc('agent_generate',{generationId:ids.settled,conversationId:'payment-usage-protocol-fixture',messages:[{role:'user',content:'本机用量账本协议演练，无真实模型请求。'}]});assert.equal(charged.billing.chargeNanoCny,'10240000');
   }
   if(!snapshotBefore.wallet.reservations?.some(reservation=>reservation.generationId===ids.reserved)){
     control('modelMode',{value:'missing-cache'});const held=await rpc('agent_generate',{generationId:ids.reserved,conversationId:'payment-usage-protocol-fixture',messages:[{role:'user',content:'本机未知缓存用量演练，无真实模型请求。'}]});assert.equal(held.billing.state,'waiting-for-usage');
   }
   let snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.chargeCount,1);assert.equal(snapshot.wallet.reservationCount,1);assert.equal(snapshot.wallet.charges[0].chargeNanoCny,'10240000');assert.equal(snapshot.wallet.charges[0].cachedInputTokens,8000);assert.match(snapshot.wallet.charges[0].pricingDigest,/^[0-9a-f]{64}$/);
   pass('Actual native usage snapshot separates one exact trusted fixture charge from unconfirmed reserved fees');
   await locale('zh-CN','light');await open();await dialog().getByRole('tab',{name:'AI 用量',exact:true}).click();const charge=dialog().locator(`[data-charge-id="${ids.settled}"]`);
   await charge.getByText('计费明细',{exact:true}).click();assert.match(await charge.innerText(),/0\.01024/);assert.match(await charge.innerText(),/10,000/);assert.match(await charge.innerText(),/8,000/);assert.match(await charge.innerText(),/geod-flash-candidate-2026-10-02/);
   for(const [language,theme] of [['zh-CN','light'],['zh-CN','dark'],['en','light'],['en','dark']]){await locale(language,theme);if(language==='en')assert(!/[\u4e00-\u9fff]/.test(await dialog().innerText()));await layout(language+'-'+theme+'-usage');}
   await page.setViewportSize({width:390,height:700});await layout('en-dark-narrow-usage');
   const panel=dialog().getByRole('tabpanel',{name:'AI usage',exact:true});assert.equal(await panel.locator('[data-charge-id]').count(),1);assert.equal(await panel.locator('[data-reservation-id]').count(),1);
   assert.match(await panel.innerText(),/Unconfirmed usage is not charged/);assert.match(await charge.innerText(),/Per million tokens/);
   await charge.locator('.payment-charge-version').scrollIntoViewIfNeeded();
   const priceVisible=await charge.locator('.payment-charge-version').evaluate(element=>{const r=element.getBoundingClientRect(),v=element.closest('[data-radix-scroll-area-viewport]').getBoundingClientRect();return r.top>=v.top-1&&r.bottom<=v.bottom+1;});assert(priceVisible);await layout('en-dark-narrow-scrolled-usage');
   pass('Four language and theme states plus 390px render exact decimal fees, cached usage and captured rates in compact expandable rows');
   await page.setViewportSize({width:1440,height:900});await locale('zh-CN','dark');
   const refundable=await rpc('agent_payment_action',{action:'create',productId:'ai-credit-10',requestKey:'native-usage-audit-refund-v1'});if(refundable.status==='pending')control('paid',{orderId:refundable.orderId});
   control('refundLost');await refresh();await dialog().getByRole('tab',{name:/支付记录/}).click();
   const refundRow=dialog().locator(`[data-order-id="${refundable.orderId}"]`);if(refundable.status!=='refunding'){await refundRow.getByRole('button',{name:'申请退款',exact:true}).click();await dialog().getByRole('button',{name:'演练退款',exact:true}).click();await dialog().getByRole('alert').waitFor({timeout:30000});}
   snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.frozenNanoCny,'10000000000');assert.equal(snapshot.wallet.chargeCount,1);assert.equal(snapshot.wallet.reservationCount,1);
   await dialog().getByRole('tab',{name:'余额与方案',exact:true}).click();await dialog().getByText(/退款核对中 · 冻结余额/).waitFor();await page.setViewportSize({width:390,height:700});await layout('zh-dark-narrow-frozen');
   assert.equal(await dialog().getByRole('button',{name:'演练退款',exact:true}).count(),0);writeFileSync(join(root,'usage-snapshot.json'),JSON.stringify(snapshot,null,2));
   pass('A lost generated-key refund keeps its original order and shows frozen credit separately without erasing fees or reservations');
   await page.setViewportSize({width:1440,height:900});await closeDialog();
  }else if(phase==='retry'){
   if(!existsSync(join(root,'original-ui.json'))){const preferences=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:localStorage.getItem('geod-agent-theme'),htmlTheme:document.documentElement.dataset.theme,paymentKeys:Object.keys(localStorage).filter(key=>key.startsWith('geod-agent-payment-requests-v1:'))}));writeFileSync(join(root,'original-ui.json'),JSON.stringify(preferences,null,2));}
   const uncertain=await rpc('agent_payment_action',{action:'create',productId:'ai-credit-10',requestKey:'native-purchase-retry-uncertain-v1'});
   let cancellation;try{await rpc('agent_payment_action',{action:'cancel',orderId:uncertain.orderId});}catch(cause){cancellation=cause;}assert(cancellation);
   assert.equal((await rpc('agent_payment_snapshot')).wallet.orders[0].status,'cancel-requested');
   await locale('zh-CN','dark');await open();await dialog().getByRole('button',{name:'演练下单',exact:true}).first().click();
   await dialog().getByRole('alert').waitFor();assert.match(await dialog().getByRole('alert').innerText(),/仍在核对中/);
   let snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.orders.length,1);assert.equal(snapshot.wallet.orders[0].orderId,uncertain.orderId);assert.equal(snapshot.wallet.balanceNanoCny,'0');
   await layout('uncertain-payment-not-replaced');control('closeMode',{value:'normal'});await dialog().getByRole('button',{name:'核对取消',exact:true}).click();await dialog().getByText('已关闭',{exact:true}).waitFor({timeout:20000});
   pass('Uncertain cancellation keeps the original payment, prevents duplicate purchase and is retried through the real native and signed provider routes');
   const oldRequestKey=randomUUID(),paid=await rpc('agent_payment_action',{action:'create',productId:'ai-credit-10',requestKey:oldRequestKey});control('paid',{orderId:paid.orderId});
   const auth=await rpc('auth_status');snapshot=await rpc('agent_payment_snapshot');assert(auth.userId);
   const scope=`geod-agent-payment-requests-v1:${auth.userId}:${snapshot.status.environment}:${snapshot.status.pricingVersion}`;
   await page.evaluate(({scope,oldRequestKey,orderId})=>localStorage.setItem(scope,JSON.stringify({'ai-credit-10':{requestKey:oldRequestKey,orderId}})),{scope,oldRequestKey,orderId:paid.orderId});
   for(let index=0;index<101;index++){
     const historical=await rpc('agent_payment_action',{action:'create',productId:'ai-credit-10',requestKey:'native-recent-window-'+index});
     assert.equal((await rpc('agent_payment_action',{action:'cancel',orderId:historical.orderId})).order.status,'closed');
     if(index%25===0)console.log('Archived fixture orders:',index+1);
   }
   snapshot=await rpc('agent_payment_snapshot');assert.equal(snapshot.wallet.orders.length,100);assert(!snapshot.wallet.orders.some(order=>order.orderId===paid.orderId));assert.equal(snapshot.wallet.balanceNanoCny,'10000000000');
   await closeDialog();await open();await dialog().getByRole('button',{name:'演练下单',exact:true}).first().click();await dialog().getByText('演练收银台已打开，不会真实扣款。',{exact:true}).waitFor({timeout:30000});
   snapshot=await rpc('agent_payment_snapshot');const pending=snapshot.wallet.orders.filter(order=>order.status==='pending');assert.equal(pending.length,1);assert.notEqual(pending[0].orderId,paid.orderId);assert.equal(snapshot.wallet.balanceNanoCny,'10000000000');
   const request=await page.evaluate(scope=>JSON.parse(localStorage.getItem(scope))['ai-credit-10'],scope);assert.equal(request.orderId,pending[0].orderId);assert.notEqual(request.requestKey,oldRequestKey);
   await layout('completed-payment-outside-recent-window');writeFileSync(join(root,'retry-snapshot.json'),JSON.stringify(snapshot,null,2));
   pass('After 101 actual native order closures, a completed old request outside the latest 100 is verified before one new explicit purchase; checkout does not credit money');
   await closeDialog();
  }else if(phase==='restore'){
  const preferences=JSON.parse(readFileSync(join(root,'original-ui.json'),'utf8'));
  await page.evaluate(async preferences=>{
    const i18n=await import('/src/i18n.ts');i18n.setLanguagePreferences(preferences.language?JSON.parse(preferences.language):{language:'auto',replyLanguage:'auto'});
    if(preferences.language===null)localStorage.removeItem('geod-agent-language-v1');
    document.documentElement.dataset.theme=preferences.htmlTheme;
    for(const key of Object.keys(localStorage))if(key.startsWith('geod-agent-payment-requests-v1:')&&!preferences.paymentKeys.includes(key))localStorage.removeItem(key);
  },preferences);
  const native=await rpc('agent_payment_snapshot');assert.equal(native.status.checkoutEnabled,false);assert.equal(native.status.billingMode,'unlimited-test');assert.equal(native.wallet,null);
  await page.getByRole('button',{name:/^账号与设置$|^Account & settings$/}).click();await page.getByRole('button',{name:/^余额与订阅$|^Balance & subscription$/}).click();
  await dialog().getByText(/当前测试无需充值|No top-up is needed/).waitFor({timeout:20000});assert.equal(await dialog().getByRole('button',{name:/充值|订阅|Top up|Subscribe/,exact:true}).count(),0);
  await layout('original-unlimited-test-restored');await closeDialog();pass('Ordinary unchanged gateway falls back honestly to unlimited testing, with no checkout or fixture credits');
  const busy=await rpc('background_status');assert.equal(busy.activeAiTurns,0);const usage=await rpc('agent_usage');assert.equal(usage.quotaEnforced,false);
  const current=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:localStorage.getItem('geod-agent-theme'),payments:Object.keys(localStorage).filter(key=>key.startsWith('geod-agent-payment-requests-v1:'))}));
  assert.equal(current.language,preferences.language);assert.equal(current.theme,preferences.theme);assert.deepEqual(current.payments,preferences.paymentKeys);
  pass('Original language, theme, request storage and unlimited allowance are restored exactly');
 }else throw new Error('Unknown acceptance phase');
 report.passed=true;
}catch(cause){report.error=String(cause.stack??cause);throw cause;}
finally{writeFileSync(join(root,phase+'-acceptance.json'),JSON.stringify(report,null,2));await browser.close();}
