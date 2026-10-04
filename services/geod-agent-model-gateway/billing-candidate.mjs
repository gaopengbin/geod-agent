// Inactive local candidate: virtual payment receipts, credits and native-run refunds.
// No provider charge, production quota or automatic settlement is enabled here.
import Database from 'better-sqlite3';
import { createHmac, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { pricingCandidate, settledQuote } from './pricing-candidate.mjs';

const MAX=1_000_000_000_000_000n,DAY=86_400_000;
const id=value=>typeof value==='string'&&value.length>=1&&value.length<=160;
const amount=value=>{const result=BigInt(value);if(result<0n||result>MAX)throw new Error('Invalid virtual amount');return result;};
const encode=value=>JSON.stringify(value);
const sign=(secret,receipt)=>createHmac('sha256',secret).update(encode(receipt)).digest('hex');
export function virtualPaymentReceipt(secret,{orderId,transactionId=`test-${randomUUID()}`,eventId=randomUUID(),amountNanoCny,paidAt=new Date().toISOString()}){
  const receipt={environment:'test',provider:'local-simulator',eventId,orderId,transactionId,currency:'CNY',amountNanoCny:String(amount(amountNanoCny)),paidAt};
  return{receipt,signature:sign(secret,receipt)};
}
export function createBillingCandidate(path,{callbackSecret,loadRun,loadGeneration,now=()=>Date.now()}={}){
  if(typeof callbackSecret!=='string'||callbackSecret.length<32||typeof loadRun!=='function'||typeof loadGeneration!=='function')throw new Error('Test secret and trusted native/gateway readers required');
  const db=new Database(path);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_orders(account TEXT,order_id TEXT,request_key TEXT,kind TEXT,price_nano INTEGER,credit_nano INTEGER,status TEXT,created_at INTEGER,expires_at INTEGER,paid_at INTEGER,transaction_id TEXT UNIQUE,PRIMARY KEY(account,order_id),UNIQUE(account,request_key));
    CREATE TABLE IF NOT EXISTS candidate_events(event_id TEXT PRIMARY KEY,body_hash TEXT,order_id TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS candidate_lots(account TEXT,lot_id TEXT,credit_nano INTEGER,remaining_nano INTEGER,created_at INTEGER,PRIMARY KEY(account,lot_id));
    CREATE TABLE IF NOT EXISTS candidate_charges(account TEXT,generation_id TEXT,run_id TEXT,quote TEXT,charge_nano INTEGER,refunded INTEGER DEFAULT 0,created_at INTEGER,PRIMARY KEY(account,generation_id));
    CREATE TABLE IF NOT EXISTS candidate_allocations(account TEXT,generation_id TEXT,lot_id TEXT,amount_nano INTEGER,PRIMARY KEY(account,generation_id,lot_id));
    CREATE TABLE IF NOT EXISTS candidate_subscriptions(account TEXT PRIMARY KEY,expires_at INTEGER,last_order_id TEXT);
    CREATE TABLE IF NOT EXISTS candidate_refunds(account TEXT,run_id TEXT,evidence_hash TEXT,amount_nano INTEGER,created_at INTEGER,PRIMARY KEY(account,run_id));`);
  const wallet=account=>String(db.prepare('SELECT COALESCE(SUM(remaining_nano),0) AS amount FROM candidate_lots WHERE account=?').get(account).amount);
  const safeOrder=row=>row?{orderId:row.order_id,kind:row.kind,currency:'CNY',priceNanoCny:String(row.price_nano),creditNanoCny:String(row.credit_nano),status:row.status,environment:'test',provider:'local-simulator',createdAt:row.created_at,expiresAt:row.expires_at,paidAt:row.paid_at}:null;
  const order=(account,orderId)=>safeOrder(db.prepare('SELECT * FROM candidate_orders WHERE account=? AND order_id=?').get(account,orderId));
  const createOrder=db.transaction((account,requestKey,{kind,topupCny}={})=>{
    if(!id(account)||!id(requestKey)||!['topup','subscription'].includes(kind))throw new Error('Invalid test order');
    if(kind==='topup'&&(!Number.isSafeInteger(topupCny)||topupCny<1||topupCny>10000))throw new Error('Invalid test topup');
    const price=BigInt(kind==='subscription'?pricingCandidate.subscriptionCny:topupCny)*1_000_000_000n;
    const credit=BigInt(kind==='subscription'?pricingCandidate.includedAiCreditCny:topupCny)*1_000_000_000n;
    const old=db.prepare('SELECT * FROM candidate_orders WHERE account=? AND request_key=?').get(account,requestKey);
    if(old){if(old.kind!==kind||BigInt(old.price_nano)!==price)throw new Error('Test order idempotency conflict');return{...safeOrder(old),replayed:true};}
    const orderId=randomUUID(),created=now();db.prepare('INSERT INTO candidate_orders VALUES (?,?,?,?,?,?,\'pending\',?,?,NULL,NULL)').run(account,orderId,requestKey,kind,price,credit,created,created+30*60_000);
    return{...order(account,orderId),replayed:false};
  });
  const applyPayment=db.transaction(({receipt,signature})=>{
    const expected=Buffer.from(sign(callbackSecret,receipt)),actual=Buffer.from(String(signature??''));
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Invalid test receipt signature');
    if(receipt.environment!=='test'||receipt.provider!=='local-simulator'||receipt.currency!=='CNY'||!id(receipt.eventId)||!id(receipt.transactionId)||!receipt.transactionId.startsWith('test-'))throw new Error('Only local virtual payment receipts are accepted');
    const hash=createHash('sha256').update(encode(receipt)).digest('hex'),event=db.prepare('SELECT * FROM candidate_events WHERE event_id=?').get(receipt.eventId);
    if(event){if(event.body_hash!==hash)throw new Error('Test event idempotency conflict');return{replayed:true,orderId:event.order_id};}
    const row=db.prepare('SELECT * FROM candidate_orders WHERE order_id=?').get(receipt.orderId);
    if(!row||amount(receipt.amountNanoCny)!==BigInt(row.price_nano))throw new Error('Test receipt amount or order mismatch');
    const paid=Date.parse(receipt.paidAt);if(!Number.isFinite(paid)||paid<row.created_at||paid>now()+60_000)throw new Error('Invalid test payment time');
    if(row.status==='test-paid'){
      if(row.transaction_id!==receipt.transactionId)throw new Error('Duplicate test payment needs review');
      db.prepare('INSERT INTO candidate_events VALUES (?,?,?,?)').run(receipt.eventId,hash,row.order_id,now());return{replayed:true,orderId:row.order_id};
    }
    // A late or cancelled virtual payment is retained for review, without losing it
    // or inventing a successful refund from an order-state change.
    if(row.status!=='pending'||paid>row.expires_at){db.prepare('INSERT INTO candidate_events VALUES (?,?,?,?)').run(receipt.eventId,hash,row.order_id,now());db.prepare('UPDATE candidate_orders SET status=\'payment-review\',transaction_id=?,paid_at=? WHERE order_id=?').run(receipt.transactionId,paid,row.order_id);return{replayed:false,reviewRequired:true,orderId:row.order_id};}
    if(BigInt(wallet(row.account))+BigInt(row.credit_nano)>MAX)throw new Error('Virtual wallet overflow');
    db.prepare('UPDATE candidate_orders SET status=\'test-paid\',transaction_id=?,paid_at=? WHERE order_id=?').run(receipt.transactionId,paid,row.order_id);
    db.prepare('INSERT INTO candidate_lots VALUES (?,?,?,?,?)').run(row.account,row.order_id,row.credit_nano,row.credit_nano,paid);
    if(row.kind==='subscription'){
      const prior=db.prepare('SELECT expires_at FROM candidate_subscriptions WHERE account=?').get(row.account);
      const expires=Math.max(prior?.expires_at??0,paid)+30*DAY;
      db.prepare('INSERT INTO candidate_subscriptions VALUES (?,?,?) ON CONFLICT(account) DO UPDATE SET expires_at=excluded.expires_at,last_order_id=excluded.last_order_id').run(row.account,expires,row.order_id);
    }
    db.prepare('INSERT INTO candidate_events VALUES (?,?,?,?)').run(receipt.eventId,hash,row.order_id,now());return{replayed:false,order:order(row.account,row.order_id)};
  });
  const cancelOrder=db.transaction((account,orderId)=>{
    const row=db.prepare('SELECT * FROM candidate_orders WHERE account=? AND order_id=?').get(account,orderId);if(!row)throw new Error('Test order not found');
    if(row.status==='pending')db.prepare('UPDATE candidate_orders SET status=\'cancelled\' WHERE account=? AND order_id=?').run(account,orderId);
    return order(account,orderId);
  });
  const allocate=(account,generationId,charge)=>{
    const lots=db.prepare('SELECT lot_id,remaining_nano FROM candidate_lots WHERE account=? AND remaining_nano>0 ORDER BY created_at,lot_id').all(account);
    let remaining=charge;
    for(const lot of lots){if(remaining===0n)break;const part=remaining<BigInt(lot.remaining_nano)?remaining:BigInt(lot.remaining_nano);db.prepare('UPDATE candidate_lots SET remaining_nano=remaining_nano-? WHERE account=? AND lot_id=?').run(part,account,lot.lot_id);db.prepare('INSERT INTO candidate_allocations VALUES (?,?,?,?)').run(account,generationId,lot.lot_id,part);remaining-=part;}
    if(remaining!==0n)throw new Error('Virtual credit changed before settlement');
  };
  const settle=db.transaction((account,run,quotes)=>{
    if(db.prepare('SELECT 1 FROM candidate_refunds WHERE account=? AND run_id=?').get(account,run.runId))throw new Error('Refunded run cannot be charged again');
    let required=0n;const fresh=[];
    for(const {generation,quote}of quotes){const old=db.prepare('SELECT * FROM candidate_charges WHERE account=? AND generation_id=?').get(account,generation.generationId);if(old){if(old.run_id!==run.runId)throw new Error('Generation belongs to another native run');continue;}required+=BigInt(quote.retailNanoCny);fresh.push({generation,quote});}
    if(BigInt(wallet(account))<required)return{status:'insufficient_virtual_credit',requiredNanoCny:String(required),balanceNanoCny:wallet(account),requestsUncharged:fresh.length,chargesEnabled:false};
    for(const {generation,quote}of fresh){const charge=BigInt(quote.retailNanoCny);allocate(account,generation.generationId,charge);db.prepare('INSERT INTO candidate_charges(account,generation_id,run_id,quote,charge_nano,created_at) VALUES (?,?,?,?,?,?)').run(account,generation.generationId,run.runId,encode(quote),charge,now());}
    return{status:'settled-preview',chargedRequests:fresh.length,replayedRequests:quotes.length-fresh.length,chargeNanoCny:String(required),balanceNanoCny:wallet(account),chargesEnabled:false};
  });
  async function settleRun(account,runId,period){
    if(!id(account)||!id(runId))throw new Error('Invalid native run identity');
    const run=await loadRun(account,runId);if(run.runId!==runId||!run.usageResolved||!['completed','failed','interrupted'].includes(run.status))return{status:'waiting_for_native_evidence',chargesEnabled:false};
    const quotes=[];let externallyFundedRequests=0;
    for(const request of run.generations??[]){
      const generation=await loadGeneration(account,request.generationId);
      if(!generation||generation.generationId!==request.generationId||generation.conversationId!==run.conversationId)throw new Error('Gateway generation does not belong to native run');
      if(['sponsored','personal'].includes(generation.billingScope)){externallyFundedRequests++;continue;}
      if(generation.state==='failed')continue;
      const quote=settledQuote(generation,period);if(quote.status!=='priced')return{...quote,chargesEnabled:false};quotes.push({generation,quote});
    }
    return {...settle(account,run,quotes),externallyFundedRequests};
  }
  const refund=db.transaction((account,run)=>{
    const old=db.prepare('SELECT * FROM candidate_refunds WHERE account=? AND run_id=?').get(account,run.runId);if(old)return{replayed:true,refundNanoCny:'0',originalRefundNanoCny:String(old.amount_nano),chargesEnabled:false};
    const charges=db.prepare('SELECT * FROM candidate_charges WHERE account=? AND run_id=? AND refunded=0').all(account,run.runId);let total=0n;
    for(const charge of charges){const allocations=db.prepare('SELECT * FROM candidate_allocations WHERE account=? AND generation_id=?').all(account,charge.generation_id);for(const allocation of allocations)db.prepare('UPDATE candidate_lots SET remaining_nano=remaining_nano+? WHERE account=? AND lot_id=?').run(allocation.amount_nano,account,allocation.lot_id);total+=BigInt(charge.charge_nano);}
    db.prepare('UPDATE candidate_charges SET refunded=1 WHERE account=? AND run_id=?').run(account,run.runId);
    const evidence={runId:run.runId,status:run.status,tasks:run.tasks,generationIds:run.generations.map(g=>g.generationId)};
    db.prepare('INSERT INTO candidate_refunds VALUES (?,?,?,?,?)').run(account,run.runId,createHash('sha256').update(encode(evidence)).digest('hex'),total,now());
    return{replayed:false,refundNanoCny:String(total),balanceNanoCny:wallet(account),chargesEnabled:false};
  });
  async function refundFailedRun(account,runId){
    const run=await loadRun(account,runId);if(run.runId!==runId||run.refundEligible!==true||run.usageResolved!==true)throw new Error('Fresh native failure evidence required');
    const ids=new Set(run.generations.map(g=>g.generationId));const charges=db.prepare('SELECT generation_id FROM candidate_charges WHERE account=? AND run_id=?').all(account,runId);if(charges.some(c=>!ids.has(c.generation_id)))throw new Error('Refund evidence does not match charged requests');
    return refund(account,run);
  }
  const summary=account=>({mode:'test',active:false,chargesEnabled:false,currency:'CNY',balanceNanoCny:wallet(account),subscription:db.prepare('SELECT expires_at,last_order_id FROM candidate_subscriptions WHERE account=?').get(account)??null,orders:db.prepare('SELECT * FROM candidate_orders WHERE account=? ORDER BY created_at DESC LIMIT 100').all(account).map(safeOrder),receipts:db.prepare('SELECT * FROM candidate_charges WHERE account=? ORDER BY created_at DESC LIMIT 100').all(account).map(r=>({generationId:r.generation_id,runId:r.run_id,quote:JSON.parse(r.quote),chargeNanoCny:String(r.charge_nano),refunded:!!r.refunded}))});
  return{active:false,createOrder,order,applyPayment,cancelOrder,settleRun,refundFailedRun,summary,close:()=>db.close()};
}
