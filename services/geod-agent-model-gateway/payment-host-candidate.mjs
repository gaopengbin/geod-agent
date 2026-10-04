// Optional, server-owned payment wiring. No configuration means no payment
// database, no provider request and no change to the existing test allowance.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createAlipayPaymentCandidate,PaymentError} from './alipay-payment-candidate.mjs';
import {createPaymentLedgerCandidate,paymentProductsCandidate} from './payment-ledger-candidate.mjs';
import {createPaymentCandidateHandler} from './payment-http-candidate.mjs';
import {pricingCandidate} from './pricing-candidate.mjs';

export function paymentCatalogueDigest(products=paymentProductsCandidate){
  if(!Array.isArray(products)||!products.length)throw new PaymentError('PAYMENT_CONFIG_INVALID','Server catalogue required');
  const terms=products.map(p=>({id:p.id,name:p.name,kind:p.kind,priceFen:p.priceFen,creditNanoCny:p.creditNanoCny,days:p.days}))
    .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}
function requireReviewedTerms(options){
  if(!options||options.gateway?.environment==='fixture')return;
  if(options.catalogueApproved!==true)throw new PaymentError('PAYMENT_CATALOGUE_NOT_APPROVED','Reviewed catalogue required');
  if(options.approvedPricingVersion!==pricingCandidate.version||options.approvedCatalogueSha256!==paymentCatalogueDigest(options.products))
    throw new PaymentError('PAYMENT_TERMS_NOT_APPROVED','Reviewed price version and catalogue fingerprint required');
}

export function readPaymentHostConfig(env){
  if(!env.GEOD_AGENT_PAYMENT_CONFIG)return null;
  const path=resolve(env.GEOD_AGENT_PAYMENT_CONFIG);
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||
    !['observe','enforced'].includes(value.billingMode)||typeof value.dbPath!=='string'||!value.dbPath||
    !Number.isSafeInteger(value.maxDailyFen)||value.maxDailyFen<1||!value.gateway)
    throw new PaymentError('PAYMENT_CONFIG_INVALID','Invalid server payment configuration');
  // Draft products must be explicitly adopted by a reviewed deployment. Merely
  // adding merchant keys cannot start selling the proposed catalogue.
  requireReviewedTerms(value);
  return {...value,dbPath:resolve(value.dbPath)};
}
const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(value));

export function createPaymentHostCandidate(config,modelLedger,authenticate){
  const options=config.payment??null;
  if(options&&!['observe','enforced'].includes(options.billingMode))throw new PaymentError('PAYMENT_CONFIG_INVALID','Invalid billing policy');
  requireReviewedTerms(options);
  if(options&&resolve(options.dbPath)===resolve(config.dbPath))
    throw new PaymentError('PAYMENT_LEDGER_SCOPE','Payment and model ledgers must use different files');
  if(options?.billingMode==='enforced'&&config.model!==pricingCandidate.model)
    throw new PaymentError('BILLING_MODEL_UNPRICED','Model has no reviewed candidate price');
  const provider=options?createAlipayPaymentCandidate(options.gateway):null;
  const ledger=provider?createPaymentLedgerCandidate(options.dbPath,{gateway:provider,maxDailyFen:options.maxDailyFen,
    ...(options.products?{products:options.products}:{}),loadGeneration:(account,id)=>modelLedger.get(account,id)}):null;
  const status=()=>({candidate:true,checkoutEnabled:!!ledger,environment:provider?.environment??'disabled',fixture:provider?.fixture??false,
    billingMode:options?.billingMode==='enforced'?'prepaid':config.quotaEnforced===false?'unlimited-test':'token-quota',
    pricingVersion:pricingCandidate.version,pricesApproved:options?.catalogueApproved===true,
    catalogueSha256:paymentCatalogueDigest(ledger?.products()??paymentProductsCandidate),
    products:ledger?.products()??paymentProductsCandidate});
  const paymentHandler=ledger?createPaymentCandidateHandler({ledger,authenticate}):null;
  async function handle(req,res){
    const url=new URL(req.url,'http://127.0.0.1');
    if(!url.pathname.startsWith('/v1/payments'))return false;
    if(ledger&&url.pathname!=='/v1/payments/status')return paymentHandler(req,res);
    try{
      const account=await authenticate(req);
      if(typeof account!=='string'||!account)throw new PaymentError('AUTH_REQUIRED','GeoD sign-in required',401);
      if(req.method==='GET'&&url.pathname==='/v1/payments/status'){json(res,200,status());return true;}
      if(!ledger&&req.method==='GET'&&url.pathname==='/v1/payments/products'){json(res,200,status());return true;}
      if(!ledger&&req.method==='GET'&&url.pathname==='/v1/payments/wallet'){
        json(res,200,{...status(),currency:'CNY',balanceNanoCny:null,reservedNanoCny:null,frozenNanoCny:null,availableNanoCny:null,subscription:null,orders:[],refunds:[],charges:[],chargeCount:0,reservations:[],reservationCount:0});return true;
      }
      throw new PaymentError('PAYMENT_DISABLED','Payments have not been enabled',409);
    }catch(cause){json(res,cause instanceof PaymentError?cause.status:500,{error:{code:cause instanceof PaymentError?cause.code:'PAYMENT_INTERNAL_ERROR',message:cause instanceof PaymentError?cause.message:'Payment operation unavailable'}});return true;}
  }
  async function reserve(account,generationId,{sponsored=false,codex=false}={}){
    if(!ledger||options.billingMode!=='enforced'||sponsored)return;
    // A server-configured upper bound, never a client-supplied amount. Actual
    // signed provider usage determines settlement; an overrun stays in review.
    const maximum=BigInt(config.contextWindow)*pricingCandidate.retail.uncachedInput+
      BigInt(codex?config.maxOutputTokens:2048)*pricingCandidate.retail.output;
    await ledger.reserveGeneration(account,generationId,String(maximum));
  }
  async function settlement(account,generation){
    if(!generation||!ledger||options.billingMode!=='enforced'||generation.billingScope==='sponsored')return generation;
    try{return {...generation,billing:await ledger.settleGeneration(account,generation.generationId)};}
    catch(cause){return {...generation,billing:{state:'settlement-review',code:cause instanceof PaymentError?cause.code:'BILLING_RECONCILE_REQUIRED'}};}
  }
  return {handle,status,reserve,settlement,prepaid:options?.billingMode==='enforced',close:()=>ledger?.close()};
}
