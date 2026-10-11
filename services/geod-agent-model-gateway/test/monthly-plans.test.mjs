import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/payment-fixture.mjs';
import {monthlyPlanDraft,monthlyPlanPolicy} from '../monthly-plans.mjs';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';
import {readPaymentHostConfig,paymentCatalogueDigest,createPaymentHostCandidate} from '../payment-host-candidate.mjs';
import {pricingCandidate} from '../pricing-candidate.mjs';

const welcomeCredit={policyId:'monthly-test-welcome',creditNanoCny:'20000000000',maxRecipients:100};
test('three monthly tiers retain welcome credit, settle signed payments once and survive renewal/restart/expiry',async()=>{
 const f=await fixture({products:monthlyPlanDraft,welcomeCredit});
 try{
  f.ledger.grantWelcome('geod-alice');
  const products=(await f.request('/v1/payments/products')).data.products;
  assert.equal(products.length,3);assert(products.every(p=>p.kind==='subscription'&&p.days===30));
  const dates=[],credits=[];let total=20000000000n;
  for(const product of products){
   const key=randomUUID();const first=await f.request('/v1/payments/orders',{method:'POST',value:{productId:product.id,requestKey:key}});
   assert.equal(first.status,201);const repeated=await f.request('/v1/payments/orders',{method:'POST',value:{productId:product.id,requestKey:key}});
   assert.equal(repeated.data.orderId,first.data.orderId);
   const order=first.data;
   assert.equal((await f.request(`/v1/payments/orders/${order.orderId}`,{token:f.bobToken})).status,404);
   const checkout=await f.request(`/v1/payments/orders/${order.orderId}/checkout`,{method:'POST',value:{}});assert.equal(checkout.status,200);
   assert.equal(new URL(checkout.data.checkoutUrl).hostname,'127.0.0.1');
   f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610110000'+String(total),total_amount:(order.priceFen/100).toFixed(2),trade_status:'TRADE_SUCCESS'});
   const notification=f.notification(order);
   for(let n=0;n<3;n++)assert.equal((await f.request('/v1/payments/alipay/notify',{method:'POST',raw:notification,token:null})).data,'success');
   assert.equal((await f.request(`/v1/payments/orders/${order.orderId}/refresh`,{method:'POST',value:{}})).status,200);
   total+=BigInt(product.creditNanoCny);const wallet=f.ledger.summary('geod-alice');
   assert.equal(wallet.availableNanoCny,String(total));assert.equal(wallet.grants.length,1);assert.equal(wallet.subscription.lastProduct.id,product.id);
   dates.push(wallet.subscription.expiresAt);credits.push(wallet.availableNanoCny);
   f.restart();assert.equal(f.ledger.summary('geod-alice').availableNanoCny,String(total));
  }
  assert.equal(dates[1]-dates[0],30*86400000);assert.equal(dates[2]-dates[1],30*86400000);
  assert.deepEqual(credits,['30000000000','50000000000','100000000000']);
  f.clock+=91*86400000;assert(f.ledger.summary('geod-alice').subscription.expiresAt<f.clock);
  assert.equal(f.ledger.summary('geod-alice').availableNanoCny,'100000000000');
  const id=randomUUID(),generation={generationId:id,state:'reserved',model:'deepseek-flash',inputTokens:1000,cachedInputTokens:0,outputTokens:50};f.generations.set('geod-alice:'+id,generation);
  await f.ledger.reserveGeneration('geod-alice',id,'10000000');generation.state='settled';await f.ledger.settleGeneration('geod-alice',id);
  assert(BigInt(f.ledger.summary('geod-alice').availableNanoCny)<total,'Credits remain usable after expiry');
 }finally{await f.close();}
});
test('monthly policy must be reviewed as well as prices before real merchant configuration can be read',async()=>{
 const f=await fixture();
 try{
  const path=join(f.root,'monthly-config.json');
  const options={billingMode:'enforced',dbPath:join(f.root,'wallet.sqlite'),maxDailyFen:100000,gateway:{environment:'production'},products:monthlyPlanDraft,catalogueApproved:true,approvedPricingVersion:pricingCandidate.version,approvedCatalogueSha256:paymentCatalogueDigest(monthlyPlanDraft)};
  writeFileSync(path,JSON.stringify(options));assert.throws(()=>readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}),{code:'PAYMENT_PLAN_POLICY_NOT_APPROVED'});
  options.approvedPlanPolicyVersion=monthlyPlanPolicy.version;writeFileSync(path,JSON.stringify(options));
  assert.equal(readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}).products.length,3);
  // A changed amount requires a new approved digest.
  options.products=monthlyPlanDraft.map((p,index)=>index?{...p}:{...p,priceFen:p.priceFen+1});writeFileSync(path,JSON.stringify(options));
  assert.throws(()=>readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}),{code:'PAYMENT_TERMS_NOT_APPROVED'});
  options.products=monthlyPlanDraft.map((p,index)=>index?{...p}:{...p,days:31});options.approvedCatalogueSha256=paymentCatalogueDigest(options.products);writeFileSync(path,JSON.stringify(options));
  assert.throws(()=>readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}),{code:'PAYMENT_PLAN_POLICY_NOT_APPROVED'});
 }finally{await f.close();}
});
test('turning checkout off preserves paid wallet and original merchant binding without allowing money mutations',async()=>{
 const f=await fixture({products:monthlyPlanDraft});let wallet;
 try{
  await f.makePaid('agent-month-standard');
  wallet=createPaymentLedgerCandidate(join(f.root,'geod-payments.sqlite'),{loadGeneration:f.options.loadGeneration,creditOnly:true,now:f.options.now});
  assert.equal(wallet.summary('geod-alice').availableNanoCny,'20000000000');
  assert.throws(()=>wallet.createOrder('geod-alice','blocked','agent-month-light'),{code:'PAYMENT_DISABLED'});
  wallet.close();wallet=null;
  assert.throws(()=>createPaymentLedgerCandidate(join(f.root,'geod-payments.sqlite'),{...f.options,gateway:{...f.gateway,appId:'another-app'}}),{code:'PAYMENT_LEDGER_SCOPE'});
  f.restart();assert.equal(f.ledger.summary('geod-alice').availableNanoCny,'20000000000');
 }finally{wallet?.close();await f.close();}
});
test('a proposed monthly catalogue creates no cash provider and does not expose purchasable products',()=>{
 const host=createPaymentHostCandidate({dbPath:'unused-monthly-preview.sqlite',quotaEnforced:false,payment:null,welcomeCredit:null},null,async()=>null);
 try{const status=host.status();assert.equal(status.checkoutEnabled,false);assert.equal(status.planPreview.state,'draft');assert.equal(status.planPreview.products.length,3);assert.equal(status.planPreview.policy.autoRenew,false);assert.equal(status.planPreview.policy.creditExpires,false);}
 finally{host.close();}
});
