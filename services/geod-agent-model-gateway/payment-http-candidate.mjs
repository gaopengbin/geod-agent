import {PaymentError} from './alipay-payment-candidate.mjs';
import {handleCreditHistory} from './credit-history.mjs';

const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(value));
async function body(req,limit=32768){
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>limit)throw new PaymentError('PAYMENT_BODY_TOO_LARGE','Request too large',413);chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
async function input(req,fields){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw new PaymentError('PAYMENT_INPUT_INVALID','JSON required',415);
  let value;try{value=JSON.parse(await body(req));}catch(cause){if(cause instanceof PaymentError)throw cause;throw new PaymentError('PAYMENT_INPUT_INVALID','Invalid JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw new PaymentError('PAYMENT_INPUT_INVALID','Unknown request fields');
  return value;
}
// The host injects GeoD's own account authenticator. It never accepts account
// IDs, prices, credit amounts, provider receipts or usage from a request body.
export function createPaymentCandidateHandler({ledger,authenticate}){
  if(!ledger||typeof authenticate!=='function')throw new Error('Payment ledger and GeoD authenticator required');
  return async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(!url.pathname.startsWith('/v1/payments'))return false;
    try{
      if(url.pathname==='/v1/payments/alipay/notify'&&req.method==='POST'){
        if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']??''))throw new PaymentError('PAYMENT_NOTIFY_INVALID','Form notification required',415);
        ledger.handleNotify(await body(req));
        res.writeHead(200,{'content-type':'text/plain','cache-control':'no-store'}).end('success');return true;
      }
      const account=await authenticate(req);
      if(typeof account!=='string'||!account)throw new PaymentError('AUTH_REQUIRED','GeoD sign-in required',401);
      if(await handleCreditHistory(req,res,url,ledger,account))return true;
      if(req.method==='GET'&&url.pathname==='/v1/payments/products'){json(res,200,{candidate:true,environment:ledger.environment,fixture:ledger.fixture,products:ledger.products()});return true;}
      if(req.method==='GET'&&url.pathname==='/v1/payments/wallet'){json(res,200,{candidate:true,...ledger.summary(account)});return true;}
      if(req.method==='POST'&&url.pathname==='/v1/payments/orders'){
        const value=await input(req,['requestKey','productId']);json(res,201,ledger.createOrder(account,value.requestKey,value.productId));return true;
      }
      if(req.method==='POST'&&url.pathname==='/v1/payments/failure-reviews'){
        const value=await input(req,['runId']);json(res,202,ledger.requestFailedRunReview(account,value.runId));return true;
      }
      const match=/^\/v1\/payments\/orders\/(GDA[0-9a-f]{32})(?:\/(checkout|refresh|cancel|refund))?$/.exec(url.pathname);
      if(match){
        const [,orderId,action]=match;
        if(req.method==='GET'&&!action){json(res,200,ledger.order(account,orderId));return true;}
        if(req.method==='POST'&&action){
          await input(req,[]);
          const result=action==='checkout'?ledger.checkout(account,orderId):action==='refresh'?await ledger.refreshOrder(account,orderId):action==='cancel'?await ledger.cancelOrder(account,orderId):await ledger.refundOrder(account,orderId);
          json(res,200,result);return true;
        }
      }
      throw new PaymentError('PAYMENT_NOT_FOUND','Payment route not found',404);
    }catch(cause){
      if(res.headersSent){res.destroy();return true;}
      if(url.pathname==='/v1/payments/alipay/notify'){res.writeHead(cause instanceof PaymentError?cause.status:500,{'content-type':'text/plain'}).end('failure');}
      else json(res,cause instanceof PaymentError?cause.status:500,{error:{code:cause instanceof PaymentError?cause.code:'PAYMENT_INTERNAL_ERROR',message:cause instanceof PaymentError?cause.message:'Payment operation could not be completed'}});
      return true;
    }
  };
}
