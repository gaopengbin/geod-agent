// Read-only, account-owned history. Cursor terms persist across restart; CSV
// uses a separate WAL snapshot so model/payment writers can continue normally.
// Unverified follow-up draft. Excluded from the frozen 0.2.0 release.
import Database from 'better-sqlite3';
import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {PaymentError} from './alipay-payment-candidate.mjs';

const invalid=()=>{throw new PaymentError('PAYMENT_HISTORY_INVALID','Invalid payment history request');};
const kinds={orders:{table:'geod_payment_orders',id:'id'},usage:{table:'geod_credit_charges',id:'generation_id'},reservations:{table:'geod_credit_reservations',id:'generation_id'}};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f]/.test(value);
const accountScope=account=>createHash('sha256').update(account).digest('hex');
export const csvField=value=>{
  let result=String(value??'');
  if(/^[\s]*[=+\-@]|^[\t\r\n]/.test(result))result="'"+result;
  return '"'+result.replaceAll('"','""')+'"';
};
export function decimalCny(value,scale=9){
  const amount=BigInt(value),unit=10n**BigInt(scale);
  if(amount<0n)invalid();
  const fraction=String(amount%unit).padStart(scale,'0').replace(/0+$/,'').padEnd(2,'0');
  return String(amount/unit)+'.'+fraction;
}
const csvRow=values=>values.map(csvField).join(',')+'\r\n';
const utc=value=>value==null?'':new Date(value).toISOString();

export function createPaymentHistoryCandidate(path,db,{safeOrder,safeCharge,safeReservation,now}){
  db.prepare('INSERT OR IGNORE INTO geod_payment_meta VALUES (?,?)').run('history-cursor-key',randomBytes(32).toString('hex'));
  const secret=Buffer.from(db.prepare('SELECT value FROM geod_payment_meta WHERE key=?').get('history-cursor-key').value,'hex');
  if(secret.length!==32)invalid();
  const sign=encoded=>createHmac('sha256',secret).update(encoded).digest();
  const encode=value=>{const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return payload+'.'+sign(payload).toString('base64url');};
  function decode(cursor){
    if(typeof cursor!=='string'||cursor.length>2048||! /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))invalid();
    const [payload,signature]=cursor.split('.'),supplied=Buffer.from(signature,'base64url'),expected=sign(payload);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))invalid();
    try{return JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{invalid();}
  }
  const map={orders:safeOrder,usage:safeCharge,reservations:safeReservation};
  const page=db.transaction((account,kind,{cursor=null,filter='all',limit=100}={})=>{
    if(!text(account)||!kinds[kind]||!Number.isSafeInteger(limit)||limit<1||limit>200||!['all','pending'].includes(filter)||(filter!=='all'&&kind!=='orders'))invalid();
    const {table,id}=kinds[kind],scope=accountScope(account);
    const state=decodeOrFirst();
    function decodeOrFirst(){
      if(!cursor)return {v:1,kind,filter,scope,maximum:db.prepare(`SELECT COALESCE(MAX(rowid),0) AS maximum FROM ${table} WHERE account=?`).get(account).maximum,asOf:now(),before:null};
      const value=decode(cursor);
      if(value.v!==1||value.kind!==kind||value.filter!==filter||value.scope!==scope||!Number.isSafeInteger(value.maximum)||value.maximum<0||
        !Number.isSafeInteger(value.asOf)||value.asOf<0||!value.before||!Number.isSafeInteger(value.before.at)||value.before.at<0||!text(value.before.id))invalid();
      return value;
    }
    const condition=kind==='reservations'?" AND state='reserved'":filter==='pending'?" AND status IN ('pending','cancel-requested','payment-review','refunding')":'';
    const count=db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account=? AND rowid<=?${condition}`).get(account,state.maximum).count;
    const before=state.before;
    const rows=db.prepare(`SELECT * FROM ${table} WHERE account=? AND rowid<=?${condition}${before?` AND (created_at<? OR (created_at=? AND ${id}<?))`:''} ORDER BY created_at DESC,${id} DESC LIMIT ?`)
      .all(account,state.maximum,...(before?[before.at,before.at,before.id]:[]),limit+1);
    const more=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);
    return {kind,filter,asOf:state.asOf,totalCount:count,items:items.map(map[kind]),
      nextCursor:more?encode({...state,before:{at:last.created_at,id:last[id]}}):null};
  });
  function statement(account,kind){
    if(!text(account)||!['orders','usage'].includes(kind))invalid();
    if(path===':memory:')throw new PaymentError('PAYMENT_STATEMENT_UNAVAILABLE','Persistent ledger required',409);
    const reader=new Database(path,{readonly:true});reader.pragma('busy_timeout = 10000');reader.pragma('query_only = ON');
    let finished=false;
    const close=()=>{if(finished)return;finished=true;try{if(reader.inTransaction)reader.exec('ROLLBACK');}finally{reader.close();}};
    try{
      reader.exec('BEGIN DEFERRED');
      const {table,id}=kinds[kind],count=reader.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account=?`).get(account).count;
      const rows=()=>reader.prepare(`SELECT * FROM ${table} WHERE account=? ORDER BY created_at DESC,${id} DESC`).iterate(account);
      const heading=kind==='orders'?['order_id','product','kind','amount_cny','ai_credit_cny','status','created_at_utc','paid_at_utc','expires_at_utc','environment']:
        ['generation_id','model','input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','charge_cny','price_version','uncached_input_cny_per_million','cached_input_cny_per_million','output_cny_per_million','price_digest','settled_at_utc'];
      function* chunks(){
        yield '\ufeff'+csvRow(heading);
        let chunk='',n=0;
        for(const raw of rows()){
          const item=map[kind](raw);
          const values=kind==='orders'?[item.orderId,item.product.name,item.product.kind,decimalCny(item.priceFen,2),decimalCny(item.creditNanoCny),item.status,utc(item.createdAt),utc(item.paidAt),utc(item.expiresAt),item.environment]:
            [item.generationId,item.model,item.inputTokens,item.cachedInputTokens,item.outputTokens,item.reasoningTokens,decimalCny(item.chargeNanoCny),item.pricingVersion,
              ...['uncachedInput','cachedInput','output'].map(name=>item.ratesNanoPerToken?decimalCny(BigInt(item.ratesNanoPerToken[name])*1_000_000n):''),item.pricingDigest,utc(item.createdAt)];
          chunk+=csvRow(values);
          if(++n%100===0){yield chunk;chunk='';}
        }
        if(chunk)yield chunk;
      }
      const digest=createHash('sha256');let bytes=0;for(const chunk of chunks()){const data=Buffer.from(chunk);bytes+=data.length;digest.update(data);}
      return {count,bytes,sha256:digest.digest('hex'),asOf:now(),chunks,close};
    }catch(cause){close();throw cause;}
  }
  return {page,statement};
}
