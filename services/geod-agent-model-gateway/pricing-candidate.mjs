// Local, inactive pricing candidate. Amounts are integer nano-CNY; no per-call cent rounding.
import Database from 'better-sqlite3';
export const pricingCandidate=Object.freeze({
 version:'geod-flash-candidate-2026-10-02',active:false,currency:'CNY',model:'deepseek-flash',
 priceSource:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
 subscriptionCny:29,includedAiCreditCny:10,
 // Nano-CNY per token; public provider prices per million tokens are .02 / 1 / 4 off peak.
 provider:{offPeak:{cachedInput:20n,uncachedInput:1000n,output:4000n},peak:{cachedInput:40n,uncachedInput:2000n,output:8000n}},
 retail:{cachedInput:80n,uncachedInput:4000n,output:16000n},
 localExecutionPrice:0,failedTaskPolicy:'Refund AI credit for a verified failed whole task; keep supplier cost in the report.',
});
const rateNames=['cachedInput','uncachedInput','output'];
const snapshotRates=rates=>Object.freeze(Object.fromEntries(rateNames.map(name=>{
 const value=rates?.[name];
 if(!['bigint','string'].includes(typeof value)||!/^[0-9]+$/.test(String(value)))throw new Error('Invalid server price rate');
 const amount=BigInt(value);if(amount>1_000_000_000n)throw new Error('Server price rate out of range');
 return [name,String(amount)];
})));
// JSON-safe immutable terms captured before provider execution. A new release
// or rate version must not reinterpret a request already awaiting settlement.
export function capturePricingSnapshot(prices=pricingCandidate,period='peak'){
 if(!['peak','offPeak'].includes(period))throw new Error('Explicit provider rate period required');
 if(prices.currency!=='CNY'||typeof prices.model!=='string'||!prices.model||prices.model.length>120||
   typeof prices.version!=='string'||! /^[a-zA-Z0-9._-]{1,120}$/.test(prices.version))throw new Error('Invalid server price version');
 return Object.freeze({schema:1,version:prices.version,currency:'CNY',model:prices.model,period,
  retailNanoPerToken:snapshotRates(prices.retail),providerNanoPerToken:snapshotRates(prices.provider?.[period])});
}
export function quoteFromPricingSnapshot(generation,snapshot){
  if(['sponsored','personal'].includes(generation.billingScope))return {status:'externally_funded',billingScope:generation.billingScope,retailNanoCny:'0',providerNanoCny:null};
 if(!snapshot||snapshot.schema!==1)throw new Error('Original server price snapshot required');
 const rates=capturePricingSnapshot({currency:snapshot.currency,model:snapshot.model,version:snapshot.version,
  retail:snapshot.retailNanoPerToken,provider:{[snapshot.period]:snapshot.providerNanoPerToken}},snapshot.period);
  if(generation.state!=='settled')return {status:'unpriced',reason:'No settled usage; supplier cost may be unknown'};
 if(generation.model!==rates.model)throw new Error('Model does not match its original price version');
 const input=generation.inputTokens,output=generation.outputTokens,cached=generation.cachedInputTokens;
 if(cached==null)return {status:'unpriced',reason:'Cache usage unavailable; do not infer zero cache'};
 if(![input,output,cached].every(value=>Number.isSafeInteger(value)&&value>=0)||cached>input)throw new Error('Invalid provider usage');
 if(generation.reasoningTokens!=null&&(!Number.isSafeInteger(generation.reasoningTokens)||generation.reasoningTokens<0||generation.reasoningTokens>output))throw new Error('Invalid reasoning usage');
 const counts={cachedInput:BigInt(cached),uncachedInput:BigInt(input-cached),output:BigInt(output)};
 const cost=values=>Object.entries(counts).reduce((sum,[name,count])=>sum+count*BigInt(values[name]),0n);
 return {status:'priced',version:rates.version,model:rates.model,pricingSnapshot:rates,providerCostEstimated:true,
  providerNanoCny:cost(rates.providerNanoPerToken).toString(),retailNanoCny:cost(rates.retailNanoPerToken).toString(),
  period:rates.period,inputTokens:input,cachedInputTokens:cached,outputTokens:output,reasoningTokens:generation.reasoningTokens??null};
}
export const settledQuote=(generation,period)=>quoteFromPricingSnapshot(generation,capturePricingSnapshot(pricingCandidate,period));
export const cny=amount=>Number(BigInt(amount))/1e9;
export function createPricingPreview(path){
 const db=new Database(path);db.pragma('journal_mode = WAL');
 db.exec(`CREATE TABLE IF NOT EXISTS preview_wallet(account TEXT PRIMARY KEY,balance_nano INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS preview_receipts(account TEXT,generation_id TEXT,task_id TEXT,version TEXT,charge_nano INTEGER,provider_nano INTEGER,refunded INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,generation_id));`);
 const credit=db.transaction((account,amount)=>{if(typeof amount!=='bigint'||amount<=0n||amount>1000000000000000n)throw new Error('Invalid preview credit');db.prepare('INSERT INTO preview_wallet VALUES (?,?) ON CONFLICT(account) DO UPDATE SET balance_nano=balance_nano+excluded.balance_nano').run(account,amount);});
 const settle=db.transaction((account,taskId,generation,period)=>{
  if(!generation.generationId||!taskId)throw new Error('Missing idempotency key');
  const existing=db.prepare('SELECT * FROM preview_receipts WHERE account=? AND generation_id=?').get(account,generation.generationId);
  if(existing){if(existing.task_id!==taskId)throw new Error('Generation already belongs to another task');return {replayed:true,chargeNanoCny:String(existing.charge_nano),refunded:!!existing.refunded};}
  const quote=settledQuote(generation,period);if(quote.status!=='priced')return quote;
  const charge=BigInt(quote.retailNanoCny),wallet=db.prepare('SELECT balance_nano FROM preview_wallet WHERE account=?').get(account);
  if(!wallet||BigInt(wallet.balance_nano)<charge)return {status:'insufficient_preview_credit'};
  db.prepare('INSERT INTO preview_receipts(account,generation_id,task_id,version,charge_nano,provider_nano) VALUES (?,?,?,?,?,?)').run(account,generation.generationId,taskId,quote.version,charge,BigInt(quote.providerNanoCny));
  db.prepare('UPDATE preview_wallet SET balance_nano=balance_nano-? WHERE account=?').run(charge,account);
  return {replayed:false,...quote};
 });
 const refundFailedTask=db.transaction((account,taskId,verifiedState)=>{
  if(verifiedState!=='failed')throw new Error('Refund requires verified task failure');
  const amount=db.prepare('SELECT COALESCE(SUM(charge_nano),0) AS amount FROM preview_receipts WHERE account=? AND task_id=? AND refunded=0').get(account,taskId).amount;
  db.prepare('UPDATE preview_receipts SET refunded=1 WHERE account=? AND task_id=? AND refunded=0').run(account,taskId);
  db.prepare('UPDATE preview_wallet SET balance_nano=balance_nano+? WHERE account=?').run(amount,account);
  return {refundNanoCny:String(amount)};
 });
 return {active:false,credit,settle,refundFailedTask,balance:account=>String(db.prepare('SELECT balance_nano FROM preview_wallet WHERE account=?').get(account)?.balance_nano??0),receipts:account=>db.prepare('SELECT generation_id,task_id,version,charge_nano,provider_nano,refunded FROM preview_receipts WHERE account=?').all(account),close:()=>db.close()};
}
