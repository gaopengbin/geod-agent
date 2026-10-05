// Runs with Docker --network none. Fixture keys and cash live only in /tmp;
// all product imports resolve to the extracted release archive, never the checkout.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const service='/tmp/gateway-rc/services/geod-agent-model-gateway/';
const {createGatewayServer,readConfig}=await import(pathToFileURL(service+'server.mjs'));
const {fixture}=await import(pathToFileURL(service+'test/helpers/payment-fixture.mjs'));

export async function verifyPaymentHistory(){
 const f=await fixture({maxDailyFen:1_000_000});let server;
 try{
  const ids={orders:[],refunds:[]},createdAt=f.clock;
  for(let i=0;i<137;i++){
   const order=await f.makePaid(),refund=await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});
   assert.equal(refund.status,200);assert.equal(refund.data.status,'refunded');
   ids.orders.push(order.orderId);ids.refunds.push(refund.data.refundId);
  }
  const privateOrder=await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'bob-private-archive',productId:'ai-credit-10'},token:f.bobToken});assert.equal(privateOrder.status,201);
  const aliceToken=randomBytes(32).toString('base64url'),bobToken=randomBytes(32).toString('base64url');
  const tokens=new Map([[aliceToken,'geod-alice'],[bobToken,'geod-bob']]);
  const base=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'fixture-never-sent',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:1',GEOD_AGENT_DB_PATH:join(f.root,'archive-model.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited'});
  const config={...base,payment:{gateway:f.config,billingMode:'observe',maxDailyFen:1_000_000,dbPath:join(f.root,'geod-payments.sqlite')}};
  const fetchImpl=async(url,options)=>{
   assert(url.endsWith('/api/geod/oauth/introspect'),'No model/provider request allowed through the identity adapter');
   const userId=tokens.get(JSON.parse(options.body).token);
   return Response.json({active:userId?{userId,clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}:null});
  };
  let origin;
  const open=async()=>{server=createGatewayServer(config,{fetchImpl});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;};
  const close=async()=>{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));server=null;};
  const request=(path,{token=aliceToken,method='GET'}={})=>fetch(origin+path,{method,headers:{authorization:token?'Bearer '+token:''}});
  await open();
  const response=await request('/v1/payments/status');assert.equal(response.status,200);
  const status=await response.json();assert.equal(status.paymentHistoryEnabled,true);assert.equal(status.fixture,true);
  const first={};
  for(const kind of ['orders','refunds']){
   first[kind]=await (await request('/v1/payments/history/'+kind+'?limit=20')).json();
   assert.equal(first[kind].totalCount,137);assert.equal(first[kind].items.length,20);assert(first[kind].nextCursor);
  }
  // Late backdated inserts must not leak into an already opened cursor.
  f.clock-=86_400_000;const late=await f.makePaid();await f.request(`/v1/payments/orders/${late.orderId}/refund`,{method:'POST',value:{}});
  await close();f.restart();await open();
  const before=await (await request('/v1/payments/wallet')).json(),providerCalls=f.calls.length;
  assert.equal(before.orderCount,138);assert.equal(before.refundCount,138);assert.equal(before.orders.length,100);assert.equal(before.refunds.length,100);
  assert.equal(before.balanceNanoCny,'0');
  for(const kind of ['orders','refunds']){
   const key=kind==='orders'?'orderId':'refundId',all=first[kind].items.map(item=>item[key]);let cursor=first[kind].nextCursor;
   while(cursor){
    const page=await (await request(`/v1/payments/history/${kind}?limit=20&cursor=${encodeURIComponent(cursor)}`)).json();
    assert.equal(page.totalCount,137);assert.equal(page.asOf,first[kind].asOf);all.push(...page.items.map(item=>item[key]));cursor=page.nextCursor;
   }
   assert.equal(new Set(all).size,137);assert.deepEqual(all,ids[kind].sort().reverse());
   assert.equal((await request(`/v1/payments/history/${kind}`,{token:null})).status,401);
   assert.equal((await request(`/v1/payments/history/${kind}`,{method:'POST'})).status,405);
   assert.equal((await request(`/v1/payments/history/${kind}?account=geod-bob`)).status,400);
   assert.equal((await request(`/v1/payments/history/${kind}?cursor=${encodeURIComponent(first[kind].nextCursor)}`,{token:bobToken})).status,400);
   const privatePage=await (await request(`/v1/payments/history/${kind}`,{token:bobToken})).json();assert.equal(privatePage.totalCount,kind==='orders'?1:0);
   const range=`?from=${createdAt}&to=${createdAt+1}`;
   const filtered=await (await request(`/v1/payments/history/${kind}${range}`)).json();assert.equal(filtered.totalCount,137);assert.equal(filtered.items.length,20);
   const csvResponse=await request(`/v1/payments/history/${kind}/export.csv${range}`),csv=Buffer.from(await csvResponse.arrayBuffer());
   assert.equal(csvResponse.status,200);assert.equal(csvResponse.headers.get('x-geod-record-count'),'137');
   assert.equal(Number(csvResponse.headers.get('content-length')),csv.length);assert.equal(createHash('sha256').update(csv).digest('hex'),csvResponse.headers.get('x-geod-statement-sha256'));
   const text=csv.toString('utf8');assert(text.startsWith('\ufeff'));assert.equal(text.split('\r\n').filter(Boolean).length,138);assert(text.includes('"1000","10"'));
   for(const secret of ['geod-alice','geod-bob','trade_no','seller_id','request_key',aliceToken,bobToken,f.aliceToken,f.bobToken])assert(!text.includes(secret));
   for(const id of ids[kind])assert(text.includes(id));
  }
  assert.deepEqual(await (await request('/v1/payments/wallet')).json(),before);assert.equal(f.calls.length,providerCalls,'History reads must not query cash providers');
  assert(f.calls.every(call=>call.appSignatureValid));await close();
  return {passed:true,restartVerified:true,actualExtractedModules:true,readOnlyHistoryRoutesVerified:4,initialOrders:137,initialRefunds:137,recordsAfterLateInsert:138,filteredCsvRecordsPerType:137,walletWindow:100,ownerIsolation:true,signedSdkFixtures:true,readsPreservedBalance:true,readsCalledProvider:false,publicNetworkUsed:false,realFundsUsed:false};
 }finally{
  if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}
  await f.close();
 }
}
