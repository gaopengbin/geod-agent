import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createSign,createVerify,randomUUID} from 'node:crypto';
import {createAlipayPaymentCandidate,parseAlipayFen,parseAlipayNotify} from '../alipay-payment-candidate.mjs';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';
import {createPaymentCandidateHandler} from '../payment-http-candidate.mjs';

import {fixture} from './helpers/payment-fixture.mjs';
import Database from 'better-sqlite3';
import {pricingCandidate} from '../pricing-candidate.mjs';

test('payment parser rejects duplicates and never rounds provider money',()=>{
  assert.equal(parseAlipayFen('29.00'),2900);assert.equal(parseAlipayFen('0.01'),1);
  for(const value of ['1.001','1e2','-1','1,00','NaN',1])assert.equal(parseAlipayFen(value),null);
  assert.throws(()=>parseAlipayNotify('out_trade_no=one&out_trade_no=two'));
  assert.throws(()=>parseAlipayNotify('sign=one&sign=two'));
});
test('real merchant requests stay disabled without explicit setup',()=>{
  assert.throws(()=>createAlipayPaymentCandidate({environment:'production'}),{code:'PAYMENT_NOT_ENABLED'});
  assert.throws(()=>createAlipayPaymentCandidate({environment:'fixture',appId:'9999000000000001',sellerId:'9999000000000002',maxSingleFen:5000,fixtureGateway:'https://openapi.alipay.com/gateway.do'}),{code:'PAYMENT_CONFIG_INVALID'});
});
test('authenticated HTTP order, signed SDK checkout, callback/query replay and restart',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/v1/payments/wallet',{token:null})).status,401);
    const created=await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'same-request',productId:'ai-credit-10'}}),order=created.data;assert.equal(created.status,201);assert.match(order.orderId,/^GDA[0-9a-f]{32}$/);
    const replay=await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'same-request',productId:'ai-credit-10'}});assert.equal(replay.data.orderId,order.orderId);assert.equal(replay.data.replayed,true);
    assert.equal((await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'same-request',productId:'ai-credit-20'}})).status,409);
    assert.equal((await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'price',productId:'ai-credit-10',priceFen:1,account:'geod-bob'}})).status,400);
    assert.equal((await f.request('/v1/payments/orders/'+order.orderId,{token:f.bobToken})).status,404);
    const checkout=await f.request(`/v1/payments/orders/${order.orderId}/checkout`,{method:'POST',value:{}});assert.equal(checkout.status,200);assert.equal((await fetch(checkout.data.checkoutUrl)).status,200);assert(f.calls.at(-1).appSignatureValid);
    assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'0');
    f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610040000000001',total_amount:'10.00',trade_status:'TRADE_SUCCESS'});
    const notify=f.notification(order);const responses=await Promise.all([f.request('/v1/payments/alipay/notify',{method:'POST',raw:notify,token:null}),f.request(`/v1/payments/orders/${order.orderId}/refresh`,{method:'POST',value:{}}),f.request('/v1/payments/alipay/notify',{method:'POST',raw:notify,token:null})]);assert(responses.every(r=>r.status===200));
    assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'10000000000');
    f.restart();assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'10000000000');assert.equal((await f.request('/v1/payments/alipay/notify',{method:'POST',raw:notify,token:null})).data,'success');
  }finally{await f.close();}
});
test('signed wrong app, seller, money, duplicate form and reused trades cannot grant credit',async()=>{
  const f=await fixture();try{
    const a=await f.makePaid(),b=(await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'second',productId:'ai-credit-10'}})).data;
    f.trades.set(b.orderId,{out_trade_no:b.orderId,trade_no:'202610040000000099',total_amount:'10.00',trade_status:'TRADE_SUCCESS'});
    for(const patch of [{app_id:'9999000000000099'},{seller_id:'9999000000000099'},{total_amount:'1.00'},{trade_no:f.trades.get(a.orderId).trade_no}])assert.equal((await f.request('/v1/payments/alipay/notify',{method:'POST',raw:f.notification(b,patch),token:null})).status,patch.trade_no?409:400);
    const raw=f.notification(b);assert.equal((await f.request('/v1/payments/alipay/notify',{method:'POST',raw:raw+'&total_amount=10.00',token:null})).status,400);
    assert.equal((await f.request('/v1/payments/alipay/notify',{method:'POST',raw:raw.replace(/sign=[^&]+/,'sign=invalid'),token:null})).status,400);
    assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'10000000000');
    f.badQuerySignature=true;assert.equal((await f.request(`/v1/payments/orders/${b.orderId}/refresh`,{method:'POST',value:{}})).status,502);assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'10000000000');
  }finally{await f.close();}
});
test('late payment is preserved for review, uncertain cancellation is not closure',async()=>{
  const f=await fixture();try{
    const order=(await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'late',productId:'ai-credit-10'}})).data;
    const cancel=await f.request(`/v1/payments/orders/${order.orderId}/cancel`,{method:'POST',value:{}});assert.equal(cancel.status,502);assert.equal((await f.request('/v1/payments/orders/'+order.orderId)).data.status,'cancel-requested');
    f.clock+=31*60000;f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610040000000111',total_amount:'10.00',trade_status:'TRADE_SUCCESS'});
    assert.equal((await f.request('/v1/payments/alipay/notify',{method:'POST',raw:f.notification(order),token:null})).data,'success');
    assert.equal((await f.request('/v1/payments/orders/'+order.orderId)).data.status,'payment-review');assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'0');
  }finally{await f.close();}
});
test('server-only usage charges precisely once; ambiguous provider usage keeps its reservation',async()=>{
  const f=await fixture();try{
    await f.makePaid();const id=randomUUID(),generation={generationId:id,state:'reserved',model:'deepseek-flash',billingScope:'hosted'};f.generations.set('geod-alice:'+id,generation);
    await f.ledger.reserveGeneration('geod-alice',id,'1000000000');assert.equal((await f.request('/v1/payments/wallet')).data.availableNanoCny,'9000000000');
    generation.state='pending_reconcile';assert.equal((await f.ledger.settleGeneration('geod-alice',id)).state,'waiting-for-provider');
    generation.state='settled';Object.assign(generation,{inputTokens:10000,outputTokens:100,cachedInputTokens:null});assert.equal((await f.ledger.settleGeneration('geod-alice',id)).state,'waiting-for-usage');
    generation.cachedInputTokens=8000;const result=await Promise.all([f.ledger.settleGeneration('geod-alice',id),f.ledger.settleGeneration('geod-alice',id)]);assert.equal(result.filter(r=>!r.replayed).length,1);assert.equal(result[0].chargeNanoCny,'10240000');
    assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'9989760000');assert.equal((await f.request('/v1/payments/wallet')).data.reservedNanoCny,'0');
    await assert.rejects(()=>f.ledger.settleGeneration('geod-bob',id),{code:'BILLING_GENERATION_NOT_FOUND'});
    f.restart();assert.equal((await f.ledger.settleGeneration('geod-alice',id)).replayed,true);
    const review=await f.request('/v1/payments/failure-reviews',{method:'POST',value:{runId:'client-claims-failed'}});assert.equal(review.data.creditGranted,false);assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'9989760000');
    assert.equal((await f.request('/v1/payments/settle',{method:'POST',value:{usage:0}})).status,404);
  }finally{await f.close();}
});
test('request price snapshots survive a changed release; usage history is exact and account-owned',async()=>{
  const f=await fixture();try{
    await f.makePaid();const first=randomUUID(),generation={generationId:first,state:'reserved',model:'deepseek-flash',billingScope:'hosted'};
    f.generations.set('geod-alice:'+first,generation);await f.ledger.reserveGeneration('geod-alice',first,'1000000000');
    const multiply=values=>Object.fromEntries(Object.entries(values).map(([name,rate])=>[name,rate*2n]));
    f.options.pricing={...pricingCandidate,version:'geod-flash-next-fixture',retail:multiply(pricingCandidate.retail)};f.restart();
    Object.assign(generation,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:10});
    assert.equal((await f.ledger.settleGeneration('geod-alice',first)).chargeNanoCny,'10240000');
    const second=randomUUID(),next={...generation,generationId:second,state:'reserved'};f.generations.set('geod-alice:'+second,next);
    await f.ledger.reserveGeneration('geod-alice',second,'1000000000');next.state='settled';
    assert.equal((await f.ledger.settleGeneration('geod-alice',second)).chargeNanoCny,'20480000');
    const wallet=(await f.request('/v1/payments/wallet')).data;assert.equal(wallet.chargeCount,2);assert.equal(wallet.reservationCount,0);
    const original=wallet.charges.find(charge=>charge.generationId===first),updated=wallet.charges.find(charge=>charge.generationId===second);
    assert.equal(original.pricingVersion,pricingCandidate.version);assert.equal(updated.pricingVersion,'geod-flash-next-fixture');
    assert.equal(original.ratesNanoPerToken.uncachedInput,'4000');assert.equal(updated.ratesNanoPerToken.uncachedInput,'8000');
    assert.match(original.pricingDigest,/^[0-9a-f]{64}$/);assert.notEqual(original.pricingDigest,updated.pricingDigest);
    assert.equal(original.reasoningTokens,10);assert.equal(original.model,'deepseek-flash');assert.equal(original.cachedInputTokens,8000);
    assert.equal((await f.request('/v1/payments/wallet',{token:f.bobToken})).data.chargeCount,0);
    assert(!JSON.stringify(wallet.charges).includes('geod-alice'));assert(!('providerNanoCny' in original));
    const wrong={...f.options,pricing:{...f.options.pricing,retail:pricingCandidate.retail}};
    assert.throws(()=>createPaymentLedgerCandidate(join(f.root,'geod-payments.sqlite'),wrong),{code:'BILLING_PRICE_VERSION_CONFLICT'});
    f.restart();assert.equal((await f.ledger.settleGeneration('geod-alice',first)).replayed,true);
  }finally{await f.close();}
});
test('legacy pending rates enter review instead of being invented; frozen refund totals remain visible',async()=>{
  const f=await fixture();try{
    await f.makePaid();const refundable=await f.makePaid(),id=randomUUID(),failed=randomUUID();
    for(const generationId of [id,failed])f.generations.set('geod-alice:'+generationId,{generationId,state:'reserved',model:'deepseek-flash',billingScope:'hosted'});
    await f.ledger.reserveGeneration('geod-alice',id,'1000000000');await f.ledger.reserveGeneration('geod-alice',failed,'1000000000');
    const legacy=new Database(join(f.root,'geod-payments.sqlite'));try{legacy.exec('ALTER TABLE geod_credit_reservations DROP COLUMN pricing_snapshot');}finally{legacy.close();}
    f.restart();Object.assign(f.generations.get('geod-alice:'+id),{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100});
    assert.equal((await f.ledger.settleGeneration('geod-alice',id)).code,'BILLING_PRICE_SNAPSHOT_MISSING');
    f.generations.get('geod-alice:'+failed).state='failed';assert.equal((await f.ledger.settleGeneration('geod-alice',failed)).state,'released');
    f.refundMode='drop-responses';assert.equal((await f.request(`/v1/payments/orders/${refundable.orderId}/refund`,{method:'POST',value:{}})).status,502);
    const wallet=(await f.request('/v1/payments/wallet')).data;assert.equal(wallet.balanceNanoCny,'10000000000');assert.equal(wallet.frozenNanoCny,'10000000000');
    assert.equal(wallet.reservedNanoCny,'1000000000');assert.equal(wallet.availableNanoCny,'9000000000');assert.equal(wallet.charges.length,0);
    assert.equal(wallet.reservations.length,1);assert.equal(wallet.reservations[0].pricingVersion,null);
    assert.equal((await f.request('/v1/payments/wallet',{token:f.bobToken})).data.frozenNanoCny,'0');
    f.restart();f.refundMode='normal';await f.request(`/v1/payments/orders/${refundable.orderId}/refund`,{method:'POST',value:{}});
    assert.equal((await f.request('/v1/payments/wallet')).data.frozenNanoCny,'0');
  }finally{await f.close();}
});
test('reservation prevents overdraft, releases confirmed provider failure and skips sponsored usage',async()=>{
  const f=await fixture();try{
    await f.makePaid();const ids=[randomUUID(),randomUUID(),randomUUID()];for(const id of ids)f.generations.set('geod-alice:'+id,{generationId:id,state:'reserved',model:'deepseek-flash',billingScope:'hosted'});
    const result=await Promise.allSettled(ids.slice(0,2).map(id=>f.ledger.reserveGeneration('geod-alice',id,'6000000000')));assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
    const reservedId=ids[result[0].status==='fulfilled'?0:1];f.generations.get('geod-alice:'+reservedId).state='failed';assert.equal((await f.ledger.settleGeneration('geod-alice',reservedId)).state,'released');
    f.generations.get('geod-alice:'+ids[2]).billingScope='sponsored';assert.equal((await f.ledger.reserveGeneration('geod-alice',ids[2],'100000000000')).state,'externally-funded');
    assert.equal((await f.request('/v1/payments/wallet')).data.balanceNanoCny,'10000000000');assert.equal((await f.request('/v1/payments/wallet')).data.reservedNanoCny,'0');
  }finally{await f.close();}
});
test('cash refund freezes credit, survives lost signed response, queries the original ID after restart',async()=>{
  const f=await fixture();try{
    const order=await f.makePaid();f.refundMode='drop-responses';const result=await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});assert.equal(result.status,502);
    const wallet=(await f.request('/v1/payments/wallet')).data;assert.equal(wallet.balanceNanoCny,'0');assert.equal(wallet.refunds[0].status,'uncertain');assert.equal(f.refunds.size,1);
    const refundId=wallet.refunds[0].refundId,submittedCount=f.calls.filter(c=>c.method==='alipay.trade.refund').length;assert(submittedCount>=1);assert(f.calls.filter(c=>c.method==='alipay.trade.refund').every(c=>c.refundId===refundId));f.restart();f.refundMode='normal';
    const confirmed=await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});assert.equal(confirmed.status,200);assert.equal(confirmed.data.status,'refunded');assert.equal(confirmed.data.refundId,refundId);assert.equal(f.calls.filter(c=>c.method==='alipay.trade.refund').length,submittedCount);
    const replay=await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});assert.equal(replay.data.replayed,true);assert.equal(f.refunds.size,1);
    assert.equal((await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{},token:f.bobToken})).status,404);
  }finally{await f.close();}
});
test('in-use credit and subscription policy cannot be refunded as unused topups',async()=>{
  const f=await fixture();try{
    const order=await f.makePaid(),id=randomUUID();f.generations.set('geod-alice:'+id,{generationId:id,state:'reserved',model:'deepseek-flash'});await f.ledger.reserveGeneration('geod-alice',id,'1000000000');
    assert.equal((await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}})).data.error.code,'PAYMENT_REFUND_BUSY');
    Object.assign(f.generations.get('geod-alice:'+id),{state:'settled',inputTokens:1000,cachedInputTokens:0,outputTokens:1});await f.ledger.settleGeneration('geod-alice',id);
    assert.equal((await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}})).data.error.code,'PAYMENT_REFUND_USED');
    const subscription=await f.makePaid('agent-month');const wallet=(await f.request('/v1/payments/wallet')).data;assert(wallet.subscription.expiresAt>=f.clock+30*86400000);
    assert.equal((await f.request(`/v1/payments/orders/${subscription.orderId}/refund`,{method:'POST',value:{}})).data.error.code,'PAYMENT_REFUND_REVIEW_REQUIRED');
    assert.equal(f.refunds.size,0);
    assert.throws(()=>createPaymentLedgerCandidate(join(f.root,'geod-payments.sqlite'),{...f.options,gateway:{...f.gateway,environment:'production',fixture:false}}),{code:'PAYMENT_LEDGER_SCOPE'});
  }finally{await f.close();}
});
test('uncertain old checkouts retain daily capacity until signed closure, cash refunds do not recycle same-day capacity',async()=>{
  const f=await fixture({maxDailyFen:1000});try{
    const order=(await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'capacity',productId:'ai-credit-10'}})).data;
    f.clock+=2*86400000;
    assert.equal((await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'new-day',productId:'ai-credit-10'}})).data.error.code,'PAYMENT_DAILY_LIMIT');
    f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610040000000777',total_amount:'10.00',trade_status:'WAIT_BUYER_PAY'});
    assert.equal((await f.request(`/v1/payments/orders/${order.orderId}/cancel`,{method:'POST',value:{}})).data.order.status,'closed');
    const paid=await f.makePaid();assert.equal((await f.request(`/v1/payments/orders/${paid.orderId}/refund`,{method:'POST',value:{}})).data.status,'refunded');
    assert.equal((await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'after-refund',productId:'ai-credit-10'}})).data.error.code,'PAYMENT_DAILY_LIMIT');
  }finally{await f.close();}
});
test('usage above the trusted reservation stays unresolved without partial wallet deductions',async()=>{
  const f=await fixture();try{
    await f.makePaid();const id=randomUUID();const g={generationId:id,state:'reserved',model:'deepseek-flash'};f.generations.set('geod-alice:'+id,g);
    await f.ledger.reserveGeneration('geod-alice',id,'1');
    Object.assign(g,{state:'settled',inputTokens:10000,outputTokens:100,cachedInputTokens:0});
    assert.equal((await f.ledger.settleGeneration('geod-alice',id)).state,'settlement-review');
    const wallet=(await f.request('/v1/payments/wallet')).data;assert.equal(wallet.balanceNanoCny,'10000000000');assert.equal(wallet.reservedNanoCny,'1');
  }finally{await f.close();}
});
test('actual process interruption preserves frozen refunds and model reservations without duplicate money effects',async()=>{
  const f=await fixture();let child;
  async function start(){
    const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CODEX_')&&!key.startsWith('GEOD_')&&!key.includes('API_KEY')&&!['DEBUG','NODE_DEBUG'].includes(key)));
    const ledgerProcess=spawn(process.execPath,[fileURLToPath(new URL('./helpers/payment-ledger-child.mjs',import.meta.url))],{env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const exited=new Promise(resolve=>ledgerProcess.once('exit',resolve)),callbacks=new Map();let serial=0;ledgerProcess.stderr.resume();
    createInterface({input:ledgerProcess.stdout}).on('line',line=>{const value=JSON.parse(line),pending=callbacks.get(value.id);if(pending){callbacks.delete(value.id);clearTimeout(pending.timer);pending.resolve(value);}});
    const rpc=value=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{callbacks.delete(id);reject(new Error('Isolated ledger request timed out'));},10000);callbacks.set(id,{resolve,reject,timer});ledgerProcess.stdin.write(JSON.stringify({id,...value})+'\n');});
    ledgerProcess.on('exit',()=>{for(const pending of callbacks.values()){clearTimeout(pending.timer);pending.reject(new Error('Isolated ledger exited'));}callbacks.clear();});
    const result=await rpc({method:'initialize',config:f.config,path:join(f.root,'geod-payments.sqlite')});assert.equal(result.result.ready,true);
    return {process:ledgerProcess,rpc,exited,async stop(){if(ledgerProcess.exitCode===null){ledgerProcess.kill();await exited;}}};
  }
  try{
    await f.makePaid();const refundable=await f.makePaid(),generationId=randomUUID();child=await start();
    await child.rpc({method:'generation',account:'geod-alice',generation:{generationId,state:'reserved',model:'deepseek-flash'}});
    assert.equal((await child.rpc({method:'reserve',account:'geod-alice',generationId,maximum:'1000000000'})).result.state,'reserved');
    f.refundMode='drop-responses';assert.equal((await child.rpc({method:'refund',account:'geod-alice',orderId:refundable.orderId})).error.code,'PAYMENT_PROVIDER_UNCERTAIN');
    const before=(await child.rpc({method:'wallet',account:'geod-alice'})).result,firstPid=child.process.pid;assert.equal(before.balanceNanoCny,'10000000000');assert.equal(before.reservedNanoCny,'1000000000');
    const submitted=f.calls.filter(c=>c.method==='alipay.trade.refund').length;
    await child.stop();child=await start();assert.notEqual(child.process.pid,firstPid);
    const restored=(await child.rpc({method:'wallet',account:'geod-alice'})).result;assert.equal(restored.balanceNanoCny,before.balanceNanoCny);assert.equal(restored.reservedNanoCny,before.reservedNanoCny);assert.equal(restored.refunds[0].refundId,before.refunds[0].refundId);
    f.refundMode='normal';assert.equal((await child.rpc({method:'refund',account:'geod-alice',orderId:refundable.orderId})).result.status,'refunded');assert.equal(f.calls.filter(c=>c.method==='alipay.trade.refund').length,submitted);assert.equal(f.refunds.size,1);
    await child.rpc({method:'generation',account:'geod-alice',generation:{generationId,state:'settled',model:'deepseek-flash',inputTokens:10000,cachedInputTokens:8000,outputTokens:100}});
    assert.equal((await child.rpc({method:'settle',account:'geod-alice',generationId})).result.chargeNanoCny,'10240000');
    assert.equal((await child.rpc({method:'wallet',account:'geod-alice'})).result.reservedNanoCny,'0');
  }finally{await child?.stop();await f.close();}
});
