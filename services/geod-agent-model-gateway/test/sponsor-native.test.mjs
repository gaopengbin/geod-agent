import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readSponsors,sponsorRoute,sponsorAvailability,sponsorReservation} from '../sponsors.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';

const model={id:'qa-model',name:'QA Model',contextWindow:16000,maxOutputTokens:2048,inputModalities:['text','image'],thinking:null};
const declaration={id:'qa-native',name:'QA Native Sponsor',allowedUsers:['alice'],apiKeyEnv:'QA_PROVIDER_KEY',baseUrl:'https://provider.example/v1',models:[model]};
const read=value=>readSponsors({GEOD_AGENT_SPONSORS_JSON:JSON.stringify([value]),QA_PROVIDER_KEY:'private-sponsor-key'})[0];
const input=provider=>({providerId:provider.id,modelId:'qa-model',revision:provider.revision});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close=server=>new Promise(resolve=>server.close(resolve));
const frame=value=>`data: ${JSON.stringify(value)}\r\n\r\n`;
const decode=text=>text.split(/\r?\n\r?\n/).filter(Boolean).map(block=>({event:block.match(/^event: (.+)/m)?.[1],value:JSON.parse(block.match(/^data: (.+)/m)[1])}));

test('Operator capability and activity declarations validate all protocols, images, explicit dates and legacy defaults',()=>{
  assert.equal(read(declaration).protocol,'chatCompletions');assert.equal(read(declaration).startsAt,null);
  const legacyModel={...model,inputModalities:['text']},legacy=read({...declaration,models:[legacyModel]});const previousRevision=createHash('sha256').update(JSON.stringify({id:declaration.id,name:declaration.name,upstreamBase:declaration.baseUrl,models:[legacyModel],policy:{quotaEnforced:false,perUserTokenLimit:null,totalTokenLimit:null},enabled:true,allowedUsers:['alice'],keyHash:createHash('sha256').update('private-sponsor-key').digest('hex')})).digest('hex');assert.equal(legacy.revision,previousRevision,'Previously scheduled text sponsor revisions must survive the protocol upgrade');
  for(const protocol of ['chatCompletions','responses','anthropic','gemini'])assert.equal(read({...declaration,protocol}).protocol,protocol);
  for(const changed of [{protocol:'unknown'},{startsAt:'2026-10-04'},{startsAt:'2026-02-30T10:00:00Z'},{startsAt:'2026-10-04T24:00:00Z'},{startsAt:'2026-10-05T00:00:00Z',endsAt:'2026-10-04T00:00:00Z'},{protocol:'gemini',models:[{...model,thinking:'adaptive'}]},{models:[{...model,inputModalities:['text','image','image']}]},{protocol:'anthropic',models:[{...model,thinking:'enabled',maxOutputTokens:1024}]}])assert.throws(()=>read({...declaration,...changed}));
  const provider=read({...declaration,startsAt:'2026-10-04T12:00:00+08:00',endsAt:'2026-10-05T12:00:00+08:00'});
  assert.equal(provider.startsAt,'2026-10-04T04:00:00.000Z');assert.equal(sponsorAvailability(provider,Date.parse(provider.startsAt)),'active');
  assert.throws(()=>sponsorRoute([provider],input(provider),'alice',Date.parse(provider.startsAt)-1),e=>e.code==='SPONSOR_NOT_STARTED');
  assert.throws(()=>sponsorRoute([provider],input(provider),'alice',Date.parse(provider.endsAt)),e=>e.code==='SPONSOR_ENDED');
  assert.equal(sponsorRoute([provider],input(provider),'alice',Date.parse(provider.startsAt)).model.id,model.id);
  assert.notEqual(provider.revision,read({...declaration,protocol:'responses'}).revision);
  assert.equal(sponsorReservation({provider,model},[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]}],[]),18048);
});

function stream(protocol,body,round,bad){
  const wire=protocol==='responses'?'read':protocol==='anthropic'?body.tools[0].name:protocol==='gemini'?body.tools[0].functionDeclarations[0].name:body.tools[0].function.name;
  const name=bad==='undeclared'?'not_declared':wire,id=`actual-${protocol}-${round}`,text='实际文件值 42',tool={id:'call_native',type:'function',function:{name,arguments:'{"q":"data"}'}};
  let events;
  if(protocol==='chatCompletions')events=[{id,model:model.id,choices:[{index:0,delta:round?{content:text}:{reasoning_content:'读取真实工具。',tool_calls:[{index:0,...tool}]},finish_reason:round?'stop':'tool_calls'}],...(bad==='missingUsage'?{}:{usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:20}})},'[DONE]'];
  else if(protocol==='responses'){
    const output=round?[{id:'msg_native',type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text,annotations:[]}]}]:[{id:'reason_native',type:'reasoning',summary:[],encrypted_content:'preserve-opaque-native'},{id:'fn_native',type:'function_call',call_id:tool.id,name,namespace:'files',arguments:tool.function.arguments}];
    const response={id,status:'completed',model:model.id,output,...(bad==='missingUsage'?{}:{usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20}}})};
    events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.completed',response}];
  }else if(protocol==='anthropic'){
    const block=round?{type:'text',text}:{type:'tool_use',id:tool.id,name,input:{q:'data'}};
    events=[{type:'message_start',message:{id,model:model.id,...(bad==='missingUsage'?{}:{usage:{input_tokens:80,cache_read_input_tokens:20,output_tokens:0}})}},{type:'content_block_start',index:0,content_block:block},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:round?'end_turn':'tool_use'},...(bad==='missingUsage'?{}:{usage:{output_tokens:10}})},{type:'message_stop'}];
  }else events=[{responseId:id,modelVersion:model.id,candidates:[{index:0,content:{role:'model',parts:round?[{text}]:[{functionCall:{name,args:{q:'data'},id:tool.id},thoughtSignature:'preserve-gemini-signature'}]},finishReason:'STOP'}],...(bad==='missingUsage'?{}:{usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110,cachedContentTokenCount:20}})}];
  if(bad==='truncated')events.pop();
  return events.map(value=>value==='[DONE]'?'data: [DONE]\r\n\r\n':frame(value)).join('');
}

for(const protocol of ['chatCompletions','responses','anthropic','gemini'])test(`Actual sponsored ${protocol} HTTP authenticates, preserves images and tool history, settles separately and replays once`,async()=>{
  const folder=mkdtempSync(join(tmpdir(),'geod-sponsored-native-')),secret='s'.repeat(40),token='A'.repeat(43),requests=[];
  const identity=createServer((_request,response)=>response.end(JSON.stringify({active:{userId:'alice',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}})));
  let gateway,round=0,bad=null;
  const upstream=createServer(async(request,response)=>{
    const expected=protocol==='anthropic'?'x-api-key':protocol==='gemini'?'x-goog-api-key':'authorization';
    assert.equal(request.headers[expected],protocol==='anthropic'||protocol==='gemini'?'private-sponsor-key':'Bearer private-sponsor-key');
    if(protocol==='anthropic')assert.equal(request.headers['anthropic-version'],'2023-06-01');
    let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push({path:request.url,body});
    const serialized=JSON.stringify(body);assert(serialized.includes(protocol==='responses'?'input_image':protocol==='anthropic'?'"base64"':protocol==='gemini'?'inlineData':'image_url'));assert(serialized.includes('YWJj'));
    if(round&&!bad){assert(serialized.includes('真实值42'));if(protocol==='responses')assert(serialized.includes('preserve-opaque-native'));if(protocol==='gemini')assert(serialized.includes('preserve-gemini-signature'));}
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(stream(protocol,body,round++,bad));
  });
  try{
    const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:secret,DEEPSEEK_API_KEY:'hosted-key',GEOD_IDENTITY_ORIGIN:await listen(identity),GEOD_AGENT_DB_PATH:join(folder,'ledger.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited',GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{...declaration,protocol,baseUrl:await listen(upstream)}]),QA_PROVIDER_KEY:'private-sponsor-key'});
    gateway=createGatewayServer(config);const base=await listen(gateway),headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const catalogue=await(await fetch(base+'/api/agent/sponsors',{headers})).json(),sponsor=catalogue.sponsors[0];assert.equal(sponsor.protocol,protocol);assert(!JSON.stringify(sponsor).includes('private-sponsor-key'));
    const request={input:[{role:'user',content:[{type:'input_text',text:'读取真实工具'},{type:'input_image',image_url:'data:image/png;base64,YWJj'}]}],tools:[{type:'namespace',name:'files',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{q:{type:'string'}}}}]}]};
    const send=async(id,request)=>{const response=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({generationId:id,conversationId:'sponsor-protocol-chat',sponsor:input(sponsor),request})});assert.equal(response.status,200);return decode(await response.text());};
    const first=await send('protocol-first-generation',request),generation=first.find(value=>value.event==='generation').value;assert.equal(generation.state,'settled');assert.equal(generation.billingScope,'sponsored');assert.equal(generation.inputTokens,100);assert.equal(generation.result.toolCalls[0].namespace,'files');
    const replay=await send('protocol-first-generation',request);assert.equal(requests.length,1);if(protocol==='responses')assert(replay.some(value=>value.event==='wire'&&value.value.event==='response.completed'&&value.value.data.response.output[0].encrypted_content==='preserve-opaque-native'));
    const history=protocol==='responses'?generation.result.response.output:[...(generation.result.providerState?[{type:'reasoning',encrypted_content:generation.result.providerState,summary:[]}]:[]),{type:'function_call',namespace:'files',name:'read',call_id:'call_native',arguments:'{"q":"data"}'}];
    const second=await send('protocol-next-generation',{...request,input:[...request.input,...history,{type:'function_call_output',call_id:'call_native',output:'真实值42'}]});assert.equal(second.at(-1).value.result.content,'实际文件值 42');assert.equal(requests.length,2);
    const usage=await(await fetch(base+'/api/agent/usage',{headers})).json();assert.equal(usage.committedTokens,0);
    const updated=await(await fetch(base+'/api/agent/sponsors',{headers})).json();assert.equal(updated.sponsors[0].usage.committedTokens,220);
    bad='missingUsage';const missing=await send('protocol-missing-usage',request);assert.equal(missing.at(-1).value.state,'pending_reconcile');assert.equal((await(await fetch(base+'/api/agent/sponsors',{headers})).json()).sponsors[0].usage.committedTokens,220);
    if(protocol==='responses'){bad='undeclared';round=0;const invalid=await send('protocol-undeclared-tool',request);assert.equal(invalid.at(-1).value.state,'pending_reconcile');assert.equal(invalid.at(-1).value.result,null);}
  }finally{if(gateway)await close(gateway);await close(upstream);await close(identity);rmSync(folder,{recursive:true,force:true});}
});
