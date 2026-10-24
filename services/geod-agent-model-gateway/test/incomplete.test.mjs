import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createGatewayServer,readConfig} from '../server.mjs';

test('sponsored incomplete is a replayable terminal receipt with usage, not unknown or a successful delivery',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-incomplete-http-')),path=join(folder,'ledger.sqlite');let calls=0;
 const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:'s'.repeat(40),DEEPSEEK_API_KEY:'unused-key',GEOD_IDENTITY_ORIGIN:'https://identity.test',GEOD_AGENT_DB_PATH:path,GEOD_AGENT_WELCOME_CREDITS:'0',GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{id:'qa-response',name:'QA',allowedUsers:['*'],apiKeyEnv:'QA_KEY',baseUrl:'https://provider.test/v1',protocol:'responses',quotaMode:'observe',models:[{id:'qa',name:'QA',contextWindow:128000,inputModalities:['text']}]}]),QA_KEY:'private-qa-key'});
 const server=createGatewayServer(config,{fetchImpl:async(url,options)=>{
  if(String(url).startsWith('https://identity.test'))return Response.json({active:{userId:'qa',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}});
  assert.equal(String(url),'https://provider.test/v1/responses');calls++;const body=JSON.parse(options.body);assert.equal(body.max_output_tokens,16384);
  return new Response('data: '+JSON.stringify({type:'response.incomplete',response:{id:'response-incomplete-qa',model:'qa',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'function_call',name:'data_download_start',arguments:'{',call_id:'partial'}],usage:{input_tokens:100,output_tokens:16384,input_tokens_details:{cached_tokens:80},output_tokens_details:{reasoning_tokens:16000}}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer '+'A'.repeat(43),'content-type':'application/json'};
 try{
  const catalogue=await(await fetch(base+'/api/agent/sponsors',{headers})).json(),p=catalogue.sponsors[0];
  const body={generationId:'incomplete-qa',conversationId:'qa-conversation',sponsor:{providerId:p.id,modelId:'qa',revision:p.revision},request:{input:[{role:'user',content:'QA'}],tools:[]}};
  const generate=async()=>{const r=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);const frames=(await r.text()).split('\n\n');return JSON.parse(frames.find(x=>x.startsWith('event: generation\n')).split('\ndata: ')[1])};
  const first=await generate();assert.equal(first.state,'incomplete');assert.equal(first.errorCode,'UPSTREAM_OUTPUT_LIMIT');assert.equal(first.upstreamRequestId,'response-incomplete-qa');assert.equal(first.inputTokens,100);assert.equal(first.outputTokens,16384);assert.deepEqual(first.result.toolCalls,[]);assert.equal(first.result.providerTerminal.reason,'max_output_tokens');
  assert.deepEqual(await generate(),first);assert.equal(calls,1);
  const db=new Database(path,{readonly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='observed'").get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM usage_ledger WHERE kind='settle'").get().n,0)}finally{db.close()}
  const after=await(await fetch(base+'/api/agent/sponsors',{headers})).json();assert.equal(after.sponsors[0].usage.reservedTokens,0);assert.equal(after.sponsors[0].usage.committedTokens,16484);
 }finally{await new Promise(r=>server.close(r));rmSync(folder,{recursive:true,force:true})}
});
