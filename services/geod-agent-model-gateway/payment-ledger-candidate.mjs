// Server-owned candidate ledger. This is independent of local desktop receipts
// and of the old virtual-payment candidate. The host starts it only with an
// explicit payment or welcome-credit configuration. Credit-only wallets do
// not need merchant keys and cannot create cash orders or refunds.
import Database from 'better-sqlite3';
import {createCreditHistory} from './credit-history.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {PaymentError,parseAlipayNotify} from './alipay-payment-candidate.mjs';
import {pricingCandidate,capturePricingSnapshot,quoteFromPricingSnapshot} from './pricing-candidate.mjs';
import {readWelcomeRecipientLimit} from './welcome-credit-policy.mjs';

const NANO_PER_FEN=10_000_000n,MAX=1_000_000_000_000_000n,DAY=86_400_000;
const fail=(code,message,status=400)=>{throw new PaymentError(code,message,status);};
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f]/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nano=value=>{let n;try{n=BigInt(value);}catch{fail('BILLING_AMOUNT_INVALID','Invalid credit amount');}if(n<0n||n>MAX)fail('BILLING_AMOUNT_INVALID','Credit amount out of range');return n;};
export const paymentProductsCandidate=Object.freeze([
  Object.freeze({id:'ai-credit-10',name:'AI 余额 10 元',kind:'topup',priceFen:1000,creditNanoCny:'10000000000',days:0}),
  Object.freeze({id:'ai-credit-20',name:'AI 余额 20 元',kind:'topup',priceFen:2000,creditNanoCny:'20000000000',days:0}),
  Object.freeze({id:'agent-month',name:'GeoD Agent 月订阅',kind:'subscription',priceFen:pricingCandidate.subscriptionCny*100,creditNanoCny:String(BigInt(pricingCandidate.includedAiCreditCny)*1_000_000_000n),days:30}),
]);

export function createPaymentLedgerCandidate(path,{gateway=null,loadGeneration,products=paymentProductsCandidate,maxDailyFen,welcomeCredit=null,creditOnly=false,pricing=pricingCandidate,now=()=>Date.now()}={}){
  if(typeof loadGeneration!=='function'||(gateway&&(!Number.isSafeInteger(maxDailyFen)||maxDailyFen<1||maxDailyFen>100_000_000))||(!gateway&&!welcomeCredit&&!creditOnly))fail('PAYMENT_CONFIG_INVALID','Payment provider or welcome-credit policy and trusted generation reader required');
  if(welcomeCredit&&(!/^[a-zA-Z0-9._-]{1,120}$/.test(welcomeCredit.policyId??'')||typeof welcomeCredit.creditNanoCny!=='string'||! /^[1-9][0-9]*$/.test(welcomeCredit.creditNanoCny)||nano(welcomeCredit.creditNanoCny)<=0n))fail('WELCOME_CREDIT_CONFIG_INVALID','Invalid server welcome-credit policy');
  const welcomeLimit=readWelcomeRecipientLimit(welcomeCredit?.maxRecipients);
  const currentPricing=capturePricingSnapshot(pricing,'peak');
  const catalog=new Map((gateway?products:[]).map(product=>[product.id,Object.freeze({...product})]));
  for(const p of catalog.values())if(!identity(p.id)||!['topup','subscription'].includes(p.kind)||!Number.isSafeInteger(p.priceFen)||p.priceFen<1||nano(p.creditNanoCny)<=0n||!Number.isSafeInteger(p.days)||p.days<0||p.days>365)fail('PAYMENT_CONFIG_INVALID','Invalid server product');
  const db=new Database(path);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 10000');
  db.exec(`CREATE TABLE IF NOT EXISTS geod_payment_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS geod_payment_orders(id TEXT PRIMARY KEY,account TEXT NOT NULL,request_key TEXT NOT NULL,product TEXT NOT NULL,amount_fen INTEGER NOT NULL,credit_nano INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,paid_at INTEGER,trade_id TEXT UNIQUE,last_check INTEGER,UNIQUE(account,request_key));
    CREATE TABLE IF NOT EXISTS geod_payment_events(id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,order_id TEXT NOT NULL,source TEXT NOT NULL,observed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS geod_credit_lots(id TEXT PRIMARY KEY,account TEXT NOT NULL,initial_nano INTEGER NOT NULL,remaining_nano INTEGER NOT NULL,frozen INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS geod_credit_reservations(account TEXT NOT NULL,generation_id TEXT NOT NULL,maximum_nano INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,pricing_snapshot TEXT,PRIMARY KEY(account,generation_id));
    CREATE TABLE IF NOT EXISTS geod_credit_charges(account TEXT NOT NULL,generation_id TEXT NOT NULL,amount_nano INTEGER NOT NULL,quote TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account,generation_id));
    CREATE TABLE IF NOT EXISTS geod_credit_allocations(account TEXT NOT NULL,generation_id TEXT NOT NULL,lot_id TEXT NOT NULL,amount_nano INTEGER NOT NULL,PRIMARY KEY(account,generation_id,lot_id));
    CREATE TABLE IF NOT EXISTS geod_payment_subscriptions(account TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,order_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS geod_cash_refunds(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,account TEXT NOT NULL,amount_fen INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS geod_failure_refund_reviews(account TEXT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account,run_id));
    CREATE TABLE IF NOT EXISTS geod_credit_grants(account TEXT NOT NULL,kind TEXT NOT NULL,policy_id TEXT NOT NULL,lot_id TEXT NOT NULL UNIQUE,amount_nano INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account,kind),FOREIGN KEY(lot_id) REFERENCES geod_credit_lots(id));
    CREATE TABLE IF NOT EXISTS geod_welcome_decisions(account TEXT NOT NULL,policy_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('granted','quota-exhausted','existing-wallet')),amount_nano INTEGER NOT NULL,recipient_limit INTEGER,issued_count INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(account,state));`);
  // Original grants are the authoritative cumulative count across all policy versions.
  // Preserve historical timestamps; their original quota snapshot is unknown.
  db.prepare(`INSERT OR IGNORE INTO geod_welcome_decisions
    SELECT account,policy_id,'granted',amount_nano,NULL,NULL,created_at FROM geod_credit_grants WHERE kind='welcome'`).run();
  // Preserve legacy rows without inventing their original rates. Such pending
  // rows enter review; confirmed failed executions can still release a hold.
  if(!db.pragma('table_info(geod_credit_reservations)').some(column=>column.name==='pricing_snapshot'))
    db.exec('ALTER TABLE geod_credit_reservations ADD COLUMN pricing_snapshot TEXT');
  // Reopening a test ledger with a real merchant must never reinterpret fixtures
  // as money. Changing merchant/environment requires a distinct database.
  if(gateway){
    const binding=JSON.stringify({version:1,product:'geod-agent',environment:gateway.environment,appId:gateway.appId,sellerId:gateway.sellerId});
    const prior=db.prepare('SELECT value FROM geod_payment_meta WHERE key=\'merchant\'').get();
    if(prior&&prior.value!==binding){db.close();fail('PAYMENT_LEDGER_SCOPE','Payment ledger belongs to a different merchant or environment');}
    db.prepare('INSERT OR IGNORE INTO geod_payment_meta VALUES (\'merchant\',?)').run(binding);
  }else if(db.prepare('SELECT 1 FROM geod_payment_meta WHERE key=\'merchant\'').get()){
    db.close();fail('PAYMENT_LEDGER_SCOPE','A merchant ledger cannot be reopened as a credit-only wallet');
  }
  if(welcomeCredit){
    const key='welcome:'+welcomeCredit.policyId,terms=JSON.stringify({creditNanoCny:welcomeCredit.creditNanoCny});
    db.prepare('INSERT OR IGNORE INTO geod_payment_meta VALUES (?,?)').run(key,terms);
    if(db.prepare('SELECT value FROM geod_payment_meta WHERE key=?').get(key).value!==terms){db.close();fail('WELCOME_CREDIT_POLICY_CONFLICT','A welcome policy version cannot change its amount',409);}
  }
  const priceKey='pricing:'+currentPricing.version,priceTerms=JSON.stringify(currentPricing);
  const priorPricing=db.prepare('SELECT value FROM geod_payment_meta WHERE key=?').get(priceKey);
  if(priorPricing&&priorPricing.value!==priceTerms){db.close();fail('BILLING_PRICE_VERSION_CONFLICT','A price version cannot change its original rates',409);}
  db.prepare('INSERT OR IGNORE INTO geod_payment_meta VALUES (?,?)').run(priceKey,priceTerms);
  const atomic=fn=>{const tx=db.transaction(fn);return(...args)=>tx.immediate(...args);};
  const requirePayments=()=>{if(!gateway)fail('PAYMENT_DISABLED','Payments have not been enabled',409);};
  const welcomeStatus=()=>{
    const issued=db.prepare("SELECT COUNT(*) AS n FROM geod_credit_grants WHERE kind='welcome'").get().n;
    return {limit:welcomeLimit,issued,remaining:Math.max(0,welcomeLimit-issued),available:!!welcomeCredit&&issued<welcomeLimit};
  };
  const grantWelcome=atomic(account=>{
    if(!identity(account))fail('WELCOME_CREDIT_ACCOUNT_INVALID','Verified GeoD account required');
    if(!welcomeCredit)return {state:'disabled'};
    const old=db.prepare('SELECT * FROM geod_credit_grants WHERE account=? AND kind=\'welcome\'').get(account);
    if(old)return {state:'granted',replayed:true,creditNanoCny:String(old.amount_nano),createdAt:old.created_at};
    // A wallet that already had paid/used credit is not a new Agent wallet.
    const status=welcomeStatus();
    const record=(state,amount,issued=status.issued)=>db.prepare(`INSERT OR IGNORE INTO geod_welcome_decisions VALUES (?,?,?,?,?,?,?)`)
      .run(account,welcomeCredit.policyId,state,amount,welcomeLimit,issued,now());
    if(db.prepare('SELECT 1 FROM geod_credit_lots WHERE account=? LIMIT 1').get(account)){
      record('existing-wallet',0);return {state:'existing-wallet'};
    }
    if(!status.available){record('quota-exhausted',0);return {state:'quota-exhausted',...status};}
    const id='GDCW'+createHash('sha256').update(account).digest('hex'),at=now(),credit=nano(welcomeCredit.creditNanoCny);
    db.prepare('INSERT INTO geod_credit_lots VALUES (?,?,?,?,0,?)').run(id,account,credit,credit,at);
    db.prepare('INSERT INTO geod_credit_grants VALUES (?,\'welcome\',?,?,?,?)').run(account,welcomeCredit.policyId,id,credit,at);
    // Same write transaction as the slot check and wallet credit: no oversubscription.
    db.prepare(`INSERT INTO geod_welcome_decisions VALUES (?,?,'granted',?,?,?,?)`)
      .run(account,welcomeCredit.policyId,credit,welcomeLimit,status.issued+1,at);
    return {state:'granted',replayed:false,creditNanoCny:String(credit),createdAt:at};
  });
  const row=id=>db.prepare('SELECT * FROM geod_payment_orders WHERE id=?').get(id);
  function owned(account,id){const order=row(id);if(!order||order.account!==account)fail('PAYMENT_ORDER_NOT_FOUND','Order not found',404);return order;}
  const safeOrder=order=>({orderId:order.id,product:JSON.parse(order.product),priceFen:order.amount_fen,creditNanoCny:String(order.credit_nano),currency:'CNY',status:order.status,createdAt:order.created_at,expiresAt:order.expires_at,paidAt:order.paid_at,environment:gateway?.environment??'credits-only',fixture:gateway?.fixture??false});
  const providerOrder=order=>({id:order.id,amountFen:order.amount_fen,subject:JSON.parse(order.product).name,expiresAt:order.expires_at,tradeId:order.trade_id});
  const balance=account=>BigInt(db.prepare('SELECT COALESCE(SUM(remaining_nano),0) AS amount FROM geod_credit_lots WHERE account=? AND frozen=0').get(account).amount);
  const frozen=account=>BigInt(db.prepare('SELECT COALESCE(SUM(remaining_nano),0) AS amount FROM geod_credit_lots WHERE account=? AND frozen=1').get(account).amount);
  const reserved=(account,except=null)=>BigInt(db.prepare('SELECT COALESCE(SUM(maximum_nano),0) AS amount FROM geod_credit_reservations WHERE account=? AND state=\'reserved\' AND (? IS NULL OR generation_id<>?)').get(account,except,except).amount);
  const createOrder=atomic((account,requestKey,productId)=>{
    requirePayments();
    if(!identity(account)||!identity(requestKey)||!identity(productId))fail('PAYMENT_ORDER_INVALID','Account, request and product required');
    const old=db.prepare('SELECT * FROM geod_payment_orders WHERE account=? AND request_key=?').get(account,requestKey);
    if(old){if(JSON.parse(old.product).id!==productId)fail('PAYMENT_IDEMPOTENCY_CONFLICT','Request already belongs to another product',409);return {...safeOrder(old),replayed:true};}
    const product=catalog.get(productId);if(!product)fail('PAYMENT_PRODUCT_NOT_FOUND','Product not found',404);
    if(product.priceFen>gateway.maxSingleFen)fail('PAYMENT_SINGLE_LIMIT','Product exceeds the configured single-payment limit',409);
    const dayStart=Math.floor((now()+8*3600000)/DAY)*DAY-8*3600000;
    const allocated=db.prepare('SELECT COALESCE(SUM(CASE WHEN paid_at>=? THEN amount_fen WHEN paid_at IS NULL AND status IN (\'pending\',\'cancel-requested\',\'payment-review\') THEN amount_fen ELSE 0 END),0) AS amount FROM geod_payment_orders').get(dayStart).amount;
    if(allocated+product.priceFen>maxDailyFen)fail('PAYMENT_DAILY_LIMIT','New checkout unavailable under the configured daily limit',409);
    const orderId='GDA'+randomUUID().replaceAll('-',''),created=now();
    db.prepare('INSERT INTO geod_payment_orders VALUES (?,?,?,?,?,?,\'pending\',?,?,NULL,NULL,NULL)').run(orderId,account,requestKey,JSON.stringify(product),product.priceFen,nano(product.creditNanoCny),created,created+30*60_000);
    return {...safeOrder(row(orderId)),replayed:false};
  });
  const applyEvidence=atomic((orderId,evidence,source,eventId)=>{
    const order=row(orderId);if(!order)fail('PAYMENT_ORDER_NOT_FOUND','Order not found',404);
    if(evidence.orderId!==orderId||evidence.environment!==gateway.environment||evidence.amountFen!==order.amount_fen)fail('PAYMENT_EVIDENCE_MISMATCH','Verified evidence does not match ledger');
    const digest=hash(evidence),priorEvent=db.prepare('SELECT * FROM geod_payment_events WHERE id=?').get(eventId);
    if(priorEvent){if(priorEvent.order_id!==orderId||priorEvent.body_hash!==digest)fail('PAYMENT_IDEMPOTENCY_CONFLICT','Payment event conflict',409);return {replayed:true,order:safeOrder(order)};}
    if(evidence.tradeId){
      const bound=db.prepare('SELECT id FROM geod_payment_orders WHERE trade_id=?').get(evidence.tradeId);
      if(bound&&bound.id!==orderId||order.trade_id&&order.trade_id!==evidence.tradeId)fail('PAYMENT_TRADE_CONFLICT','Trade already belongs to another order',409);
    }
    db.prepare('INSERT INTO geod_payment_events VALUES (?,?,?,?,?)').run(eventId,digest,orderId,source,now());
    db.prepare('UPDATE geod_payment_orders SET last_check=? WHERE id=?').run(now(),orderId);
    if(order.paid_at!==null)return {replayed:true,order:safeOrder(row(orderId))};
    if(evidence.closed){db.prepare('UPDATE geod_payment_orders SET status=\'closed\',trade_id=? WHERE id=?').run(evidence.tradeId,orderId);return {order:safeOrder(row(orderId))};}
    if(!evidence.paid)return {order:safeOrder(row(orderId))};
    if(order.status!=='pending'||now()>order.expires_at){db.prepare('UPDATE geod_payment_orders SET status=\'payment-review\',paid_at=?,trade_id=? WHERE id=?').run(now(),evidence.tradeId,orderId);return {reviewRequired:true,order:safeOrder(row(orderId))};}
    const total=BigInt(db.prepare('SELECT COALESCE(SUM(remaining_nano),0) AS amount FROM geod_credit_lots WHERE account=?').get(order.account).amount);
    if(total+BigInt(order.credit_nano)>MAX)fail('BILLING_AMOUNT_INVALID','Credit wallet would exceed supported range');
    db.prepare('UPDATE geod_payment_orders SET status=\'paid\',paid_at=?,trade_id=? WHERE id=?').run(now(),evidence.tradeId,orderId);
    db.prepare('INSERT INTO geod_credit_lots VALUES (?,?,?,?,0,?)').run(orderId,order.account,order.credit_nano,order.credit_nano,now());
    const product=JSON.parse(order.product);
    if(product.kind==='subscription'){
      const prior=db.prepare('SELECT expires_at FROM geod_payment_subscriptions WHERE account=?').get(order.account);
      const expiresAt=Math.max(prior?.expires_at??0,now())+product.days*DAY;
      db.prepare('INSERT INTO geod_payment_subscriptions VALUES (?,?,?) ON CONFLICT(account) DO UPDATE SET expires_at=excluded.expires_at,order_id=excluded.order_id').run(order.account,expiresAt,orderId);
    }
    return {replayed:false,order:safeOrder(row(orderId))};
  });
  const locks=new Map();
  function serialized(key,fn){const prior=locks.get(key)??Promise.resolve();const result=prior.catch(()=>{}).then(fn);locks.set(key,result);result.finally(()=>{if(locks.get(key)===result)locks.delete(key);}).catch(()=>{});return result;}
  function handleNotify(body){
    const fields=parseAlipayNotify(body),order=row(fields.out_trade_no);if(!order)fail('PAYMENT_ORDER_NOT_FOUND','Order not found',404);
    const evidence=gateway.verifyNotification(body,providerOrder(order));
    return applyEvidence(order.id,evidence,'notify','notify:'+hash({environment:gateway.environment,event:evidence.eventId??hash(body)}));
  }
  const refreshOrder=(account,orderId)=>serialized(orderId,async()=>{
    const order=owned(account,orderId),evidence=await gateway.query(providerOrder(order));
    if(evidence.missing)return {unconfirmed:true,order:safeOrder(owned(account,orderId))};
    return applyEvidence(orderId,evidence,'query','query:'+hash(evidence));
  });
  const checkout=(account,orderId)=>{
    const order=owned(account,orderId);if(order.status!=='pending'||order.expires_at<=now())fail('PAYMENT_ORDER_NOT_PAYABLE','Order is not payable',409);
    return {order:safeOrder(order),checkoutUrl:gateway.checkoutUrl(providerOrder(order)),fixture:gateway.fixture};
  };
  const requestCancel=atomic((account,orderId)=>{const order=owned(account,orderId);if(order.status==='pending')db.prepare('UPDATE geod_payment_orders SET status=\'cancel-requested\' WHERE id=?').run(orderId);return row(orderId);});
  const cancelOrder=(account,orderId)=>serialized(orderId,async()=>{
    const order=requestCancel(account,orderId);if(order.status!=='cancel-requested')return {order:safeOrder(order)};
    const evidence=await gateway.close(providerOrder(order));return applyEvidence(orderId,evidence,'close','close:'+hash(evidence));
  });
  const reserve=atomic((account,generationId,maximum,limits=null)=>{
    const old=db.prepare('SELECT * FROM geod_credit_reservations WHERE account=? AND generation_id=?').get(account,generationId);
    if(limits&&(!Number.isSafeInteger(limits.inputTokens)||limits.inputTokens<0||limits.inputTokens>1000000||!Number.isSafeInteger(limits.maxOutputTokens)||limits.maxOutputTokens<256||limits.maxOutputTokens>32768))fail('BILLING_AMOUNT_INVALID','Invalid server request bounds');
    if(old&&limits){
      const stored=JSON.parse(old.pricing_snapshot??'null')?.requestBounds;
      if(!stored||stored.inputTokens!==limits.inputTokens||stored.requestedMaxOutputTokens!==limits.maxOutputTokens)fail('BILLING_IDEMPOTENCY_CONFLICT','Generation request bounds conflict',409);
      return {state:old.state,replayed:true,maximumNanoCny:String(old.maximum_nano),maxOutputTokens:stored.maxOutputTokens};
    }
    let bounds=null,maximumNano;
    if(limits){
      const inputCost=BigInt(limits.inputTokens)*BigInt(currentPricing.retailNanoPerToken.uncachedInput);
      const outputRate=BigInt(currentPricing.retailNanoPerToken.output);
      const available=balance(account)-reserved(account);
      if(available<=0n)fail(balance(account)>0n?'BILLING_CREDIT_IN_USE':'BILLING_INSUFFICIENT_CREDIT',balance(account)>0n?'AI credit is held by unresolved requests':'AI credit balance is exhausted',409);
      // The estimate coordinates concurrent requests; it is not an admission
      // threshold or a shorter response budget. Any positive available balance
      // admits the request with the model's normal configured output capacity.
      const estimated=inputCost+BigInt(limits.maxOutputTokens)*outputRate;
      maximumNano=estimated<available?estimated:available;
      bounds={inputTokens:limits.inputTokens,requestedMaxOutputTokens:limits.maxOutputTokens,maxOutputTokens:limits.maxOutputTokens,billingPolicy:'wallet-until-empty-v1'};
    }else maximumNano=nano(maximum);
    if(maximumNano<=0n)fail('BILLING_AMOUNT_INVALID','Positive server-calculated reservation required');
    if(old){if(BigInt(old.maximum_nano)!==maximumNano)fail('BILLING_IDEMPOTENCY_CONFLICT','Generation reservation conflict',409);return {state:old.state,replayed:true};}
    if(balance(account)-reserved(account)<maximumNano)fail('BILLING_INSUFFICIENT_CREDIT','Insufficient available AI credit',409);
    db.prepare('INSERT INTO geod_credit_reservations(account,generation_id,maximum_nano,state,created_at,pricing_snapshot) VALUES (?,?,?,\'reserved\',?,?)').run(account,generationId,maximumNano,now(),JSON.stringify(bounds?{...currentPricing,requestBounds:bounds}:currentPricing));
    return {state:'reserved',replayed:false,maximumNanoCny:String(maximumNano),pricingVersion:currentPricing.version,...(bounds?{maxOutputTokens:bounds.maxOutputTokens}:{} )};
  });
  async function reserveGeneration(account,generationId,maximum,limits=null){
    if(!identity(account)||!identity(generationId))fail('BILLING_GENERATION_INVALID','Invalid generation binding');
    const generation=await loadGeneration(account,generationId);
    if(!generation||generation.generationId!==generationId)fail('BILLING_GENERATION_NOT_FOUND','Generation unavailable for this account',404);
    if(['sponsored','personal'].includes(generation.billingScope))return {state:'externally-funded',replayed:false};
    if(!['reserved','streaming'].includes(generation.state))fail('BILLING_GENERATION_INVALID','Generation is not awaiting provider execution');
    if(generation.model!==currentPricing.model)fail('BILLING_MODEL_UNPRICED','Model has no server price version',409);
    return reserve(account,generationId,maximum,limits);
  }
  const settledCharge=(charge,replayed)=>({state:'settled',replayed,chargeNanoCny:String(charge.amount_nano),...(JSON.parse(charge.quote).creditSettlement??{})});
  const settle=atomic((account,generation,quote)=>{
    const old=db.prepare('SELECT * FROM geod_credit_charges WHERE account=? AND generation_id=?').get(account,generation.generationId);
    if(old)return settledCharge(old,true);
    const reservation=db.prepare('SELECT * FROM geod_credit_reservations WHERE account=? AND generation_id=?').get(account,generation.generationId);
    if(generation.state==='failed'&&reservation?.state==='released')return {state:'released',replayed:true,chargeNanoCny:'0'};
    if(!reservation||reservation.state!=='reserved')fail('BILLING_RESERVATION_REQUIRED','Original server reservation required',409);
    if(generation.state==='failed'){db.prepare('UPDATE geod_credit_reservations SET state=\'released\' WHERE account=? AND generation_id=?').run(account,generation.generationId);return {state:'released',chargeNanoCny:'0'};}
    const quoted=nano(quote.retailNanoCny),available=balance(account)-reserved(account,generation.generationId);
    const walletPolicy=JSON.parse(reservation.pricing_snapshot??'null')?.requestBounds?.billingPolicy==='wallet-until-empty-v1';
    // Old reservations keep their original strict contract. New requests spend
    // actual usage up to available wallet funds, never debit another request's
    // hold, and never create a negative wallet or a debt against future top-ups.
    if((!walletPolicy&&(quoted>BigInt(reservation.maximum_nano)||available<quoted))||available<0n)return {state:'settlement-review',reservationRetained:true};
    const amount=walletPolicy&&quoted>available?available:quoted;
    const creditSettlement=walletPolicy?{billingPolicy:'wallet-until-empty-v1',quotedNanoCny:String(quoted),waivedNanoCny:String(quoted-amount)}:null;
    let remaining=amount;
    for(const lot of db.prepare('SELECT * FROM geod_credit_lots WHERE account=? AND frozen=0 AND remaining_nano>0 ORDER BY CASE WHEN id IN (SELECT lot_id FROM geod_credit_grants) THEN 0 ELSE 1 END,created_at,id').all(account)){
      if(remaining===0n)break;const part=remaining<BigInt(lot.remaining_nano)?remaining:BigInt(lot.remaining_nano);
      db.prepare('UPDATE geod_credit_lots SET remaining_nano=remaining_nano-? WHERE id=?').run(part,lot.id);
      db.prepare('INSERT INTO geod_credit_allocations VALUES (?,?,?,?)').run(account,generation.generationId,lot.id,part);remaining-=part;
    }
    if(remaining!==0n)fail('BILLING_INSUFFICIENT_CREDIT','Credit changed during settlement',409);
    db.prepare('INSERT INTO geod_credit_charges VALUES (?,?,?,?,?)').run(account,generation.generationId,amount,JSON.stringify(creditSettlement?{...quote,creditSettlement}:quote),now());
    db.prepare('UPDATE geod_credit_reservations SET state=\'settled\' WHERE account=? AND generation_id=?').run(account,generation.generationId);
    return {state:'settled',replayed:false,chargeNanoCny:String(amount),...(creditSettlement??{})};
  });
  async function settleGeneration(account,generationId){
    if(!identity(account)||!identity(generationId))fail('BILLING_GENERATION_INVALID','Invalid generation binding');
    const generation=await loadGeneration(account,generationId);
    if(!generation||generation.generationId!==generationId)fail('BILLING_GENERATION_NOT_FOUND','Generation unavailable for this account',404);
    if(['sponsored','personal'].includes(generation.billingScope))return {state:'externally-funded',chargeNanoCny:'0'};
    if(!['failed','settled'].includes(generation.state))return {state:'waiting-for-provider',reservationRetained:true};
    const reservation=db.prepare('SELECT pricing_snapshot FROM geod_credit_reservations WHERE account=? AND generation_id=?').get(account,generationId);
    const charged=db.prepare('SELECT amount_nano,quote FROM geod_credit_charges WHERE account=? AND generation_id=?').get(account,generationId);
    if(charged)return settledCharge(charged,true);
    if(generation.state==='settled'&&!reservation?.pricing_snapshot)return {state:'settlement-review',code:'BILLING_PRICE_SNAPSHOT_MISSING',reservationRetained:true};
    const quote=generation.state==='failed'?null:quoteFromPricingSnapshot(generation,JSON.parse(reservation.pricing_snapshot));
    if(quote&&quote.status!=='priced')return {state:'waiting-for-usage',reservationRetained:true};
    return settle(account,generation,quote);
  }
  const freezeRefund=atomic((account,orderId)=>{
    const order=owned(account,orderId),old=db.prepare('SELECT * FROM geod_cash_refunds WHERE order_id=?').get(orderId);if(old)return old;
    if(order.status!=='paid'||JSON.parse(order.product).kind!=='topup')fail('PAYMENT_REFUND_REVIEW_REQUIRED','Only a fully unused top-up is eligible for this candidate cash-refund policy',409);
    const lot=db.prepare('SELECT * FROM geod_credit_lots WHERE id=?').get(orderId);
    if(!lot||lot.frozen||lot.remaining_nano!==lot.initial_nano)fail('PAYMENT_REFUND_USED','AI credit has already been used',409);
    if(balance(account)-BigInt(lot.remaining_nano)<reserved(account))fail('PAYMENT_REFUND_BUSY','AI executions still reserve this credit',409);
    const refundId='GDRF'+randomUUID().replaceAll('-','');
    db.prepare('UPDATE geod_credit_lots SET frozen=1 WHERE id=?').run(orderId);
    db.prepare('UPDATE geod_payment_orders SET status=\'refunding\' WHERE id=?').run(orderId);
    db.prepare('INSERT INTO geod_cash_refunds VALUES (?,?,?,?,\'pending\',?,?)').run(refundId,orderId,account,order.amount_fen,now(),now());
    return db.prepare('SELECT * FROM geod_cash_refunds WHERE id=?').get(refundId);
  });
  const safeRefund=r=>({refundId:r.id,orderId:r.order_id,amountFen:r.amount_fen,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,fixture:gateway?.fixture??false});
  const confirmRefund=atomic((refundId,evidence)=>{
    const refund=db.prepare('SELECT * FROM geod_cash_refunds WHERE id=?').get(refundId),order=row(refund.order_id);
    if(refund.status==='refunded')return {...safeRefund(refund),replayed:true};
    if(!evidence.refunded)return {...safeRefund(refund),reservationRetained:true};
    if(evidence.refundId!==refund.id||evidence.orderId!==order.id||evidence.tradeId!==order.trade_id||evidence.amountFen!==refund.amount_fen||evidence.environment!==gateway.environment)fail('PAYMENT_EVIDENCE_MISMATCH','Refund evidence does not match frozen order');
    db.prepare('UPDATE geod_cash_refunds SET status=\'refunded\',updated_at=? WHERE id=?').run(now(),refundId);
    db.prepare('UPDATE geod_payment_orders SET status=\'refunded\' WHERE id=?').run(order.id);
    db.prepare('UPDATE geod_credit_lots SET remaining_nano=0 WHERE id=? AND frozen=1').run(order.id);
    return {...safeRefund(db.prepare('SELECT * FROM geod_cash_refunds WHERE id=?').get(refundId)),replayed:false};
  });
  const refundOrder=(account,orderId)=>serialized(orderId,async()=>{
    const refund=freezeRefund(account,orderId),order=owned(account,orderId);
    if(refund.status==='refunded')return {...safeRefund(refund),replayed:true};
    const request={id:refund.id,amountFen:refund.amount_fen};
    try{
      // After ambiguity or restart query the original refund first. A pending
      // query never unfreezes funds; retry uses the same provider request ID.
      if(['uncertain','submitted'].includes(refund.status)){
        const queried=await gateway.queryRefund(providerOrder(order),request);
        if(queried.refunded)return confirmRefund(refund.id,queried);
      }
      db.prepare('UPDATE geod_cash_refunds SET status=\'submitted\',updated_at=? WHERE id=? AND status<>\'refunded\'').run(now(),refund.id);
      const evidence=await gateway.refund(providerOrder(order),request);return confirmRefund(refund.id,evidence);
    }catch(cause){db.prepare('UPDATE geod_cash_refunds SET status=\'uncertain\',updated_at=? WHERE id=? AND status<>\'refunded\'').run(now(),refund.id);throw cause;}
  });
  const requestFailedRunReview=atomic((account,runId)=>{
    if(!identity(account)||!identity(runId))fail('BILLING_REVIEW_INVALID','Invalid review request');
    // Local task failure is user-supplied information, not server-attested fact.
    db.prepare('INSERT OR IGNORE INTO geod_failure_refund_reviews VALUES (?, ?, \'review-required\', ?)').run(account,runId,now());
    return {runId,status:'review-required',creditGranted:false};
  });
  const safeCharge=charge=>{
    const quote=JSON.parse(charge.quote);
    return {generationId:charge.generation_id,chargeNanoCny:String(charge.amount_nano),createdAt:charge.created_at,
      model:quote.model??null,inputTokens:quote.inputTokens,cachedInputTokens:quote.cachedInputTokens,outputTokens:quote.outputTokens,
      reasoningTokens:quote.reasoningTokens??null,pricingVersion:quote.version,
      pricingDigest:quote.pricingSnapshot?hash(quote.pricingSnapshot):null,ratesNanoPerToken:quote.pricingSnapshot?.retailNanoPerToken??null,...(quote.creditSettlement??{})};
  };
  const safeReservation=reservation=>{
    const price=reservation.pricing_snapshot?JSON.parse(reservation.pricing_snapshot):null;
    return {generationId:reservation.generation_id,maximumNanoCny:String(reservation.maximum_nano),createdAt:reservation.created_at,
      pricingVersion:price?.version??null,model:price?.model??null,requestBounds:price?.requestBounds??null};
  };
  const history=createCreditHistory(path,db,{safeCharge,safeReservation,safeOrder,safeRefund,now});
  const summary=db.transaction(account=>({environment:gateway?.environment??'credits-only',fixture:gateway?.fixture??false,currency:'CNY',
    welcomeCreditStatus:welcomeStatus(),
    welcomeCreditDecision:db.prepare("SELECT state,policy_id AS policyId,created_at AS createdAt FROM geod_welcome_decisions WHERE account=? ORDER BY CASE state WHEN 'granted' THEN 0 ELSE 1 END,created_at DESC LIMIT 1").get(account)??null,
    balanceNanoCny:String(balance(account)),reservedNanoCny:String(reserved(account)),frozenNanoCny:String(frozen(account)),availableNanoCny:String(balance(account)-reserved(account)),
    subscription:db.prepare('SELECT expires_at AS expiresAt FROM geod_payment_subscriptions WHERE account=?').get(account)??null,
    orders:db.prepare('SELECT * FROM geod_payment_orders WHERE account=? ORDER BY created_at DESC,id LIMIT 100').all(account).map(safeOrder),
    orderCount:db.prepare('SELECT COUNT(*) AS count FROM geod_payment_orders WHERE account=?').get(account).count,
    refunds:db.prepare('SELECT * FROM geod_cash_refunds WHERE account=? ORDER BY created_at DESC,id DESC LIMIT 100').all(account).map(safeRefund),
    refundCount:db.prepare('SELECT COUNT(*) AS count FROM geod_cash_refunds WHERE account=?').get(account).count,
    charges:db.prepare('SELECT * FROM geod_credit_charges WHERE account=? ORDER BY created_at DESC,generation_id DESC LIMIT 100').all(account).map(safeCharge),
    chargeCount:db.prepare('SELECT COUNT(*) AS count FROM geod_credit_charges WHERE account=?').get(account).count,
    reservations:db.prepare('SELECT * FROM geod_credit_reservations WHERE account=? AND state=\'reserved\' ORDER BY created_at DESC,generation_id DESC LIMIT 100').all(account).map(safeReservation),
    reservationCount:db.prepare('SELECT COUNT(*) AS count FROM geod_credit_reservations WHERE account=? AND state=\'reserved\'').get(account).count,
    grants:db.prepare('SELECT g.kind,g.policy_id,g.amount_nano,g.created_at,l.remaining_nano FROM geod_credit_grants g JOIN geod_credit_lots l ON l.id=g.lot_id WHERE g.account=? ORDER BY g.created_at').all(account).map(g=>({kind:g.kind,policyId:g.policy_id,creditNanoCny:String(g.amount_nano),remainingNanoCny:String(g.remaining_nano),createdAt:g.created_at}))}));
  return {fixture:gateway?.fixture??false,environment:gateway?.environment??'credits-only',products:()=>[...catalog.values()],grantWelcome,welcomeStatus,createOrder,checkout,handleNotify,refreshOrder,cancelOrder,reserveGeneration,settleGeneration,refundOrder,requestFailedRunReview,summary,history:history.page,statement:history.statement,order:(account,id)=>safeOrder(owned(account,id)),close:()=>db.close()};
}
