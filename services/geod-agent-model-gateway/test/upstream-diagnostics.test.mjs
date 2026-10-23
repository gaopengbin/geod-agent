import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import Database from 'better-sqlite3';
import {upstreamDiagnostic,safeDiagnostic,protocolDiagnostic,upstreamFailureMessage} from '../../../packages/codex-protocol/upstream-diagnostics.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';

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

test('402 requires evidence of exhausted funds; billing scope never follows status alone',async()=>{
 const cases=[
  [402,{message:'Payment Required'},'payment_required','unknown','unknown'],
  [402,{message:'insufficient balance'},'balance','unknown','balance_insufficient'],
  [403,{code:'insufficient_user_quota',message:'余额不足'},'balance','account','balance_insufficient'],
  [403,{code:'pre_consume_token_quota_failed'},'balance','api_key','precharge_rejected'],
  [402,{message:'token quota is not enough'},'balance','api_key','quota_exhausted'],
  [402,{message:'account balance is too low'},'balance','account','balance_insufficient'],
  [402,{message:'upstream token quota exhausted'},'balance','upstream','quota_exhausted'],
  [402,{message:'预扣额度不足'},'balance','unknown','precharge_rejected'],
 ];
 for(const [status,error,reason,scope,issue] of cases){
  const d=await upstreamDiagnostic(Response.json({error},{status}));
  assert.equal(d.reason,reason);assert.deepEqual(d.billing,{scope,issue});
  assert.doesNotMatch(upstreamFailureMessage(d),/充值|补充渠道额度|GeoD.*余额/);
 }
 const legacy={version:1,httpStatus:402,reason:'balance',providerCode:null};
 assert.equal(safeDiagnostic(legacy).reason,'payment_required');assert.equal(legacy.reason,'balance');
 assert.deepEqual(safeDiagnostic({...legacy,providerCode:'insufficient_user_quota'}).billing,{scope:'account',issue:'quota_exhausted'});
 const secret='sk-private-key user prompt https://secret.invalid/';
 const scrubbed=safeDiagnostic({httpStatus:402,reason:'payment_required',billing:{scope:secret,issue:secret},bodyFormat:secret,requestId:secret});
 assert.doesNotMatch(JSON.stringify(scrubbed),/private|prompt|secret.invalid/);
 assert.equal(scrubbed.requestId,null);assert.equal(scrubbed.bodyFormat,undefined);
});

test('New API correlation and native Responses structure survive bounded JSON and text errors',async()=>{
 const body={input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,private-image'}]},{type:'function_call_output',call_id:'private-call',output:'private-output'}],tools:[{type:'function',name:'private-tool'}],max_output_tokens:4096};
 for(const response of [Response.json({error:{message:'upstream balance insufficient sk-private-key'}},{status:402,headers:{'x-oneapi-request-id':'20261023105100123456789'}}),new Response('upstream balance insufficient sk-private-key',{status:402,headers:{'x-oneapi-request-id':'20261023105100123456789'}})]){
  const d=await upstreamDiagnostic(response,body);
  assert.equal(d.requestId,'20261023105100123456789');
  assert.deepEqual(d.requestShape,{messages:2,tools:1,images:1,lastRole:'tool',maxOutputTokens:4096});
  assert.deepEqual(d.billing,{scope:'upstream',issue:'balance_insufficient'});
  assert.doesNotMatch(JSON.stringify(d),/private/);
  assert.deepEqual(safeDiagnostic(d),d,'Stored diagnostics must survive repeated safe reads');
 }
 const fallback=await upstreamDiagnostic(Response.json({request_id:'body-request-1'},{status:402,headers:{'x-request-id':'sk-secret','x-oneapi-request-id':'oneapi-request-1'}}));
 assert.equal(fallback.requestId,'oneapi-request-1');
 const bodyId=await upstreamDiagnostic(Response.json({error:{request_id:'body-request-2'}},{status:402}));assert.equal(bodyId.requestId,'body-request-2');
 const oversized=await upstreamDiagnostic(new Response('insufficient balance'+'x'.repeat(17000),{status:402}));assert.equal(oversized.bodyFormat,'oversized');assert.equal(oversized.reason,'payment_required');
 const empty=await upstreamDiagnostic(new Response(null,{status:402}));assert.equal(empty.bodyFormat,'empty');assert.equal(empty.reason,'payment_required');
 const malformed=await upstreamDiagnostic(new Response('{broken-json',{status:402}));assert.equal(malformed.bodyFormat,'text');assert.equal(malformed.reason,'payment_required');
 const protocol=protocolDiagnostic(new Response(null,{headers:{'x-oneapi-request-id':'oneapi-protocol-1'}}),body,{stage:'stream_parse',code:'PROVIDER_STREAM_INCOMPLETE'});
 assert.equal(protocol.requestId,'oneapi-protocol-1');assert.deepEqual(protocol.requestShape,{messages:2,tools:1,images:1,lastRole:'tool',maxOutputTokens:4096});
});

test('diagnostics describe Anthropic, Gemini and string Responses inputs without retaining contents',async()=>{
 const cases=[
  [{input:'private',max_output_tokens:4096},{messages:1,tools:0,images:0,lastRole:'user',maxOutputTokens:4096}],
  [{messages:[{role:'user',content:[{type:'image',source:{data:'private'}}]}],max_tokens:2048},{messages:1,tools:0,images:1,lastRole:'user',maxOutputTokens:2048}],
  [{contents:[{role:'model',parts:[{inlineData:{mimeType:'image/png',data:'private'}}]}],generationConfig:{maxOutputTokens:1024}},{messages:1,tools:0,images:1,lastRole:'assistant',maxOutputTokens:1024}],
 ];
 for(const [request,expected] of cases){const d=await upstreamDiagnostic(new Response(null,{status:402}),request);assert.deepEqual(d.requestShape,expected);assert.doesNotMatch(JSON.stringify(d),/private/);}
});

test('unlimited sponsored rejections preserve native evidence, release once and never retry or charge Credits',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-luna-billing-rejection-')),path=join(folder,'ledger.sqlite');let calls=0;
 const emptyWallet=createPaymentLedgerCandidate(path+'-credits.sqlite',{creditOnly:true,loadGeneration:()=>null});emptyWallet.close();
 const errors=[
  {status:402,error:{message:'Payment Required'},reason:'payment_required',scope:'unknown'},
  {status:403,error:{code:'insufficient_user_quota',message:'user quota is not enough'},reason:'balance',scope:'account'},
  {status:403,error:{code:'pre_consume_token_quota_failed'},reason:'balance',scope:'api_key'},
  {status:402,error:{message:'upstream balance insufficient'},reason:'balance',scope:'upstream'},
 ];
 const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:'s'.repeat(40),DEEPSEEK_API_KEY:'private-paid-key',GEOD_IDENTITY_ORIGIN:'https://identity.test',GEOD_AGENT_DB_PATH:path,GEOD_AGENT_WELCOME_CREDITS:'0',GEOD_AGENT_DEFAULT_SPONSOR_ID:'qa-luna',GEOD_AGENT_DEFAULT_SPONSOR_REVIEW_AT:'2026-10-23T12:02:00Z',GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{id:'qa-luna',name:'QA Luna',allowedUsers:['*'],apiKeyEnv:'QA_LUNA_KEY',baseUrl:'https://sponsor.test/v1',protocol:'responses',quotaMode:'observe',models:[{id:'qa-luna',name:'Luna',contextWindow:128000,maxOutputTokens:4096,inputModalities:['text']}]}]),QA_LUNA_KEY:'private-sponsored-key'});
 const server=createGatewayServer(config,{fetchImpl:async(url,options)=>{
  if(String(url).startsWith('https://identity.test'))return Response.json({active:{userId:'luna-diagnostic-user',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}});
  assert.equal(String(url),'https://sponsor.test/v1/responses','No paid fallback');
  const body=JSON.parse(options.body);assert.equal(body.max_output_tokens,4096);assert.equal(body.model,'qa-luna');
  const n=calls++,error=errors[n];assert.ok(error,'Unexpected provider retry');
  return Response.json({error:error.error},{status:error.status,headers:{'x-oneapi-request-id':'oneapi-rejection-'+n}});
 }});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer '+'A'.repeat(43),'content-type':'application/json'};
 const generate=async id=>{const r=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({generationId:id,conversationId:'luna-diagnostic-chat',request:{input:[{role:'user',content:'private prompt'}],tools:[]}})});assert.equal(r.status,200);return(await r.text()).split('\n\n').filter(x=>x.includes('event: generation')).map(x=>JSON.parse(x.match(/data: (.+)/)[1]))[0];};
 try{
  for(const [n,expected]of errors.entries()){
   const receipt=await generate('luna-rejection-'+n);assert.equal(receipt.state,'failed');assert.equal(receipt.errorCode,'UPSTREAM_REJECTED');assert.equal(receipt.billingScope,'sponsored');
   const d=receipt.upstreamDiagnostic;assert.equal(d.reason,expected.reason);assert.equal(d.billing.scope,expected.scope);assert.equal(d.requestId,'oneapi-rejection-'+n);assert.equal(d.requestShape.maxOutputTokens,4096);assert.equal(d.requestShape.messages,1);assert.equal(d.requestShape.lastRole,'user');assert.doesNotMatch(JSON.stringify(d),/private|prompt/);
   assert.deepEqual(await generate('luna-rejection-'+n),receipt);assert.equal(calls,n+1);
  }
  const wallet=await(await fetch(base+'/v1/payments/wallet',{headers})).json();assert.equal(wallet.chargeCount,0);assert.equal(String(wallet.availableNanoCny),'0');
  const db=new Database(path,{readonly:true});try{
   assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='release'").get().n,4);
   assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='settle'").get().n,0);
   const rows=db.prepare('SELECT upstream_diagnostic FROM model_generations').all();assert.equal(rows.length,4);assert.ok(rows.every(r=>JSON.parse(r.upstream_diagnostic).requestId?.startsWith('oneapi-rejection-')));
  }finally{db.close();}
 }finally{await new Promise(r=>server.close(r));rmSync(folder,{recursive:true,force:true});}
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
