// GeoD-specific V2 website-payment adapter, candidate v1.
// Adapted from the owned platform-api/alipay-gateway.mjs (2026-10-04 snapshot).
// No dependency on that application's credentials, account store, or database.
import {readFileSync} from 'node:fs';
import {AlipaySdk} from 'alipay-sdk';

export class PaymentError extends Error {
  constructor(code,message,status=400){super(message);this.code=code;this.status=status;}
}
const fail=(code,message,status)=>{throw new PaymentError(code,message,status);};
const gateways={production:'https://openapi.alipay.com/gateway.do',sandbox:'https://openapi-sandbox.dl.alipaydev.com/gateway.do'};
const tradeId=value=>typeof value==='string'&&/^\d{10,64}$/.test(value);
export function parseAlipayFen(value){
  if(typeof value!=='string'||!/^\d{1,9}(?:\.\d{1,2})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
export function parseAlipayNotify(body){
  if(typeof body!=='string'||Buffer.byteLength(body)>32768)fail('PAYMENT_NOTIFY_INVALID','Invalid notification body');
  const fields=Object.create(null);
  for(const [key,value]of new URLSearchParams(body)){
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||Object.hasOwn(fields,key))fail('PAYMENT_NOTIFY_INVALID','Duplicate or invalid notification field');
    fields[key]=value;
  }
  return fields;
}
const money=fen=>`${Math.floor(fen/100)}.${String(fen%100).padStart(2,'0')}`;
function callbackUrl(value,fixture){
  let url;try{url=new URL(value);}catch{fail('PAYMENT_CONFIG_INVALID','Payment callback URL required');}
  if(url.username||url.password||url.hash||!url.hostname||!(url.protocol==='https:'||fixture&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail('PAYMENT_CONFIG_INVALID','HTTPS payment callback required');
  return url.href;
}
export function createAlipayPaymentCandidate(config){
  const fixture=config.environment==='fixture';
  if(!fixture&&!gateways[config.environment])fail('PAYMENT_CONFIG_INVALID','Explicit payment environment required');
  // Candidate setup must explicitly authorize network use. Fixture requests are
  // constrained to loopback and use generated keys; they are not real receipts.
  if(!fixture&&config.externalRequestsAuthorized!==true)fail('PAYMENT_NOT_ENABLED','External payment requests have not been enabled',503);
  if(!/^\d{16}$/.test(config.appId??'')||!/^\d{16}$/.test(config.sellerId??'')||!Number.isSafeInteger(config.maxSingleFen)||config.maxSingleFen<1||config.maxSingleFen>1_000_000)fail('PAYMENT_CONFIG_INVALID','Merchant identity and approved single-payment limit required');
  let gateway=gateways[config.environment];
  if(fixture){
    let url;try{url=new URL(config.fixtureGateway);}catch{fail('PAYMENT_CONFIG_INVALID','Local fixture URL required');}
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password)fail('PAYMENT_CONFIG_INVALID','Fixture gateway must be local');
    gateway=url.href;
  }
  const notifyUrl=callbackUrl(config.notifyUrl,fixture),returnUrl=callbackUrl(config.returnUrl,fixture);
  const privateKey=fixture?config.fixturePrivateKey:readFileSync(config.privateKeyPath,'ascii');
  const publicKey=fixture?config.fixtureProviderPublicKey:readFileSync(config.alipayPublicKeyPath,'ascii');
  if(typeof privateKey!=='string'||!privateKey.includes('PRIVATE KEY')||typeof publicKey!=='string'||!publicKey.includes('PUBLIC KEY'))fail('PAYMENT_CONFIG_INVALID','Private and provider verification keys required');
  const sdk=new AlipaySdk({appId:config.appId,privateKey,alipayPublicKey:publicKey,keyType:'PKCS8',signType:'RSA2',camelcase:false,gateway,timeout:config.timeoutMs??10000});
  function validateOrder(order){
    if(!/^GDA[0-9a-f]{32}$/.test(order.id??'')||!Number.isSafeInteger(order.amountFen)||order.amountFen<1||order.amountFen>config.maxSingleFen)fail('PAYMENT_ORDER_INVALID','Invalid GeoD order or payment limit');
  }
  function paymentEvidence(data,order,requireSeller){
    validateOrder(order);
    if(data.out_trade_no!==order.id||parseAlipayFen(data.total_amount)!==order.amountFen||((requireSeller||data.seller_id!==undefined)&&data.seller_id!==config.sellerId)||!tradeId(data.trade_no))fail('PAYMENT_EVIDENCE_MISMATCH','Payment evidence does not match order');
    const base={orderId:order.id,tradeId:data.trade_no,amountFen:order.amountFen,environment:config.environment};
    if(data.trade_status==='TRADE_CLOSED')return {...base,paid:false,closed:true};
    if(!['TRADE_SUCCESS','TRADE_FINISHED'].includes(data.trade_status))return {...base,paid:false};
    return {...base,paid:true};
  }
  async function execute(method,bizContent){
    try{return await sdk.exec(method,{bizContent},{validateSign:true});}
    catch{fail('PAYMENT_PROVIDER_UNCERTAIN','Provider result is unconfirmed; reconcile the original request',502);}
  }
  function refundIdentity(order,refund){
    validateOrder(order);
    if(!tradeId(order.tradeId)||!/^GDRF[0-9a-f]{32}$/.test(refund.id??'')||refund.amountFen!==order.amountFen)fail('PAYMENT_REFUND_INVALID','Original trade and full refund request required');
  }
  return {
    environment:config.environment,fixture,appId:config.appId,sellerId:config.sellerId,maxSingleFen:config.maxSingleFen,
    checkoutUrl(order){
      validateOrder(order);
      if(typeof order.subject!=='string'||!order.subject.trim()||Buffer.byteLength(order.subject)>256||/[\x00-\x1f]/.test(order.subject)||!Number.isFinite(order.expiresAt)||order.expiresAt<=Date.now())fail('PAYMENT_ORDER_INVALID','Order subject or expiry invalid');
      const result=sdk.pageExecute('alipay.trade.page.pay','GET',{notifyUrl,returnUrl,bizContent:{out_trade_no:order.id,total_amount:money(order.amountFen),subject:order.subject,product_code:'FAST_INSTANT_TRADE_PAY',time_expire:new Date(order.expiresAt+8*3600000).toISOString().slice(0,19).replace('T',' ')}});
      if(new URL(result).origin!==new URL(gateway).origin)fail('PAYMENT_PROVIDER_UNCERTAIN','Unexpected checkout origin',502);
      return result;
    },
    verifyNotification(body,order){
      const data=parseAlipayNotify(body);
      if(data.sign_type!=='RSA2'||!data.sign||!sdk.checkNotifySignV2(data))fail('PAYMENT_SIGNATURE_INVALID','Invalid payment notification signature');
      if(data.app_id!==config.appId)fail('PAYMENT_EVIDENCE_MISMATCH','Payment application mismatch');
      const result=paymentEvidence(data,order,true);
      return {...result,eventId:data.notify_id??null};
    },
    async query(order){
      validateOrder(order);const data=await execute('alipay.trade.query',{out_trade_no:order.id});
      if(data.code==='40004'&&data.sub_code==='ACQ.TRADE_NOT_EXIST')return {paid:false,missing:true,orderId:order.id};
      if(data.code!=='10000')fail('PAYMENT_PROVIDER_UNCERTAIN','Payment query not confirmed',502);
      return paymentEvidence(data,order,false);
    },
    async close(order){
      validateOrder(order);const data=await execute('alipay.trade.close',{out_trade_no:order.id});
      if(data.code!=='10000'||data.out_trade_no!==order.id||!tradeId(data.trade_no))fail('PAYMENT_PROVIDER_UNCERTAIN','Payment closure not confirmed',502);
      return {paid:false,closed:true,orderId:order.id,tradeId:data.trade_no,amountFen:order.amountFen,environment:config.environment};
    },
    async refund(order,refund){
      refundIdentity(order,refund);const data=await execute('alipay.trade.refund',{out_trade_no:order.id,trade_no:order.tradeId,out_request_no:refund.id,refund_amount:money(refund.amountFen),refund_reason:'GeoD 未使用 AI 余额退款'});
      if(data.code!=='10000'||data.trade_no!==order.tradeId||data.out_trade_no!==order.id||parseAlipayFen(data.refund_fee)!==refund.amountFen||!['Y','N'].includes(data.fund_change))fail('PAYMENT_PROVIDER_UNCERTAIN','Cash refund not confirmed',502);
      return {refunded:true,refundId:refund.id,orderId:order.id,tradeId:order.tradeId,amountFen:refund.amountFen,environment:config.environment};
    },
    async queryRefund(order,refund){
      refundIdentity(order,refund);const data=await execute('alipay.trade.fastpay.refund.query',{out_trade_no:order.id,out_request_no:refund.id});
      if(data.code==='40004')return {refunded:false,pending:true,refundId:refund.id};
      if(data.code!=='10000'||data.trade_no!==order.tradeId||data.out_trade_no!==order.id||data.out_request_no!==refund.id||parseAlipayFen(data.refund_amount)!==refund.amountFen)fail('PAYMENT_PROVIDER_UNCERTAIN','Refund query not confirmed',502);
      return {refunded:data.refund_status==='REFUND_SUCCESS',pending:data.refund_status!=='REFUND_SUCCESS',refundId:refund.id,orderId:order.id,tradeId:order.tradeId,amountFen:refund.amountFen,environment:config.environment};
    },
  };
}
