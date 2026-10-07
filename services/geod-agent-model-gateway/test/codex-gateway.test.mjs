import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGatewayServer,readConfig} from '../server.mjs';

test('Codex gateway preserves full instructions, runtime schemas, namespaced tools, reasoning and usage',async()=>{
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
 const close=server=>new Promise(resolve=>server.close(resolve));
 const folder=mkdtempSync(join(tmpdir(),'geod-codex-contract-'));const secret='s'.repeat(40),token='A'.repeat(43);
 let upstreamCalls=0,mode='tools';
 const identity=createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${secret}`);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({active:{userId:'contract-user',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}}));});
 const upstream=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);upstreamCalls++;
  assert.equal(request.messages[0].content,'The complete runtime instructions.');
  assert.equal(request.messages[1].role,'system');assert.equal(request.messages[1].content,'Preserve developer instructions.');
  assert.equal(request.messages[2].content.length,65000,'Long messages are not silently trimmed to the legacy limit');
  assert.deepEqual(request.thinking,{type:'enabled'});assert.equal(request.max_tokens,8192);
  assert.equal(request.tools.length,1);const wire=request.tools[0].function.name;
  assert.match(wire,/^tool_/);assert.equal(request.tools[0].function.parameters.properties.input.type,'string');
  if(mode==='length'){
   res.writeHead(200,{'content-type':'text/event-stream'});
   for(const choice of [{delta:{reasoning_content:'Leg 3 ('}},{delta:{},finish_reason:'length'}])res.write(`data: ${JSON.stringify({id:'limited-output',choices:[choice]})}\n\n`);
   res.write(`data: ${JSON.stringify({id:'limited-output',choices:[],usage:{prompt_tokens:16000,completion_tokens:8192}})}\n\n`);res.end('data: [DONE]\n\n');return;
  }
  if(request.messages.at(-1).role==='tool'){
   assert.equal(request.messages.at(-2).reasoning_content,'Use the actual GIS tool.');
   assert.equal(request.messages.at(-1).content,'Converted to GPKG.');
  }
  res.writeHead(200,{'content-type':'text/event-stream'});
  const chunk=(delta,usage=null)=>res.write(`data: ${JSON.stringify({id:'upstream-contract',choices:delta?[{delta}]:[],usage})}\n\n`);
  chunk({reasoning_content:'Use the actual GIS tool.'});
  chunk({content:'Preparing the conversion.'});
  chunk({tool_calls:[{index:0,id:'actual-call',type:'function',function:{name:wire,arguments:JSON.stringify({input:'exact tool input'})}}]});
  res.write(`data: ${JSON.stringify({id:'upstream-contract',choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\n`);
  chunk(null,{prompt_tokens:16000,completion_tokens:99,prompt_tokens_details:{cached_tokens:500},completion_tokens_details:{reasoning_tokens:80}});
  res.end('data: [DONE]\n\n');
 });
 let gateway;
 try{
  const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:secret,DEEPSEEK_API_KEY:'test-key',GEOD_IDENTITY_ORIGIN:await listen(identity),DEEPSEEK_BASE_URL:await listen(upstream),GEOD_AGENT_DB_PATH:join(folder,'ledger.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited'});
  gateway=createGatewayServer(config);const base=await listen(gateway);
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const capabilities=await(await fetch(base+'/api/agent/capabilities',{headers})).json();assert.equal(capabilities.reasoning,true);assert.equal(capabilities.contextWindow,128000);
  const request={instructions:'The complete runtime instructions.',tools:[{type:'namespace',name:'gis',tools:[{type:'custom',name:'convert',description:'Convert files'}]}],input:[{role:'developer',content:'Preserve developer instructions.'},{role:'user',content:'x'.repeat(65000)}]};
  async function generate(id,input=request){const response=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({generationId:id,conversationId:'codex-contract-chat',request:input})});assert.equal(response.status,200);const events=(await response.text()).split('\n\n').filter(Boolean).map(frame=>({type:frame.match(/event: ([^\n]+)/)?.[1],data:JSON.parse(frame.match(/data: (.+)/)[1])}));return {events,generation:events.find(e=>e.type==='generation').data};}
  const first=await generate('contract-generation-1');
  assert.ok(first.events.some(e=>e.type==='reasoning_delta'));assert.ok(first.events.some(e=>e.type==='content_delta'));
  assert.equal(first.generation.state,'settled');assert.equal(first.generation.inputTokens,16000);assert.equal(first.generation.result.toolCalls[0].namespace,'gis');assert.equal(first.generation.result.toolCalls[0].input,'exact tool input');assert.equal(first.generation.result.usage.cachedInputTokens,500);
  assert.equal(first.generation.result.finishReason,'tool_calls');
  await generate('contract-generation-1');assert.equal(upstreamCalls,1,'Idempotent retry does not spend again');
  await generate('contract-generation-2',{...request,input:[...request.input,{type:'reasoning',summary:[{type:'summary_text',text:first.generation.result.reasoning}]},{type:'custom_tool_call',namespace:'gis',name:'convert',call_id:'actual-call',input:'exact tool input'},{type:'custom_tool_call_output',call_id:'actual-call',output:'Converted to GPKG.'}]});
  mode='length';const limited=await generate('contract-output-limit');assert.equal(limited.generation.state,'settled','Known provider usage is still recorded');assert.equal(limited.generation.outputTokens,8192);assert.equal(limited.generation.result.finishReason,'length');assert.equal(limited.generation.result.content,null);assert.deepEqual(limited.generation.result.toolCalls,[]);await generate('contract-output-limit');assert.equal(upstreamCalls,3,'Re-reading a truncated result must not issue another paid request');
  const rejected=await fetch(base+'/api/agent/codex/generations/stream',{method:'POST',headers,body:JSON.stringify({generationId:'contract-invalid',conversationId:'codex-contract-chat',request:{input:[{role:'user',content:[{type:'input_image',image_url:'data:'}]}],tools:[]}})});
  assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,'CODEX_IMAGE_INVALID');assert.equal(upstreamCalls,3);
 }finally{if(gateway)await close(gateway);await Promise.all([close(identity),close(upstream)]);rmSync(folder,{recursive:true,force:true});}
});
