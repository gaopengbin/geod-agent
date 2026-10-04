import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const requireCreditHistory=process.argv.includes('--credit-history');
const {readConfig,createGatewayServer}=await import(pathToFileURL('/tmp/gateway-rc/services/geod-agent-model-gateway/server.mjs'));
const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:'release-archive-test-secret-long-enough',DEEPSEEK_API_KEY:'fixture-never-sent',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:1',GEOD_AGENT_DB_PATH:join(mkdtempSync(join(tmpdir(),'gateway-archive-')),'model.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited'});
assert.equal(config.quotaEnforced,false);assert.equal(config.payment,null);
const server=createGatewayServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/agent/usage');
 assert.equal(response.status,401);assert.equal((await response.json()).error,'UNAUTHORIZED');
}finally{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}
const welcome=readConfig({GEOD_AGENT_GATEWAY_SECRET:'release-archive-test-secret-long-enough',DEEPSEEK_API_KEY:'fixture-never-sent',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:1',GEOD_AGENT_DB_PATH:join(mkdtempSync(join(tmpdir(),'gateway-welcome-')),'model.sqlite')});
assert.equal(welcome.welcomeCredit.creditNanoCny,'20000000000');
const token='A'.repeat(43);
const fetchImpl=async(url,options)=>{
 assert(url.endsWith('/api/geod/oauth/introspect'));assert.equal(JSON.parse(options.body).token,token);
 return Response.json({active:{userId:'isolated-archive-account',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}});
};
if(requireCreditHistory){
 const {createPaymentLedgerCandidate}=await import(pathToFileURL('/tmp/gateway-rc/services/geod-agent-model-gateway/payment-ledger-candidate.mjs'));
 const generations=new Map(),ledger=createPaymentLedgerCandidate(welcome.dbPath+'-credits.sqlite',{welcomeCredit:welcome.welcomeCredit,loadGeneration:(_account,id)=>generations.get(id)});
 try{
  ledger.grantWelcome('isolated-archive-account');
  for(let i=0;i<122;i++){
   const generationId='archive-history-'+String(i).padStart(3,'0'),value={generationId,state:'reserved',model:'deepseek-flash',billingScope:'hosted'};
   generations.set(generationId,value);await ledger.reserveGeneration('isolated-archive-account',generationId,'100000000');
   if(i<121){Object.assign(value,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:10});await ledger.settleGeneration('isolated-archive-account',generationId);}
  }
 }finally{ledger.close();}
}
let cursor,firstIds;
for(let attempt=0;attempt<2;attempt++){
 const active=createGatewayServer(welcome,{fetchImpl});await new Promise(resolve=>active.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+active.address().port+'/v1/payments/wallet',{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);const wallet=await response.json();
  assert.equal(wallet.availableNanoCny,requireCreditHistory?'18660960000':'20000000000');assert.equal(wallet.grants.length,1);assert.equal(wallet.checkoutEnabled,false);
  if(requireCreditHistory){
   const request=path=>fetch('http://127.0.0.1:'+active.address().port+path,{headers:{authorization:'Bearer '+token}});
   assert.equal((await (await request('/v1/payments/status')).json()).creditHistoryEnabled,true);
   const unauthenticated=await fetch('http://127.0.0.1:'+active.address().port+'/v1/payments/history/usage');assert.equal(unauthenticated.status,401);
   const page=await (await request('/v1/payments/history/usage?limit=20'+(attempt?'&cursor='+encodeURIComponent(cursor):''))).json();
   assert.equal(page.totalCount,121);assert.equal(page.items.length,20);
   if(attempt)assert(page.items.every(item=>!firstIds.includes(item.generationId)));
   else{cursor=page.nextCursor;firstIds=page.items.map(item=>item.generationId);assert(cursor);}
   const reservations=await (await request('/v1/payments/history/reservations')).json();assert.equal(reservations.totalCount,1);assert.equal(reservations.items[0].generationId,'archive-history-121');
   for(const [kind,count] of [['usage',121],['reservations',1]]){
    const response=await request('/v1/payments/history/'+kind+'/export.csv'),csv=Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200);assert.equal(Number(response.headers.get('x-geod-record-count')),count);
    assert.equal(Number(response.headers.get('content-length')),csv.length);assert.equal(createHash('sha256').update(csv).digest('hex'),response.headers.get('x-geod-statement-sha256'));
    assert(csv.toString('utf8').startsWith('\ufeff'));assert.equal(csv.toString('utf8').split('\r\n').filter(Boolean).length,count+1);
   }
   assert.equal((await request('/v1/payments/history/usage?account=another')).status,400);
   const unchanged=await (await request('/v1/payments/wallet')).json();assert.deepEqual(unchanged,wallet);
  }
 }finally{active.closeIdleConnections();await new Promise(resolve=>active.close(resolve));}
}
console.log(JSON.stringify({passed:true,actualArchiveStarted:true,nativeSqliteLoaded:true,paidCheckout:false,quotaEnforced:false,welcomeCreditsVerified:true,welcomeRestartVerified:true,publicNetworkUsed:false,identityFixture:true,
 creditHistoryVerified:requireCreditHistory,creditHistoryRestartVerified:requireCreditHistory,readOnlyHistoryRoutesVerified:requireCreditHistory?4:0,historyRecords:requireCreditHistory?121:0}));
