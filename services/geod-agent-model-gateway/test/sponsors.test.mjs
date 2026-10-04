import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLedger} from '../ledger.mjs';
import {readSponsors,sponsorCatalogue,sponsorRoute,sponsorReservation} from '../sponsors.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';
import {settledQuote} from '../pricing-candidate.mjs';
import {createBillingCandidate} from '../billing-candidate.mjs';

const declaration={id:'qa-sponsor',name:'QA Sponsor',allowedUsers:['alice'],apiKeyEnv:'QA_PROVIDER_KEY',baseUrl:'https://provider.example/v1',models:[{id:'qa-model',name:'QA Model',contextWindow:16000,maxOutputTokens:512,inputModalities:['text'],thinking:null}],quotaMode:'enforced',perUserTokenLimit:1000,totalTokenLimit:1600};
const provider=readSponsors({GEOD_AGENT_SPONSORS_JSON:JSON.stringify([declaration]),QA_PROVIDER_KEY:'test-private-key'})[0];
const reserve=(ledger,userId,id,tokens=600,sponsor=provider)=>ledger.reserve({userId,generationId:id,conversationId:'qa-chat',requestHash:id,model:'qa-model',reserveTokens:tokens,sponsor});

test('Operator metadata never exposes keys, endpoints or account audience; routes reject injected or stale configuration',()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-sponsors-config-')),ledger=openLedger(join(folder,'ledger.sqlite'),1000,'s'.repeat(40));
 try{
  const catalogue=sponsorCatalogue([provider],ledger,'alice');assert.equal(catalogue.sponsors.length,1);assert.equal(sponsorCatalogue([provider],ledger,'bob').sponsors.length,0);const serialized=JSON.stringify(catalogue);assert(!serialized.includes('test-private-key'));assert(!serialized.includes('provider.example'));assert(!serialized.includes('allowedUsers'));
  const input={providerId:provider.id,modelId:'qa-model',revision:provider.revision};assert.equal(sponsorRoute([provider],input,'alice').model.id,'qa-model');
  for(const [value,user,code]of [[{...input,apiKey:'injected'},'alice','SPONSOR_INVALID'],[{...input,revision:'stale'},'alice','SPONSOR_CHANGED'],[input,'bob','SPONSOR_UNAVAILABLE'],[{...input,modelId:'other'},'alice','SPONSOR_MODEL_MISSING']])assert.throws(()=>sponsorRoute([provider],value,user),error=>error.code===code);
  assert.throws(()=>readSponsors({GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{...declaration,baseUrl:'https://provider.example/?key=hidden'}]),QA_PROVIDER_KEY:'key'}));
  assert.throws(()=>readSponsors({GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{...declaration,allowedUsers:[]}]),QA_PROVIDER_KEY:'key'}));
 }finally{ledger.close();rmSync(folder,{recursive:true,force:true})}
});

test('Per-user and shared sponsor reservations are atomic, separate from hosted quota and survive settlement and reopening',()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-sponsors-ledger-')),file=join(folder,'ledger.sqlite');let ledger=openLedger(file,10,'s'.repeat(40));
 try{
  assert.equal(reserve(ledger,'alice','sponsor-a').replayed,false);assert.equal(reserve(ledger,'alice','sponsor-a').replayed,true);assert.equal(reserve(ledger,'alice','too-much').quotaExceeded,true);assert.equal(ledger.usage('alice').committedTokens,0);assert.equal(ledger.usage('alice').reservedTokens,0);
  assert.equal(reserve(ledger,'bob','sponsor-b').replayed,false);assert.equal(reserve(ledger,'charlie','shared-budget',500).quotaExceeded,true);
  ledger.markStreaming('alice','sponsor-a');ledger.settle('alice','sponsor-a',50,10,'provider-id',{content:'actual fixture'});assert.equal(ledger.sponsorUsage('alice',provider).committedTokens,60);assert.equal(ledger.sponsorUsage('alice',provider).reservedTokens,0);assert.equal(ledger.get('alice','sponsor-a').billingScope,'sponsored');assert.equal(ledger.get('bob','sponsor-a'),null);
  const hosted=reserve(ledger,'alice','hosted-a',11,null);assert.equal(hosted.quotaExceeded,true);
  ledger.close();ledger=openLedger(file,10,'s'.repeat(40));assert.equal(ledger.get('alice','sponsor-a').result.content,'actual fixture');assert.equal(ledger.sponsorUsage('alice',provider).committedTokens,60);assert.equal(ledger.usage('alice').reservedTokens,0);
 }finally{ledger.close();rmSync(folder,{recursive:true,force:true})}
});

test('Sponsor interruption keeps its reservation until provider evidence reconciles it; revision changes do not reset usage',()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-sponsors-pending-')),file=join(folder,'ledger.sqlite');let ledger=openLedger(file,1000,'s'.repeat(40));
 try{reserve(ledger,'alice','pending');ledger.markStreaming('alice','pending');ledger.close();ledger=openLedger(file,1000,'s'.repeat(40));assert.equal(ledger.get('alice','pending').state,'pending_reconcile');assert.equal(ledger.sponsorUsage('alice',{...provider,revision:'new'}).reservedTokens,600);assert.equal(reserve(ledger,'alice','after-crash').quotaExceeded,true);
  ledger.reconcile({userId:'alice',generationId:'pending',decision:'release',evidence:'Provider evidence confirms no accepted request',operator:'qa-operator'});assert.equal(ledger.sponsorUsage('alice',provider).remainingTokens,1000);assert.throws(()=>ledger.reconcile({userId:'alice',generationId:'pending',decision:'release',evidence:'Provider evidence confirms no accepted request',operator:'qa-operator'}));
 }finally{ledger.close();rmSync(folder,{recursive:true,force:true})}
});

test('Sponsor reservation bounds UTF-8 text and configured output rather than using the hosted fixed reservation',()=>{
 const route={provider,model:provider.models[0]},messages=[{role:'user',content:'实际中文 input'}],tools=[];assert.equal(sponsorReservation(route,messages,tools),Buffer.byteLength(JSON.stringify({messages,tools}))+512);assert.equal(sponsorReservation(route,[{role:'user',content:'x'.repeat(50000)}],tools),16512);
});

test('Actual HTTP gateway selects only configured sponsor credentials, records authoritative funding and blocks stale replay or exhausted budget',async()=>{
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`))),close=server=>new Promise(resolve=>server.close(resolve));
 const folder=mkdtempSync(join(tmpdir(),'geod-sponsored-http-')),secret='s'.repeat(40),token='A'.repeat(43);let calls=0,gateway;
 const identity=createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({active:{userId:request.headers.authorization===`Bearer ${secret}`?'alice':'invalid',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}}))});
 const upstream=createServer(async(request,response)=>{assert.equal(request.headers.authorization,'Bearer sponsor-private-key');let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body);assert.equal(input.model,'qa-model');assert.equal(input.thinking,undefined);calls++;response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({id:'qa-upstream',model:'qa-model',choices:[{delta:{content:'Actual controlled HTTP response'},finish_reason:'stop'}],usage:{prompt_tokens:900,completion_tokens:20}})+'\n\ndata: [DONE]\n\n')});
 try{
  const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:secret,DEEPSEEK_API_KEY:'hosted-private-key',GEOD_IDENTITY_ORIGIN:await listen(identity),GEOD_AGENT_DB_PATH:join(folder,'ledger.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited',GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{...declaration,baseUrl:await listen(upstream)}]),QA_PROVIDER_KEY:'sponsor-private-key'});gateway=createGatewayServer(config);const base=await listen(gateway),headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const catalogue=await(await fetch(base+'/api/agent/sponsors',{headers})).json(),sponsor={providerId:declaration.id,modelId:'qa-model',revision:catalogue.sponsors[0].revision};assert(!JSON.stringify(catalogue).includes('private-key'));
  const body={generationId:'sponsored-generation-1',conversationId:'sponsored-chat',billingScope:'hosted',sponsor,request:{input:[{role:'user',content:'Use the declared provider.'}],tools:[]}};
  const first=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(first.status,200);const frames=(await first.text()).split('\n\n').filter(Boolean);const result=JSON.parse(frames.find(frame=>frame.startsWith('event: generation')).match(/data: (.+)/)[1]);assert.equal(result.billingScope,'sponsored');assert.equal(result.channelId,'sponsor:'+declaration.id);assert.equal(result.inputTokens,900);assert.equal(calls,1);
  const replay=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(replay.status,200);await replay.text();assert.equal(calls,1);
  const rejected=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({...body,generationId:'sponsored-generation-2'})});assert.equal(rejected.status,429);assert.equal((await rejected.json()).error,'SPONSOR_QUOTA_EXCEEDED');assert.equal(calls,1);assert.equal((await(await fetch(base+'/api/agent/usage',{headers})).json()).committedTokens,0);
  const changed=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({...body,sponsor:{...sponsor,revision:'stale'}})});assert.equal(changed.status,409);assert.equal((await changed.json()).error,'SPONSOR_CHANGED');assert.equal(calls,1);
 }finally{if(gateway)await close(gateway);await close(upstream);await close(identity);rmSync(folder,{recursive:true,force:true})}
});

test('Sponsored and personal requests cannot consume or receive refunds from the GeoD candidate wallet',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'geod-sponsored-wallet-'));const generation={generationId:'funded-generation',conversationId:'conversation',state:'settled',model:'arbitrary-funded-model',billingScope:'sponsored'};
 assert.equal(settledQuote(generation,'peak').retailNanoCny,'0');const store=createBillingCandidate(join(folder,'wallet.sqlite'),{callbackSecret:'s'.repeat(40),loadRun:async()=>({runId:'funded-run',conversationId:'conversation',status:'completed',usageResolved:true,generations:[generation]}),loadGeneration:async()=>generation});
 try{const result=await store.settleRun('owner','funded-run','peak');assert.equal(result.chargedRequests,0);assert.equal(result.externallyFundedRequests,1);assert.equal(store.summary('owner').balanceNanoCny,'0');assert.equal(store.summary('owner').receipts.length,0);generation.billingScope='personal';assert.equal((await store.settleRun('owner','funded-run','peak')).externallyFundedRequests,1);}finally{store.close();rmSync(folder,{recursive:true,force:true})}
});
