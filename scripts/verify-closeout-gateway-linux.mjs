import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
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
for(let attempt=0;attempt<2;attempt++){
 const active=createGatewayServer(welcome,{fetchImpl});await new Promise(resolve=>active.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+active.address().port+'/v1/payments/wallet',{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);const wallet=await response.json();
  assert.equal(wallet.availableNanoCny,'20000000000');assert.equal(wallet.grants.length,1);assert.equal(wallet.checkoutEnabled,false);
 }finally{active.closeIdleConnections();await new Promise(resolve=>active.close(resolve));}
}
console.log(JSON.stringify({passed:true,actualArchiveStarted:true,nativeSqliteLoaded:true,paidCheckout:false,quotaEnforced:false,welcomeCreditsVerified:true,welcomeRestartVerified:true,publicNetworkUsed:false,identityFixture:true}));
