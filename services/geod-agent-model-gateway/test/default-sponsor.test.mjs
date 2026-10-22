import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {readSponsors} from '../sponsors.mjs';
import {readDefaultSponsor} from '../default-sponsor.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';

const model={id:'qa-luna',name:'Luna',contextWindow:16000,maxOutputTokens:1024,inputModalities:['text']};
const declaration={id:'qa-luna',name:'Community Luna',allowedUsers:['*'],apiKeyEnv:'QA_LUNA_KEY',baseUrl:'https://provider.example/v1',protocol:'responses',models:[model],quotaMode:'observe'};
const env={GEOD_AGENT_DEFAULT_SPONSOR_ID:'qa-luna',GEOD_AGENT_DEFAULT_SPONSOR_REVIEW_AT:'2026-10-23T12:00:00Z'};
test('Default free campaign requires public unlimited provider; review does not silently enable paid fallback',()=>{
 const read=d=>readSponsors({GEOD_AGENT_SPONSORS_JSON:JSON.stringify([d]),QA_LUNA_KEY:'private-fixture-key'});
 assert.equal(readDefaultSponsor(env,read(declaration)).modelId,'qa-luna');
 for(const d of [{...declaration,allowedUsers:['alice']},{...declaration,enabled:false},{...declaration,quotaMode:'enforced',perUserTokenLimit:1,totalTokenLimit:2}])assert.throws(()=>readDefaultSponsor(env,read(d)));
 assert.throws(()=>readDefaultSponsor({...env,GEOD_AGENT_DEFAULT_SPONSOR_REVIEW_AT:'bad'},read(declaration)));
 assert.equal(readDefaultSponsor({},read(declaration)),null);
});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
const close=s=>new Promise(r=>s.close(r));
test('Old zero-credit and new accounts use default Luna with actual tool continuation, replay and no credit charge',async()=>{
 const root=mkdtempSync(join(tmpdir(),'geod-default-luna-'));let gateway,calls=0;
 const identity=createServer((req,res)=>res.end(JSON.stringify({active:{userId:req.headers.authorization?.includes('BBBB')?'new-user':'old-user',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}})));
 const upstream=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);assert.equal(body.model,model.id);assert.equal(req.headers.authorization,'Bearer private-fixture-key');calls++;
  const continued=body.input.some(x=>x.type==='function_call_output');
  const output=continued?[{id:'msg_ok',type:'message',role:'assistant',content:[{type:'output_text',text:'verified 42',annotations:[]}]}]:[{id:'fn_read',type:'function_call',call_id:'call_read',name:'read',arguments:'{}'}];
  const response={id:'resp_'+calls,status:'completed',model:model.id,output,usage:{input_tokens:50,output_tokens:10}};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.completed',response})+'\n\n');
 });
 try{
  const file=join(root,'model.sqlite');const wallet=createPaymentLedgerCandidate(file+'-credits.sqlite',{creditOnly:true,loadGeneration:()=>null});wallet.close();
  const config=readConfig({...env,GEOD_AGENT_WELCOME_CREDITS:'0',GEOD_AGENT_GATEWAY_SECRET:'s'.repeat(40),DEEPSEEK_API_KEY:'untouched-hosted-key',GEOD_IDENTITY_ORIGIN:await listen(identity),GEOD_AGENT_DB_PATH:file,GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{...declaration,baseUrl:await listen(upstream)}]),QA_LUNA_KEY:'private-fixture-key'});
  gateway=createGatewayServer(config);const base=await listen(gateway);
  for(const [user,token]of[['old','A'.repeat(43)],['new','B'.repeat(43)]]){
   const headers={authorization:'Bearer '+token,'content-type':'application/json'};
   const status=await(await fetch(base+'/v1/payments/status',{headers})).json();assert.equal(status.billingMode,'unlimited-test');
   const cap=await(await fetch(base+'/api/agent/capabilities',{headers})).json();assert.equal(cap.model,model.id);assert.equal(cap.protocol,'responses');assert.equal(cap.billingScope,'sponsored');
   const request={input:[{role:'user',content:'Read the file'}],tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}}]};
   const send=async(id,request)=>{const r=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({generationId:id,conversationId:'default-luna-chat',request})});assert.equal(r.status,200);const text=await r.text();return text.split('\n\n').filter(b=>b.startsWith('event: generation')).map(b=>JSON.parse(b.split('\ndata: ')[1]))[0];};
   const first=await send(user+'-first-generation',request);assert.equal(first.state,'settled');assert.equal(first.billingScope,'sponsored');assert.equal(first.result.toolCalls[0].function.name,'read');
   const count=calls;await send(user+'-first-generation',request);assert.equal(calls,count);
   const next=await send(user+'-next-generation',{...request,input:[...request.input,...first.result.response.output,{type:'function_call_output',call_id:'call_read',output:'42'}]});assert.equal(next.state,'settled');assert.equal(next.result.content,'verified 42');
   const w=await(await fetch(base+'/v1/payments/wallet',{headers})).json();assert.equal(w.chargeCount,0);assert.equal(String(w.availableNanoCny),'0');
  }
  config.sponsors[0].enabled=false;
  const r=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers:{authorization:'Bearer '+'A'.repeat(43),'content-type':'application/json'},body:JSON.stringify({generationId:'disabled-generation',conversationId:'default-luna-chat',request:{input:[{role:'user',content:'Hi'}]}})});assert.equal(r.status,409);assert.equal((await r.json()).error,'SPONSOR_DISABLED');assert.equal(calls,4);
 }finally{if(gateway)await close(gateway);await close(identity);await close(upstream);rmSync(root,{recursive:true,force:true});}
});
