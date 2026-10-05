// Account-owned, read-only payment history. Signed cursors survive restart and
// exclude later inserts; exports hold their own WAL snapshot without blocking writers.
import Database from 'better-sqlite3';
import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {PaymentError} from './alipay-payment-candidate.mjs';

const kinds={usage:{table:'geod_credit_charges',id:'generation_id'},reservations:{table:'geod_credit_reservations',id:'generation_id'},
  orders:{table:'geod_payment_orders',id:'id'},refunds:{table:'geod_cash_refunds',id:'id'}};
const invalid=()=>{throw new PaymentError('PAYMENT_HISTORY_INVALID','Invalid payment history request');};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f]/.test(value);
const time=value=>value===null||(Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000);
const scope=account=>createHash('sha256').update(account).digest('hex');
const validate=(account,kind,from,to)=>{
  if(!text(account)||!Object.hasOwn(kinds,kind)||!time(from)||!time(to)||(from!==null&&to!==null&&from>=to))invalid();
};
export const csvField=value=>{
  let field=String(value??'');
  if(/^\s*[=+\-@]|^[\t\r\n]/.test(field))field="'"+field;
  return '"'+field.replaceAll('"','""')+'"';
};
export function decimalAmount(value,scale){
  const amount=BigInt(value),unit=10n**BigInt(scale);
  if(amount<0n)invalid();
  const fraction=String(amount%unit).padStart(scale,'0').replace(/0+$/,'');
  return String(amount/unit)+(fraction?'.'+fraction:'');
}
const csvRow=values=>values.map(csvField).join(',')+'\r\n';
const utc=value=>new Date(value).toISOString();
const where=(kind,from,to)=>`${kind==='reservations'?" AND state='reserved'":''}${from!==null?' AND created_at>=?':''}${to!==null?' AND created_at<?':''}`;
const dates=(from,to)=>[...(from!==null?[from]:[]),...(to!==null?[to]:[])];

export function createCreditHistory(path,db,{safeCharge,safeReservation,safeOrder,safeRefund,now}){
  db.exec(`CREATE INDEX IF NOT EXISTS geod_credit_charge_history ON geod_credit_charges(account,created_at DESC,generation_id DESC);
    CREATE INDEX IF NOT EXISTS geod_credit_reservation_history ON geod_credit_reservations(account,state,created_at DESC,generation_id DESC);
    CREATE INDEX IF NOT EXISTS geod_payment_order_history ON geod_payment_orders(account,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS geod_cash_refund_history ON geod_cash_refunds(account,created_at DESC,id DESC);`);
  db.prepare('INSERT OR IGNORE INTO geod_payment_meta VALUES (?,?)').run('credit-history-cursor-key',randomBytes(32).toString('hex'));
  const secret=Buffer.from(db.prepare('SELECT value FROM geod_payment_meta WHERE key=?').get('credit-history-cursor-key').value,'hex');
  if(secret.length!==32)invalid();
  const sign=payload=>createHmac('sha256',secret).update(payload).digest();
  const encode=value=>{
    const payload=Buffer.from(JSON.stringify(value)).toString('base64url');
    return payload+'.'+sign(payload).toString('base64url');
  };
  function decode(cursor){
    if(typeof cursor!=='string'||cursor.length>2048||! /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))invalid();
    const [payload,signature]=cursor.split('.'),supplied=Buffer.from(signature,'base64url'),expected=sign(payload);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))invalid();
    try{return JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{invalid();}
  }
  const map={usage:safeCharge,reservations:safeReservation,orders:safeOrder,refunds:safeRefund};
  const page=db.transaction((account,kind,{cursor=null,from=null,to=null,limit=20}={})=>{
    validate(account,kind,from,to);
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)invalid();
    const {table,id}=kinds[kind];
    const state=cursor===null?{v:1,kind,from,to,scope:scope(account),maximum:db.prepare(`SELECT COALESCE(MAX(rowid),0) AS maximum FROM ${table} WHERE account=?`).get(account).maximum,asOf:now(),before:null}:decode(cursor);
    if(state.v!==1||state.kind!==kind||state.from!==from||state.to!==to||state.scope!==scope(account)||
      !Number.isSafeInteger(state.maximum)||state.maximum<0||!time(state.asOf)||
      (cursor!==null&&(!state.before||!time(state.before.at)||state.before.at===null||!text(state.before.id))))invalid();
    const condition=where(kind,from,to),params=[account,state.maximum,...dates(from,to)];
    const totalCount=db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account=? AND rowid<=?${condition}`).get(...params).count;
    const before=state.before;
    // The cursor freezes inserted membership; each page reads current status.
    // Mutable cash statuses are intentionally not pagination filters.
    const rows=db.prepare(`SELECT * FROM ${table} WHERE account=? AND rowid<=?${condition}${before?` AND (created_at<? OR (created_at=? AND ${id}<?))`:''} ORDER BY created_at DESC,${id} DESC LIMIT ?`)
      .all(...params,...(before?[before.at,before.at,before.id]:[]),limit+1);
    const more=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);
    return {kind,from,to,asOf:state.asOf,totalCount,items:items.map(map[kind]),
      nextCursor:more?encode({...state,before:{at:last.created_at,id:last[id]}}):null};
  });
  function statement(account,kind,{from=null,to=null}={}){
    validate(account,kind,from,to);
    if(path===':memory:')throw new PaymentError('PAYMENT_STATEMENT_UNAVAILABLE','Persistent ledger required',409);
    const reader=new Database(path,{readonly:true});reader.pragma('busy_timeout = 10000');reader.pragma('query_only = ON');
    let finished=false;
    const close=()=>{if(finished)return;finished=true;try{if(reader.inTransaction)reader.exec('ROLLBACK');}finally{reader.close();}};
    try{
      reader.exec('BEGIN DEFERRED');
      const {table,id}=kinds[kind],condition=where(kind,from,to),params=[account,...dates(from,to)];
      const count=reader.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account=?${condition}`).get(...params).count;
      if(count>100_000)throw new PaymentError('PAYMENT_STATEMENT_TOO_LARGE','Narrow the export date range',413);
      const rows=()=>reader.prepare(`SELECT * FROM ${table} WHERE account=?${condition} ORDER BY created_at DESC,${id} DESC`).iterate(...params);
      const heading={usage:['generation_id','model','input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','charge_credits','charge_cny','price_version','uncached_input_credits_per_million','cached_input_credits_per_million','output_credits_per_million','price_digest','settled_at_utc'],
        reservations:['generation_id','model','reserved_credits','price_version','created_at_utc'],
        orders:['order_id','product_id','product_name','product_kind','price_fen','price_cny','credit_credits','status','created_at_utc','expires_at_utc','paid_at_utc','environment','fixture'],
        refunds:['refund_id','order_id','amount_fen','amount_cny','status','created_at_utc','updated_at_utc','fixture']}[kind];
      function* chunks(){
        yield '\ufeff'+csvRow(heading);
        let chunk='',n=0;
        for(const raw of rows()){
          const item=map[kind](raw);
          const values=kind==='usage'?[item.generationId,item.model,item.inputTokens,item.cachedInputTokens,item.outputTokens,item.reasoningTokens,
            decimalAmount(item.chargeNanoCny,6),decimalAmount(item.chargeNanoCny,9),item.pricingVersion,
            ...['uncachedInput','cachedInput','output'].map(name=>item.ratesNanoPerToken?decimalAmount(BigInt(item.ratesNanoPerToken[name])*1_000_000n,6):''),item.pricingDigest,utc(item.createdAt)]:
            kind==='reservations'?[item.generationId,item.model,decimalAmount(item.maximumNanoCny,6),item.pricingVersion,utc(item.createdAt)]:
            kind==='orders'?[item.orderId,item.product.id,item.product.name,item.product.kind,item.priceFen,decimalAmount(item.priceFen,2),decimalAmount(item.creditNanoCny,6),item.status,utc(item.createdAt),utc(item.expiresAt),item.paidAt===null?'':utc(item.paidAt),item.environment,item.fixture]:
            [item.refundId,item.orderId,item.amountFen,decimalAmount(item.amountFen,2),item.status,utc(item.createdAt),utc(item.updatedAt),item.fixture];
          chunk+=csvRow(values);
          if(++n%100===0){yield chunk;chunk='';}
        }
        if(chunk)yield chunk;
      }
      const digest=createHash('sha256');let bytes=0;
      for(const chunk of chunks()){
        const data=Buffer.from(chunk);bytes+=data.length;
        if(bytes>64*1024*1024)throw new PaymentError('PAYMENT_STATEMENT_TOO_LARGE','Narrow the export date range',413);
        digest.update(data);
      }
      return {count,bytes,sha256:digest.digest('hex'),asOf:now(),chunks,close};
    }catch(cause){close();throw cause;}
  }
  return {page,statement};
}

const options=(url,exporting)=>{
  const allowed=exporting?['from','to']:['from','to','cursor','limit'];
  for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)invalid();
  const integer=(key,fallback)=>{
    const value=url.searchParams.get(key);
    if(value===null)return fallback;
    if(! /^(0|[1-9][0-9]*)$/.test(value))invalid();
    return Number(value);
  };
  return {from:integer('from',null),to:integer('to',null),...(exporting?{}:{cursor:url.searchParams.get('cursor'),limit:integer('limit',20)})};
};
// Authentication has already selected the account; no caller-supplied owner is accepted.
export async function handleCreditHistory(req,res,url,ledger,account){
  const match=/^\/v1\/payments\/history\/(usage|reservations|orders|refunds)(\/export\.csv)?$/.exec(url.pathname);
  if(!match)return false;
  if(req.method!=='GET')throw new PaymentError('PAYMENT_HISTORY_METHOD','GET required',405);
  if(!ledger)throw new PaymentError('PAYMENT_HISTORY_UNAVAILABLE','Payment history is unavailable',404);
  const [,kind,exporting]=match,query=options(url,!!exporting);
  if(!exporting){
    const result=ledger.history(account,kind,query);
    res.writeHead(200,{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(result));
    return true;
  }
  const report=ledger.statement(account,kind,query);
  try{
    res.writeHead(200,{'content-type':'text/csv;charset=utf-8','content-length':String(report.bytes),'cache-control':'no-store','x-content-type-options':'nosniff',
      'content-disposition':`attachment; filename="geod-${kind==='orders'||kind==='refunds'?'payments':'credits'}-${kind}.csv"`,'x-geod-record-count':String(report.count),'x-geod-statement-sha256':report.sha256,'x-geod-statement-as-of':String(report.asOf)});
    await pipeline(Readable.from(report.chunks()),res);
  }finally{report.close();}
  return true;
}
