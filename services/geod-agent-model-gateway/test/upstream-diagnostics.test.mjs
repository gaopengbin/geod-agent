import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import Database from 'better-sqlite3';
import {upstreamDiagnostic,safeDiagnostic} from '../../../packages/codex-protocol/upstream-diagnostics.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';

test('provider classifications retain structure and safe reasons without provider body or secrets',async()=>{
 const cases=[[401,'bad key','authentication'],[402,'insufficient balance','balance'],[429,'busy','rate_limit'],[400,'messages last role invalid','messages_invalid'],[400,'tools schema invalid','tools_invalid'],[400,'context length limit exceeded','context_limit'],[400,'image unsupported','image_unsupported'],[403,'forbidden','permission'],[503,'down','provider_unavailable']];
 for(const [status,message,reason] of cases){
  const diag=await upstreamDiagnostic(Response.json({error:{message:message+' private user prompt sk-private-credential',code:'private-secret-code'}},{status,headers:{'x-request-id':'sk-secret-header','retry-after':'12'}}),{messages:[{role:'user',content:'private user prompt'}],max_tokens:400,tools:[]});
  assert.equal(diag.reason,reason);assert.equal(diag.requestId,null);assert.equal(diag.providerCode,null);assert.equal(diag.retryAfterSeconds,12);
  assert.doesNotMatch(JSON.stringify(diag),/private|credential|secret|prompt/);
 }
 const huge=await upstreamDiagnostic(new Response('x'.repeat(100000),{status:400}));assert.equal(huge.reason,'parameters_invalid');
 assert.equal(safeDiagnostic({httpStatus:400,reason:'arbitrary-user-text'}),null);
});

test('unusable tool results and missing usage retain safe protocol diagnostics and release once',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-protocol-rejection-')),path=join(folder,'ledger.sqlite');let calls=0;
 const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:'s'.repeat(40),DEEPSEEK_API_KEY:'private-project-key',GEOD_IDENTITY_ORIGIN:'https://identity.test',GEOD_AGENT_DB_PATH:path,GEOD_AGENT_QUOTA_MODE:'unlimited'});
 const server=createGatewayServer(config,{fetchImpl:async url=>{
  if(String(url).startsWith('https://identity.test'))return Response.json({active:{userId:'protocol-user',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}});
  const n=calls++;const chunk={id:'provider-protocol-'+n,...(n<2?{usage:{prompt_tokens:200,completion_tokens:20}}:{}),choices:[{delta:{content:null,...(n<2?{tool_calls:[{index:0,...(n===0?{id:'call-1'}:{}),type:'function',function:{name:n===0?'invented_export':'declared_tool',arguments:'{}'}}]}:{})},finish_reason:'stop'}]};return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const generate=async id=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/agent/codex/generations/stream`,{method:'POST',headers:{authorization:'Bearer '+'A'.repeat(43),'content-type':'application/json'},body:JSON.stringify({generationId:id,conversationId:'protocol-conversation',request:{input:[{role:'user',content:'private prompt'}],tools:[{type:'function',name:'declared_tool',parameters:{type:'object',properties:{}}}]}})});return(await r.text()).split('\n\n').filter(x=>x.includes('event: generation')).map(x=>JSON.parse(x.match(/data: (.+)/)[1]))[0];};
 try{
  for(let i=0;i<3;i++){const r=await generate('protocol-'+i);assert.equal(r.state,'failed');assert.equal(r.errorCode,i<2?'UPSTREAM_INVALID_TOOL':'UPSTREAM_MALFORMED');assert.equal(r.upstreamDiagnostic.protocol.stage,i<2?'tool_contract':'stream_parse');assert.doesNotMatch(JSON.stringify(r.upstreamDiagnostic),/private prompt|private-project-key/);}
  await generate('protocol-2');assert.equal(calls,3);
  const db=new Database(path,{readonly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='release'").get().n,3);assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='settle'").get().n,0);}finally{db.close();}
 }finally{await new Promise(r=>server.close(r));rmSync(folder,{recursive:true,force:true});}
});

test('three upstream rejections are durably explained, released once and never retried on replay',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-provider-rejection-')),path=join(folder,'ledger.sqlite');let calls=0;
 const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:'s'.repeat(40),DEEPSEEK_API_KEY:'private-project-key',GEOD_IDENTITY_ORIGIN:'https://identity.test',GEOD_AGENT_DB_PATH:path,GEOD_AGENT_QUOTA_MODE:'unlimited'});
 const server=createGatewayServer(config,{fetchImpl:async url=>{
  if(String(url).startsWith('https://identity.test'))return Response.json({active:{userId:'diagnostic-user',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}});
  calls++;return Response.json({error:{message:'Invalid messages last role. sk-private-key customer prompt',type:'invalid_request_error'}},{status:400,headers:{'x-request-id':'provider-request-123'}});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const generate=async id=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/agent/codex/generations/stream`,{method:'POST',headers:{authorization:'Bearer '+'A'.repeat(43),'content-type':'application/json'},body:JSON.stringify({generationId:id,conversationId:'rejection-conversation',request:{input:[{role:'user',content:'Hello'}],tools:[]}})});assert.equal(response.status,200);const wire=await response.text();assert.doesNotMatch(wire,/sk-private-key|customer prompt/);return wire.split('\n\n').map(f=>f.includes('event: generation')?JSON.parse(f.match(/data: (.+)/)[1]):null).find(Boolean);};
 try{
  for(let i=0;i<3;i++){const row=await generate('rejected-'+i);assert.equal(row.state,'failed');assert.equal(row.errorCode,'UPSTREAM_REJECTED');assert.equal(row.upstreamDiagnostic.httpStatus,400);assert.equal(row.upstreamDiagnostic.reason,'messages_invalid');}
  await generate('rejected-2');assert.equal(calls,3);
  const db=new Database(path,{readonly:true});try{
   const rows=db.prepare('SELECT upstream_diagnostic FROM model_generations').all();assert.equal(rows.length,3);assert.ok(rows.every(r=>JSON.parse(r.upstream_diagnostic).reason==='messages_invalid'));
   assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='settle'").get().n,0);
   assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='release'").get().n,3);
  }finally{db.close();}
 }finally{await new Promise(r=>server.close(r));rmSync(folder,{recursive:true,force:true});}
});
