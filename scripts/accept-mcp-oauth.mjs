/** Explicit OAuth protocol fixture through the actual native MCP dispatcher. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [playwrightModule,evidenceDirectory]=process.argv.slice(2);
const evidencePath=path.resolve(evidenceDirectory);
await fs.mkdir(evidencePath,{recursive:true});
const {chromium}=await import(playwrightModule);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
assert(page,'Actual development WebView is required');
const rpc=async(command,args={})=>{
  const reply=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});
  if(!reply.ok)throw reply.error;return reply.value;
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={fixture:'local explicit OAuth protocol server; no external provider account used',cases:[]};
const secrets=[],codes=new Map(),refreshTokens=new Set(),accessTokens=new Set();
let base,resource,exchanges=0,refreshes=0,registrations=0,toolCalls=0,id;
const issue=()=>{
  const access_token=crypto.randomUUID(),refresh_token=crypto.randomUUID();
  secrets.push(access_token,refresh_token);accessTokens.add(access_token);refreshTokens.add(refresh_token);
  return{access_token,refresh_token,token_type:'Bearer',expires_in:3,scope:'regions:read'};
};
const server=http.createServer(async(request,response)=>{
  try{
    const url=new URL(request.url,base);let raw='';for await(const chunk of request)raw+=chunk;
    const json=(status,body,headers={})=>response.writeHead(status,{'content-type':'application/json',...headers}).end(JSON.stringify(body));
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return json(200,{resource,authorization_servers:[base],scopes_supported:['regions:read']});
    if(url.pathname==='/.well-known/oauth-authorization-server')return json(200,{issuer:base,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,registration_endpoint:`${base}/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['regions:read'],authorization_response_iss_parameter_supported:true});
    if(url.pathname==='/register'){
      assert.equal(request.method,'POST');const client=JSON.parse(raw);assert(client.redirect_uris?.length===1);
      registrations++;return json(201,{client_id:'geod-public-fixture',redirect_uris:client.redirect_uris,token_endpoint_auth_method:'none'});
    }
    if(url.pathname==='/authorize'){
      assert.equal(url.searchParams.get('client_id'),'geod-public-fixture');
      assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('resource'),resource);
      const code=crypto.randomUUID();codes.set(code,Object.fromEntries(url.searchParams));
      const callback=new URL(url.searchParams.get('redirect_uri'));callback.searchParams.set('code',code);callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('iss',base);
      return response.writeHead(302,{location:callback.href}).end();
    }
    if(url.pathname==='/token'){
      const body=new URLSearchParams(raw);assert.equal(body.get('client_id'),'geod-public-fixture');assert.equal(body.get('resource'),resource);
      if(body.get('grant_type')==='authorization_code'){
        const saved=codes.get(body.get('code'));assert(saved,'Authorization code must be issued by the fixture');
        assert.equal(body.get('redirect_uri'),saved.redirect_uri);
        assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'),saved.code_challenge);
        codes.delete(body.get('code'));exchanges++;
      }else{
        assert.equal(body.get('grant_type'),'refresh_token');assert(refreshTokens.delete(body.get('refresh_token')),'Rotating refresh token required');refreshes++;
      }
      return json(200,issue());
    }
    if(url.pathname==='/mcp'){
      if(!accessTokens.has(request.headers.authorization?.replace(/^Bearer /,'')))return json(401,{error:'invalid_token'},{'www-authenticate':`Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
      if(request.method!=='POST')return response.writeHead(405).end();
      const body=JSON.parse(raw);if(body.id===undefined)return response.writeHead(202).end();
      const result=body.method==='initialize'?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'OAuth protocol fixture',version:'1'}}:
        body.method==='tools/list'?{tools:[{name:'read_regions',description:'Read actual fixture rows after OAuth',inputSchema:{type:'object',properties:{}}}]}:
        {content:[{type:'text',text:JSON.stringify({rows:[{name:'fixture-east',score:10}],call:++toolCalls})}]};
      return json(200,{jsonrpc:'2.0',id:body.id,result});
    }
    response.writeHead(404).end();
  }catch(error){console.error('Fixture assertion:',error.message);response.writeHead(500).end('Fixture assertion failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
base=`http://127.0.0.1:${server.address().port}`;resource=`${base}/mcp`;
const record=(name,result)=>{const serialized=JSON.stringify(result);assert(!secrets.some(secret=>serialized.includes(secret)),'Token leaked into results');report.cases.push({name,pass:true,result});console.log(name,'PASS');};
const statusUntil=async(aid,state)=>{for(let i=0;i<100;i++){const value=await rpc('mcp_oauth_status',{authorizationId:aid});if(value.state===state)return value;if(value.state==='failed')throw new Error(value.message);await sleep(100);}throw new Error(`Authorization did not become ${state}`);};
const authorize=async(start)=>{
  const location=(await fetch(start.authorizationUrl,{redirect:'manual'})).headers.get('location');assert(location,'Authorization redirect missing');
  const response=await fetch(location);assert.equal(response.status,200);
  assert(!secrets.some(secret=>location.includes(secret)));return statusUntil(start.authorizationId,'authorized');
};
try{
  const conversationId=`oauth-${crypto.randomUUID()}`;
  await rpc('workspace_set',{conversationId,directory:evidencePath,permission:'fullAccess'});
  const added=await rpc('mcp_add',{name:'OAuth protocol acceptance',url:resource});id=added.connectors.find(c=>c.url===resource).id;
  const start=await rpc('mcp_oauth_start',{id});
  const authUrl=new URL(start.authorizationUrl),callback=new URL(authUrl.searchParams.get('redirect_uri'));
  callback.searchParams.set('code','unissued');callback.searchParams.set('state','wrong');callback.searchParams.set('iss',base);
  assert.equal((await fetch(callback)).status,400);
  callback.searchParams.set('state',authUrl.searchParams.get('state'));callback.searchParams.set('iss','https://foreign.invalid');
  assert.equal((await fetch(callback)).status,400);
  assert.equal((await rpc('mcp_oauth_pending',{id})).authorizationId,start.authorizationId);assert.equal(exchanges,0);
  record('wrong state and issuer rejected without consuming pending grant',{tokenExchanges:exchanges,state:(await rpc('mcp_oauth_status',{authorizationId:start.authorizationId})).state});
  record('discovery, registration, PKCE exchange and native vault',await authorize(start));
  const tools=await rpc('mcp_tools',{id,conversationId});assert.equal(tools.tools[0].name,'read_regions');
  record('authorized native MCP tool discovery',{toolNames:tools.tools.map(t=>t.name),registrations,exchanges});
  await rpc('mcp_set_enabled',{id,enabled:true});
  await sleep(4000);
  const result=await rpc('mcp_call',{id,toolName:'read_regions',arguments:{},executionId:`oauth-test:${crypto.randomUUID()}`,conversationId});assert(!result.isError);assert(refreshes>=1);
  record('expired access token automatically refreshes',{refreshes,result});
  const previous=refreshes;accessTokens.clear();
  await rpc('mcp_tools',{id,conversationId});assert(refreshes>previous);
  record('rejected access token refreshes once',{refreshes});
  const reauth=await rpc('mcp_oauth_start',{id});await rpc('mcp_oauth_cancel',{authorizationId:reauth.authorizationId});
  assert.equal(await rpc('mcp_oauth_pending',{id}),null);assert.equal(exchanges,1);
  await rpc('mcp_tools',{id,conversationId});record('cancelled replacement preserves existing grant',{exchanges});
  await rpc('mcp_oauth_disconnect',{id});
  try{await rpc('mcp_tools',{id,conversationId});throw new Error('Unauthenticated MCP unexpectedly allowed');}catch(error){assert.equal(error.code,'MCP_CONNECT_FAILED');}
  record('disconnect removes native grant',await rpc('mcp_oauth_status',{authorizationId:reauth.authorizationId}));
  const pending=await rpc('mcp_oauth_start',{id});await rpc('mcp_remove',{id});id=null;
  assert.equal((await rpc('mcp_oauth_status',{authorizationId:pending.authorizationId})).state,'cancelled');
  record('removing public connector cancels pending authorization',{state:'cancelled'});
  await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));
}finally{
  if(id)await rpc('mcp_remove',{id}).catch(error=>console.error('Cleanup:',error.code));
  await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
