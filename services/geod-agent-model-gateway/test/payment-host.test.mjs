import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {createGatewayServer,readConfig} from '../server.mjs';
import {readPaymentHostConfig,paymentCatalogueDigest} from '../payment-host-candidate.mjs';
import {pricingCandidate} from '../pricing-candidate.mjs';
import {fixture} from './helpers/payment-fixture.mjs';

async function host({mode='enforced',configured=true}={}){
  const f=await fixture(),secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('base64url');
  let calls=0,upstream='ok';
  const baseConfig=readConfig({GEOD_AGENT_GATEWAY_SECRET:secret,DEEPSEEK_API_KEY:'fixture-only',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',
    DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(f.root,'host-model.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited'});
  const config={...baseConfig,payment:configured?{gateway:f.config,billingMode:mode,maxDailyFen:100000,dbPath:join(f.root,'host-payments.sqlite')}:null};
  const fetchImpl=async(url,options)=>{
    if(url.endsWith('/api/geod/oauth/introspect')){
      const body=JSON.parse(options.body);
      return Response.json({active:body.token===token?{userId:'host-account',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}:null});
    }
    assert(url.endsWith('/chat/completions'));++calls;
    if(upstream==='lost')throw new Error('response lost');
    if(upstream==='reject')return Response.json({error:'fixture rejection'},{status:400});
    const usage={prompt_tokens:10000,completion_tokens:100,...(upstream==='no-cache'?{}:{prompt_cache_hit_tokens:8000})};
    return Response.json({id:'fixture-model-'+calls,model:'deepseek-flash',usage,choices:[{message:{role:'assistant',content:'Model protocol fixture',tool_calls:[]}}]});
  };
  let server=createGatewayServer(config,{fetchImpl});
  const listen=async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;};
  let base=await listen();
  async function request(path,{method='GET',value,raw,authenticated=true}={}){
    const res=await fetch(base+path,{method,headers:{authorization:authenticated?'Bearer '+token:'','content-type':raw===undefined?'application/json':'application/x-www-form-urlencoded'},...(raw!==undefined?{body:raw}:value!==undefined?{body:JSON.stringify(value)}:{})});
    const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:res.status,data};
  }
  async function paid(productId='ai-credit-10'){
    const {data:order,status}=await request('/v1/payments/orders',{method:'POST',value:{requestKey:randomUUID(),productId}});assert.equal(status,201);
    f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'20261005'+String(f.trades.size+1).padStart(18,'0'),total_amount:(order.priceFen/100).toFixed(2),trade_status:'TRADE_SUCCESS'});
    const notified=await request('/v1/payments/alipay/notify',{method:'POST',raw:f.notification(order),authenticated:false});assert.equal(notified.data,'success');return order;
  }
  const generate=(id=randomUUID())=>request('/api/agent/generations',{method:'POST',value:{generationId:id,conversationId:'fixture-conversation',messages:[{role:'user',content:'payment host fixture'}]}});
  return {f,config,request,paid,generate,get calls(){return calls;},set upstream(value){upstream=value;},async restart(){await new Promise(resolve=>server.close(resolve));server=createGatewayServer(config,{fetchImpl});base=await listen();},async close(){await new Promise(resolve=>server.close(resolve));await f.close();}};
}

test('default host keeps unlimited testing and disables all money mutations',async()=>{
  const h=await host({configured:false});try{
    assert.equal((await h.request('/v1/payments/status',{authenticated:false})).status,401);
    const status=(await h.request('/v1/payments/status')).data;assert.equal(status.checkoutEnabled,false);assert.equal(status.billingMode,'unlimited-test');
    const wallet=(await h.request('/v1/payments/wallet')).data;assert.equal(wallet.balanceNanoCny,null);
    assert.equal((await h.request('/v1/payments/orders',{method:'POST',value:{requestKey:'no',productId:'ai-credit-10'}})).status,409);
    assert.equal((await h.generate()).data.state,'settled');assert.equal(h.calls,1);
  }finally{await h.close();}
});
test('prepaid host reserves before calling a model and settles trusted cached usage once',async()=>{
  const h=await host();try{
    const denied=await h.generate();assert.equal(denied.status,409);assert.equal(denied.data.error,'BILLING_INSUFFICIENT_CREDIT');assert.equal(h.calls,0);
    await h.paid();const id=randomUUID(),result=await h.generate(id);assert.equal(result.data.state,'settled');assert.equal(result.data.billing.chargeNanoCny,'10240000');
    assert.equal((await h.request('/v1/payments/wallet')).data.balanceNanoCny,'9989760000');assert.equal((await h.request('/v1/payments/wallet')).data.reservedNanoCny,'0');
    assert.equal((await h.generate(id)).data.billing.replayed,true);assert.equal(h.calls,1);
    await h.restart();assert.equal((await h.request('/api/agent/generations/'+id)).data.billing.replayed,true);assert.equal(h.calls,1);
    assert.equal((await h.request('/v1/payments/wallet')).data.balanceNanoCny,'9989760000');
  }finally{await h.close();}
});
test('missing usage or lost response keeps prepaid credit reserved, confirmed rejection releases it',async()=>{
  const h=await host();try{
    await h.paid();h.upstream='lost';const lost=await h.generate();assert.equal(lost.data.state,'pending_reconcile');assert.equal(lost.data.billing.state,'waiting-for-provider');
    const held=(await h.request('/v1/payments/wallet')).data.reservedNanoCny;assert(BigInt(held)>0n);
    h.upstream='no-cache';const missing=await h.generate();assert.equal(missing.data.billing.state,'waiting-for-usage');const afterMissing=(await h.request('/v1/payments/wallet')).data;assert.equal(afterMissing.balanceNanoCny,'10000000000');assert.equal(BigInt(afterMissing.reservedNanoCny),2n*BigInt(held));
    h.upstream='reject';const rejection=await h.generate();assert.equal(rejection.status,502);assert.equal((await h.request('/v1/payments/wallet')).data.reservedNanoCny,afterMissing.reservedNanoCny);
    await h.restart();assert.equal((await h.request('/v1/payments/wallet')).data.reservedNanoCny,afterMissing.reservedNanoCny);
  }finally{await h.close();}
});
test('observe payment candidate never deducts test balance or limits model access',async()=>{
  const h=await host({mode:'observe'});try{
    assert.equal((await h.generate()).data.state,'settled');await h.paid();assert.equal((await h.generate()).data.state,'settled');
    const wallet=(await h.request('/v1/payments/wallet')).data;assert.equal(wallet.balanceNanoCny,'10000000000');assert.equal(wallet.reservedNanoCny,'0');
    assert.equal((await h.request('/v1/payments/status')).data.billingMode,'unlimited-test');
  }finally{await h.close();}
});
test('merchant setup alone cannot adopt draft prices or reinterpret an unsupported model',async()=>{
  const h=await host();try{
    const path=join(h.f.root,'unapproved.json');writeFileSync(path,JSON.stringify({billingMode:'observe',dbPath:join(h.f.root,'no.sqlite'),maxDailyFen:10000,gateway:{environment:'production'}}));
    assert.throws(()=>readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}),{code:'PAYMENT_CATALOGUE_NOT_APPROVED'});
    assert.throws(()=>createGatewayServer({...h.config,model:'deepseek-v4-pro'}),{code:'BILLING_MODEL_UNPRICED'});
    assert.throws(()=>createGatewayServer({...h.config,payment:{...h.config.payment,dbPath:h.config.dbPath}}),{code:'PAYMENT_LEDGER_SCOPE'});
    assert.throws(()=>createGatewayServer({...h.config,payment:{...h.config.payment,gateway:{environment:'production'}}}),{code:'PAYMENT_CATALOGUE_NOT_APPROVED'});
    const approved={billingMode:'observe',dbPath:join(h.f.root,'no.sqlite'),maxDailyFen:10000,gateway:{environment:'production'},catalogueApproved:true};
    writeFileSync(path,JSON.stringify(approved));assert.throws(()=>readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}),{code:'PAYMENT_TERMS_NOT_APPROVED'});
    assert.throws(()=>createGatewayServer({...h.config,payment:approved}),{code:'PAYMENT_TERMS_NOT_APPROVED'});
    approved.approvedPricingVersion=pricingCandidate.version;approved.approvedCatalogueSha256=paymentCatalogueDigest();
    writeFileSync(path,JSON.stringify(approved));assert.equal(readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}).approvedPricingVersion,pricingCandidate.version);
    const changed={...approved,products:[{id:'ai-credit-10',name:'changed',kind:'topup',priceFen:9999,creditNanoCny:'10000000000',days:0}]};
    writeFileSync(path,JSON.stringify(changed));assert.throws(()=>readPaymentHostConfig({GEOD_AGENT_PAYMENT_CONFIG:path}),{code:'PAYMENT_TERMS_NOT_APPROVED'});
  }finally{await h.close();}
});
