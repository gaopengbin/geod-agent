// A local issuer for native renewal acceptance. It never contacts GeoD accounts.
// Tokens expire in wall time, refresh tokens rotate once, and no token is logged.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';

export function verifyScheduleRenewal(statistics){
  assert.equal(statistics.rejectedRefreshes,0,'Native processes must not reuse a rotated refresh token');
  assert.equal(statistics.rejectedAccessTokens,0,'Authenticated gateway calls must use an unexpired native access token');
  assert(statistics.refreshes.length>=3,'A long run must exercise repeated native token renewal');
  assert.equal(statistics.issued.length,statistics.refreshes.length+1);
  for(const [index,refresh] of statistics.refreshes.entries()){
    assert.equal(refresh.previousGeneration,index);assert.equal(refresh.generation,index+1);
    assert.equal(refresh.previousExpiresAt,statistics.issued[index].expiresAt);
    assert(Date.parse(refresh.at)>=Date.parse(refresh.previousExpiresAt)-31000,'Only real expiry should trigger renewal');
  }
  // Personal model requests go directly to the provider. The reopened UI must
  // authenticate with a rotated access token; every periodic run need not call
  // the hosted gateway merely to satisfy the acceptance controller.
  const authenticated=statistics.introspections.filter(value=>value.generation>0);
  assert(authenticated.length>0,'A rotated token must reach an actual authenticated gateway request when the UI reopens');
  return {refreshes:statistics.refreshes.length,authenticatedGenerations:statistics.introspections.length,
    rotatedGatewayGenerations:authenticated.length,lifetimeSeconds:statistics.lifetimeSeconds};
}

export function createScheduleIdentity(account,lifetimeSeconds){
  assert.equal(account,'credit-history-native-fixture');
  assert(Number.isInteger(lifetimeSeconds)&&lifetimeSeconds>=180&&lifetimeSeconds<=3600);
  const access=new Map(),refreshGenerations=new Map(),credentialGenerations=[];
  const statistics={scope:'loopback-protocol-fixture',lifetimeSeconds,issued:[],refreshes:[],introspections:[],rejectedRefreshes:0,rejectedAccessTokens:0,rejectedRefreshDetails:[],responses:[]};
  let current;
  function issue(){
    const issuedAt=Math.floor(Date.now()/1000),expiresAt=issuedAt+lifetimeSeconds;
    current={accessToken:randomBytes(32).toString('base64url'),refreshToken:randomBytes(32).toString('base64url'),expiresAt,generation:statistics.issued.length};
    access.set(current.accessToken,{expiresAt,generation:current.generation});
    refreshGenerations.set(current.refreshToken,current.generation);
    credentialGenerations.push({generation:current.generation,accessSha256:createHash('sha256').update(current.accessToken).digest('hex'),refreshSha256:createHash('sha256').update(current.refreshToken).digest('hex')});
    statistics.issued.push({generation:current.generation,issuedAt:new Date(issuedAt*1000).toISOString(),expiresAt:new Date(expiresAt*1000).toISOString()});
    return current;
  }
  const initial=issue();
  function introspect(token){
    const entry=access.get(token);
    if(!entry||entry.expiresAt*1000<=Date.now()){statistics.rejectedAccessTokens++;return {active:null};}
    const bucket=statistics.introspections.find(value=>value.generation===entry.generation);
    if(bucket){bucket.count++;bucket.lastAt=new Date().toISOString();}
    else statistics.introspections.push({generation:entry.generation,count:1,firstAt:new Date().toISOString(),lastAt:new Date().toISOString()});
    return {active:{userId:account,clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:entry.expiresAt*1000}};
  }
  async function handle(request,response){
    let size=0;const chunks=[];
    for await(const chunk of request){size+=chunk.length;if(size>8192)throw Error('Oversized fixture token request');chunks.push(chunk);}
    const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type','application/json');response.setHeader('cache-control','no-store');
    if(request.method!=='POST'||form.get('grant_type')!=='refresh_token'||form.get('client_id')!=='geod-agent-desktop'||form.get('refresh_token')!==current.refreshToken){
      statistics.rejectedRefreshes++;
      statistics.rejectedRefreshDetails.push({at:new Date().toISOString(),presentedGeneration:refreshGenerations.get(form.get('refresh_token'))??null,expectedGeneration:current.generation});
      response.statusCode=400;response.end(JSON.stringify({error:{code:'INVALID_GRANT'}}));return;
    }
    const previous=current,next=issue();
    statistics.refreshes.push({at:new Date().toISOString(),previousGeneration:previous.generation,generation:next.generation,previousExpiresAt:new Date(previous.expiresAt*1000).toISOString()});
    response.on('finish',()=>statistics.responses.push({generation:next.generation,at:new Date().toISOString(),event:'finish'}));
    response.on('close',()=>statistics.responses.push({generation:next.generation,at:new Date().toISOString(),event:'close',finished:response.writableFinished}));
    response.end(JSON.stringify({access_token:next.accessToken,refresh_token:next.refreshToken,user_id:account,expires_in:lifetimeSeconds}));
  }
  function wrap(server){
    // Replace one listener, preserving the actual gateway callback and close hooks.
    const handlers=server.listeners('request');assert.equal(handlers.length,1);
    server.removeListener('request',handlers[0]);
    server.on('request',(request,response)=>{
      if(new URL(request.url,'http://localhost').pathname!=='/api/geod/oauth/token')return handlers[0].call(server,request,response);
      void handle(request,response).catch(()=>{if(!response.headersSent){response.statusCode=500;response.setHeader('content-type','application/json');}response.end(JSON.stringify({error:{code:'FIXTURE_TOKEN_ERROR'}}));});
    });
    return server;
  }
  return {initial,introspect,wrap,statistics,credentialGenerations};
}
