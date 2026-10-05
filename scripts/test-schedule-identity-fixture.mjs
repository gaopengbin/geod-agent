import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createScheduleIdentity,verifyScheduleRenewal} from './schedule-identity-fixture.mjs';

function statistics(){
  const start=Date.parse('2026-10-05T00:00:00Z');
  const issued=Array.from({length:4},(_,generation)=>({generation,expiresAt:new Date(start+(generation*870+900)*1000).toISOString()}));
  const refreshes=issued.slice(0,-1).map((value,previousGeneration)=>({previousGeneration,generation:previousGeneration+1,
    previousExpiresAt:value.expiresAt,at:new Date(Date.parse(value.expiresAt)-30000).toISOString()}));
  return {issued,refreshes,lifetimeSeconds:900,rejectedRefreshes:0,rejectedAccessTokens:0,introspections:[{generation:0,count:5},{generation:3,count:5}]};
}

test('direct personal-model runs may renew repeatedly without hosted requests until the UI reopens',()=>{
  const result=verifyScheduleRenewal(statistics());assert.equal(result.refreshes,3);assert.equal(result.rotatedGatewayGenerations,1);
});
test('renewal alone cannot stand in for using a rotated access token',()=>{
  const value=statistics();value.introspections=[{generation:0,count:5}];assert.throws(()=>verifyScheduleRenewal(value),/rotated token must reach/);
});
test('reused refresh tokens, broken rotation and early refreshes remain failures',()=>{
  const rejected=statistics();rejected.rejectedRefreshes=1;assert.throws(()=>verifyScheduleRenewal(rejected));
  const broken=statistics();broken.refreshes[1].previousGeneration=0;assert.throws(()=>verifyScheduleRenewal(broken));
  const early=statistics();early.refreshes[0].at='2026-10-05T00:00:00Z';assert.throws(()=>verifyScheduleRenewal(early),/Only real expiry/);
});

test('actual fixture HTTP rotation identifies stale generations without recording token values',async()=>{
  const fixture=createScheduleIdentity('credit-history-native-fixture',180);
  const server=fixture.wrap(createServer((_request,response)=>{response.statusCode=404;response.end();}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    const request=token=>fetch(origin+'/api/geod/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:'geod-agent-desktop',refresh_token:token})});
    const accepted=await request(fixture.initial.refreshToken);
    assert.equal(accepted.status,200);assert.equal(accepted.headers.get('cache-control'),'no-store');
    const next=await accepted.json();
    assert.equal(fixture.credentialGenerations[1].refreshSha256,createHash('sha256').update(next.refresh_token).digest('hex'));
    const stale=await request(fixture.initial.refreshToken);
    assert.equal(stale.status,400);assert.deepEqual(await stale.json(),{error:{code:'INVALID_GRANT'}});
    assert.equal(fixture.statistics.rejectedRefreshes,1);
    assert.equal(fixture.statistics.rejectedRefreshDetails[0].presentedGeneration,0);
    assert.equal(fixture.statistics.rejectedRefreshDetails[0].expectedGeneration,1);
    assert(fixture.statistics.responses.some(value=>value.generation===1&&value.event==='finish'));
    const publicRecord=JSON.stringify({statistics:fixture.statistics,generations:fixture.credentialGenerations});
    for(const value of [fixture.initial.accessToken,fixture.initial.refreshToken,next.access_token,next.refresh_token])assert(!publicRecord.includes(value));
  }finally{
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
});
