import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBillingCandidate,virtualPaymentReceipt} from '../billing-candidate.mjs';
const secret='local-sandbox-callback-secret-not-a-payment-key';
const generation={generationId:'generation-1',conversationId:'conversation',state:'settled',model:'deepseek-flash',inputTokens:1_000_000,cachedInputTokens:900_000,outputTokens:10_000,reasoningTokens:8000};
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'geod-billing-')),path=join(root,'candidate.sqlite');let time=Date.now();
  const run={runId:'run',conversationId:'conversation',status:'completed',usageResolved:true,refundEligible:false,generations:[generation],tasks:[{id:'native-task',verified:true,status:'downloading'}]};
  const options={callbackSecret:secret,loadRun:async(account,id)=>{assert.equal(account,'owner');assert.equal(id,'run');return structuredClone(run);},loadGeneration:async()=>structuredClone(generation),now:()=>time};
  let store=createBillingCandidate(path,options);return{run,options,get store(){return store;},advance:ms=>time+=ms,pay(kind='topup',key='order'){
    const order=store.createOrder('owner',key,{kind,topupCny:10});const receipt=virtualPaymentReceipt(secret,{orderId:order.orderId,amountNanoCny:order.priceNanoCny,paidAt:new Date(time).toISOString()});return{order,receipt};
  },reopen(){store.close();store=createBillingCandidate(path,options);},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test('Virtual payment signature, amount, order binding and duplicate callbacks are checked',()=>{
 const f=fixture();try{const{order,receipt}=f.pay();assert.throws(()=>f.store.applyPayment({...receipt,signature:'forged'}));assert.throws(()=>f.store.applyPayment(virtualPaymentReceipt(secret,{orderId:order.orderId,amountNanoCny:'1'})));
  assert.equal(f.store.applyPayment(receipt).replayed,false);assert.equal(f.store.applyPayment(receipt).replayed,true);assert.equal(f.store.summary('owner').balanceNanoCny,'10000000000');assert.equal(f.store.order('another',order.orderId),null);
  assert.throws(()=>f.store.createOrder('owner','order',{kind:'topup',topupCny:11}));assert.equal(f.store.createOrder('owner','order',{kind:'topup',topupCny:10}).replayed,true);
 }finally{f.close();}
});
test('Subscriptions grant credits once; renewal extends the existing period and survives restart',()=>{
 const f=fixture();try{const first=f.pay('subscription','month1');f.store.applyPayment(first.receipt);const before=f.store.summary('owner');assert.equal(before.balanceNanoCny,'10000000000');
  const second=f.pay('subscription','month2');f.store.applyPayment(second.receipt);f.reopen();const actual=f.store.summary('owner');assert.equal(actual.balanceNanoCny,'20000000000');assert.equal(actual.subscription.expires_at-before.subscription.expires_at,30*86_400_000);assert.equal(actual.active,false);assert.equal(actual.chargesEnabled,false);
 }finally{f.close();}
});
test('Cancelled and expired test orders retain late payment evidence for review without inventing credits',()=>{
 const f=fixture();try{const a=f.pay();f.store.cancelOrder('owner',a.order.orderId);assert.equal(f.store.applyPayment(a.receipt).reviewRequired,true);
  const b=f.pay('topup','late');f.advance(31*60_000);assert.equal(f.store.applyPayment(virtualPaymentReceipt(secret,{orderId:b.order.orderId,amountNanoCny:b.order.priceNanoCny,paidAt:new Date(f.options.now()).toISOString()})).reviewRequired,true);
  assert.equal(f.store.summary('owner').balanceNanoCny,'0');assert.equal(f.store.summary('owner').orders.length,2);
 }finally{f.close();}
});
test('Actual gateway usage settles once under concurrent continuations and refunds only after fresh native failure',async()=>{
 const f=fixture();try{f.store.applyPayment(f.pay().receipt);const outcomes=await Promise.all([f.store.settleRun('owner','run','peak'),f.store.settleRun('owner','run','peak'),f.store.settleRun('owner','run','peak')]);assert.equal(outcomes.reduce((sum,r)=>sum+r.chargedRequests,0),1);assert.equal(f.store.summary('owner').balanceNanoCny,'9368000000');
  await assert.rejects(()=>f.store.refundFailedRun('owner','run','failed'));f.run.tasks[0].status='failed';f.run.refundEligible=true;f.reopen();assert.equal((await f.store.refundFailedRun('owner','run')).refundNanoCny,'632000000');assert.equal((await f.store.refundFailedRun('owner','run')).refundNanoCny,'0');
  assert.equal(f.store.summary('owner').balanceNanoCny,'10000000000');assert.equal(f.store.summary('owner').receipts[0].quote.providerNanoCny,'316000000');assert.equal(f.store.summary('owner').receipts[0].refunded,true);await assert.rejects(()=>f.store.settleRun('owner','run','peak'));
 }finally{f.close();}
});
test('Insufficient virtual credit leaves every request uncharged and does not change real execution permissions',async()=>{
 const f=fixture();try{const result=await f.store.settleRun('owner','run','peak');assert.equal(result.status,'insufficient_virtual_credit');assert.equal(result.chargesEnabled,false);assert.equal(f.store.summary('owner').receipts.length,0);
  f.store.applyPayment(f.pay().receipt);assert.equal((await f.store.settleRun('owner','run','peak')).chargedRequests,1);
 }finally{f.close();}
});
test('Unknown cache usage, reconciliation and wrong gateway conversation are never guessed or charged',async()=>{
 const f=fixture();try{f.store.applyPayment(f.pay().receipt);f.run.usageResolved=false;assert.equal((await f.store.settleRun('owner','run','peak')).status,'waiting_for_native_evidence');f.run.usageResolved=true;
  f.options.loadGeneration=async()=>({...generation,cachedInputTokens:null});f.reopen();assert.equal((await f.store.settleRun('owner','run','peak')).status,'unpriced');
  f.options.loadGeneration=async()=>({...generation,conversationId:'another'});f.reopen();await assert.rejects(()=>f.store.settleRun('owner','run','peak'));assert.equal(f.store.summary('owner').balanceNanoCny,'10000000000');
 }finally{f.close();}
});
