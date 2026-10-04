import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createSign,createVerify,randomUUID} from 'node:crypto';
import {createAlipayPaymentCandidate,parseAlipayFen,parseAlipayNotify} from '../../alipay-payment-candidate.mjs';
import {createPaymentLedgerCandidate} from '../../payment-ledger-candidate.mjs';
import {createPaymentCandidateHandler} from '../../payment-http-candidate.mjs';

const sign=(text,key)=>createSign('RSA-SHA256').update(text).sign(key,'base64');
const content=(fields,notification=false)=>Object.keys(fields).filter(key=>key!=='sign'&&(!notification||key!=='sign_type')).sort().map(key=>`${key}=${fields[key]}`).join('&');
export async function fixture({maxDailyFen=100000}={}){
  const root=mkdtempSync(join(tmpdir(),'geod-payment-candidate-'));
  const app=generateKeyPairSync('rsa',{modulusLength:2048}),provider=generateKeyPairSync('rsa',{modulusLength:2048});
  const trades=new Map(),refunds=new Map(),calls=[],generations=new Map();let ledger;
  let clock=Date.now(),serial=0,refundMode='normal',closeMode='missing',badQuerySignature=false;
  const appId='9999000000000001',sellerId='9999000000000002';
  const providerServer=http.createServer(async(req,res)=>{
    const body=[];for await(const chunk of req)body.push(chunk);
    const fields={...Object.fromEntries(new URL(req.url,'http://127.0.0.1').searchParams),...Object.fromEntries(new URLSearchParams(Buffer.concat(body).toString()))};
    const valid=createVerify('RSA-SHA256').update(content(fields)).verify(app.publicKey,fields.sign??'','base64');
    if(!valid||fields.app_id!==appId){res.writeHead(400).end('invalid app signature');return;}
    const biz=JSON.parse(fields.biz_content),method=fields.method;
    calls.push({method,orderId:biz.out_trade_no,refundId:biz.out_request_no??null,appSignatureValid:valid});
    if(method==='alipay.trade.page.pay'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><h1>本机支付协议验收</h1><p>这是签名请求样例，没有真实付款。</p>');return;}
    let data;const trade=trades.get(biz.out_trade_no);
    if(method==='alipay.trade.query')data=trade?{code:'10000',...trade}:{code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'};
    else if(method==='alipay.trade.close')data=trade||closeMode==='normal'?{code:'10000',out_trade_no:biz.out_trade_no,trade_no:trade?.trade_no??'202610040000'+String(++serial).padStart(6,'0')}:{code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'};
    else if(method==='alipay.trade.refund'){
      if(!trade){res.writeHead(500).end();return;}
      let refund=refunds.get(biz.out_request_no);
      if(!refund){refund={code:'10000',out_trade_no:biz.out_trade_no,trade_no:trade.trade_no,out_request_no:biz.out_request_no,refund_fee:biz.refund_amount,refund_amount:biz.refund_amount,refund_status:'REFUND_SUCCESS',fund_change:'Y'};refunds.set(biz.out_request_no,refund);}
      data=refund;
      if(refundMode==='drop-responses'){req.socket.destroy();return;}
    }else if(method==='alipay.trade.fastpay.refund.query')data=refunds.get(biz.out_request_no)??{code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'};
    else{res.writeHead(400).end('method not supported');return;}
    const key=method.replaceAll('.','_')+'_response',raw=JSON.stringify(data),signature=sign(raw,provider.privateKey);
    res.writeHead(200,{'content-type':'application/json'}).end(`{"${key}":${raw},"sign":${JSON.stringify(badQuerySignature?'invalid':signature)}}`);
  });
  await new Promise(resolve=>providerServer.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${providerServer.address().port}`;
  const config={environment:'fixture',appId,sellerId,maxSingleFen:5000,fixtureGateway:origin+'/gateway.do',fixturePrivateKey:app.privateKey.export({type:'pkcs8',format:'pem'}),fixtureProviderPublicKey:provider.publicKey.export({type:'spki',format:'pem'}),notifyUrl:origin+'/notify',returnUrl:origin+'/return',timeoutMs:1000};
  const gateway=createAlipayPaymentCandidate(config);
  const options={gateway,loadGeneration:async(account,id)=>generations.get(account+':'+id),maxDailyFen,now:()=>clock};
  ledger=createPaymentLedgerCandidate(join(root,'geod-payments.sqlite'),options);
  const tokens=new Map([[randomUUID(),'geod-alice'],[randomUUID(),'geod-bob']]);
  const [aliceToken,bobToken]=tokens.keys();
  const service=http.createServer(async(req,res)=>{
    const handled=await createPaymentCandidateHandler({ledger,authenticate:async req=>tokens.get((req.headers.authorization??'').replace(/^Bearer /,''))})(req,res);
    if(!handled)res.writeHead(404).end();
  });
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
  const api=`http://127.0.0.1:${service.address().port}`;
  async function request(path,{method='GET',value,token=aliceToken,raw}={}){
    const response=await fetch(api+path,{method,headers:{authorization:token?'Bearer '+token:'','content-type':raw!==undefined?'application/x-www-form-urlencoded':'application/json'},...(raw!==undefined?{body:raw}:value!==undefined?{body:JSON.stringify(value)}:{})});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    return {status:response.status,data};
  }
  function notification(order,patch={}){
    const trade=trades.get(order.orderId);
    const fields={notify_id:randomUUID(),app_id:appId,seller_id:sellerId,out_trade_no:order.orderId,trade_no:trade.trade_no,total_amount:(order.priceFen/100).toFixed(2),trade_status:'TRADE_SUCCESS',sign_type:'RSA2',...patch};
    fields.sign=sign(content(fields,true),provider.privateKey);return new URLSearchParams(fields).toString();
  }
  async function makePaid(productId='ai-credit-10'){
    const result=await request('/v1/payments/orders',{method:'POST',value:{requestKey:randomUUID(),productId}});assert.equal(result.status,201);
    const order=result.data;
    trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610040000'+String(++serial).padStart(6,'0'),total_amount:(order.priceFen/100).toFixed(2),trade_status:'TRADE_SUCCESS'});
    const resultNotify=await request('/v1/payments/alipay/notify',{method:'POST',raw:notification(order),token:null});assert.equal(resultNotify.data,'success');return order;
  }
  return {root,config,gateway,options,request,makePaid,notification,trades,refunds,calls,generations,aliceToken,bobToken,get ledger(){return ledger;},get clock(){return clock;},set clock(value){clock=value;},set refundMode(value){refundMode=value;},set closeMode(value){closeMode=value;},set badQuerySignature(value){badQuerySignature=value;},restart(){ledger.close();ledger=createPaymentLedgerCandidate(join(root,'geod-payments.sqlite'),options);},async close(){await Promise.all([new Promise(resolve=>service.close(resolve)),new Promise(resolve=>providerServer.close(resolve))]);ledger.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('geod-payment-candidate-'));rmSync(root,{recursive:true,force:true});}};
}
