import test from 'node:test';
import assert from 'node:assert/strict';
import {channelSnapshot,providerRequest,generateProvider,listProviderModels} from './provider-adapter.mjs';
const snapshot=protocol=>channelSnapshot({id:'native-fixture',name:'Protocol fixture',protocol,baseUrl:'https://example.test/v1',model:'fixture-model',credentialRef:'system-vault-ref',contextWindow:128000,inputModalities:['text','image']});
const request={instructions:'Use the actual tool result.',input:[{role:'user',content:'检查随机文件'}],tools:[{type:'namespace',name:'files',tools:[{type:'custom',name:'read',description:'Read a file'}]}]};
const event=value=>`data: ${JSON.stringify(value)}\r\n\r\n`;
const response=stream=>new Response(new ReadableStream({start(controller){for(const byte of Buffer.from(stream))controller.enqueue(new Uint8Array([byte]));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
const anthropicTool=(name,finish='tool_use',complete=true)=>[
  {type:'message_start',message:{id:'msg_fixture',model:'fixture-model',usage:{input_tokens:20,cache_read_input_tokens:10,cache_creation_input_tokens:3,output_tokens:1}}},
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
  {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'先读实际文件。'}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signed-opaque-'}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'state'}},
  {type:'content_block_stop',index:0},
  {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'toolu_fixture',name,input:{}}},
  {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"input":'}},
  {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"范围.geojson"}'}},
  ...(complete?[{type:'content_block_stop',index:1}]:[]),
  {type:'message_delta',delta:{stop_reason:finish},usage:{output_tokens:11,output_tokens_details:{thinking_tokens:7}}},
  {type:'message_stop'},
].map(event).join('');
function history(result){
  const call=result.toolCalls[0];return {...request,input:[...request.input,{type:'reasoning',summary:[],encrypted_content:result.providerState},
    ...(result.content?[{type:'message',role:'assistant',content:[{type:'output_text',text:result.content}]}]:[]),
    {type:'custom_tool_call',name:call.function.name,namespace:call.namespace,call_id:call.id,input:call.input},
    {type:'custom_tool_call_output',call_id:call.id,output:'实际随机文件内容'}]};
}
test('Claude streams fragmented tool input and carries exact signed thinking through tool history',async()=>{
  const config=snapshot('anthropic'),wire=providerRequest(config,request).body.tools[0].name,deltas=[];
  const result=await generateProvider(config,'native-only-key',request,{onDelta:(part,text)=>deltas.push({part,text}),fetchImpl:async(url,options)=>{
    assert.equal(url,'https://example.test/v1/messages');assert.equal(options.headers['x-api-key'],'native-only-key');assert.equal(options.headers['anthropic-version'],'2023-06-01');assert.equal(options.headers.Authorization,undefined);return response(anthropicTool(wire));
  }});
  assert.equal(result.result.toolCalls[0].input,'范围.geojson');assert.equal(result.result.toolCalls[0].namespace,'files');assert.equal(result.inputTokens,33);assert.equal(result.outputTokens,11);assert.equal(result.cachedInputTokens,10);assert.equal(result.reasoningTokens,7);assert(deltas.some(delta=>delta.text==='先读实际文件。'));
  const replay=providerRequest(config,history(result.result)).body;
  assert.deepEqual(replay.messages[1].content,[{type:'thinking',thinking:'先读实际文件。',signature:'signed-opaque-state'},{type:'tool_use',id:'toolu_fixture',name:wire,input:{input:'范围.geojson'}}]);
  assert.deepEqual(replay.messages[2].content,[{type:'tool_result',tool_use_id:'toolu_fixture',content:'实际随机文件内容'}]);assert(!JSON.stringify(replay).includes('native-only-key'));
});
test('Gemini retains function thought signatures and synthetic IDs over repeated tool rounds',async()=>{
  const config=snapshot('gemini'),wire=providerRequest(config,request).body.tools[0].functionDeclarations[0].name;
  const nativePart={functionCall:{name:wire,args:{input:'范围.geojson'}},thoughtSignature:'signed-gemini-part'};
  const stream=event({responseId:'gemini-response',modelVersion:'fixture-model',candidates:[{index:0,content:{role:'model',parts:[{thought:true,text:'先读。'}]}}]})+
    event({candidates:[{index:0,content:{role:'model',parts:[nativePart]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:8,thoughtsTokenCount:12,totalTokenCount:70,cachedContentTokenCount:21}});
  const result=await generateProvider(config,'native-only-key',request,{fetchImpl:async(url,options)=>{assert.equal(url,'https://example.test/v1/models/fixture-model:streamGenerateContent?alt=sse');assert.equal(options.headers['x-goog-api-key'],'native-only-key');assert.equal(options.headers.Authorization,undefined);return response(stream);}});
  assert.equal(result.outputTokens,20);assert.equal(result.reasoningTokens,12);assert.equal(result.cachedInputTokens,21);assert.equal(result.result.toolCalls[0].input,'范围.geojson');
  const replay=providerRequest(config,history(result.result)).body;
  assert.deepEqual(replay.contents[1].parts,[{thought:true,text:'先读。'},nativePart]);
  assert.deepEqual(replay.contents[2].parts,[{functionResponse:{name:wire,response:{output:'实际随机文件内容'}}}]);
});
test('Native providers preserve images, tool schemas and adaptive thinking settings',()=>{
  const input={...request,input:[{role:'user',content:[{type:'input_text',text:'Read this image.'},{type:'input_image',image_url:'data:image/png;base64,YWJj'}]}]};
  const claude=providerRequest(channelSnapshot({...snapshot('anthropic'),thinking:'adaptive'}),input).body;assert.deepEqual(claude.thinking,{type:'adaptive'});assert.equal(claude.messages[0].content[1].source.media_type,'image/png');
  const gemini=providerRequest(snapshot('gemini'),input).body;assert.deepEqual(gemini.contents[0].parts[1],{inlineData:{mimeType:'image/png',data:'YWJj'}});assert.equal(gemini.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties,false);
  assert.throws(()=>channelSnapshot({...snapshot('gemini'),thinking:'adaptive'}),/CONFIG_INVALID/);
  assert.throws(()=>providerRequest(channelSnapshot({...snapshot('anthropic'),thinking:'enabled',maxOutputTokens:1024}),request),/THINKING_BUDGET/);
});
test('Incomplete or truncated native tool streams never return executable tool results',async()=>{
  const claude=snapshot('anthropic'),wire=providerRequest(claude,request).body.tools[0].name;
  for(const stream of [anthropicTool(wire,'tool_use',false),anthropicTool(wire,'max_tokens')])await assert.rejects(generateProvider(claude,'key',request,{fetchImpl:async()=>response(stream)}),/INCOMPLETE|TRUNCATED/);
  const gemini=snapshot('gemini'),name=providerRequest(gemini,request).body.tools[0].functionDeclarations[0].name;
  await assert.rejects(generateProvider(gemini,'key',request,{fetchImpl:async()=>response(event({candidates:[{content:{parts:[{functionCall:{name,args:{input:'x'}}}]},finishReason:'MAX_TOKENS'}]}))}),/TRUNCATED/);
  await assert.rejects(generateProvider(gemini,'key',request,{fetchImpl:async()=>response(event({promptFeedback:{blockReason:'SAFETY'}}))}),/BLOCKED/);
});
test('Unknown usage stays unknown and undeclared Claude tools remain rejected',async()=>{
  const config=snapshot('anthropic'),wire=providerRequest(config,request).body.tools[0].name;
  const stream=anthropicTool(wire).split('\r\n\r\n').filter(Boolean).map(text=>JSON.parse(text.slice(6))).map(value=>{if(value.message)delete value.message.usage;delete value.usage;return event(value);}).join('');
  const result=await generateProvider(config,'key',request,{fetchImpl:async()=>response(stream)});assert.equal(result.inputTokens,null);assert.equal(result.outputTokens,null);assert.equal(result.cachedInputTokens,null);assert.equal(result.usageKnown,false);
  await assert.rejects(generateProvider(config,'key',request,{fetchImpl:async()=>response(anthropicTool('undeclared_tool'))}),/UNDECLARED_TOOL/);
});
test('Native catalogue discovery uses provider authentication and real model IDs',async()=>{
  const claude=await listProviderModels(snapshot('anthropic'),'key',{fetchImpl:async(_url,options)=>{assert.equal(options.headers['x-api-key'],'key');return Response.json({data:[{id:'actual-claude-id'}]});}});assert.deepEqual(claude,[{id:'actual-claude-id'}]);
  const gemini=await listProviderModels(snapshot('gemini'),'key',{fetchImpl:async(url,options)=>{assert.equal(url,'https://example.test/v1/models');assert.equal(options.headers['x-goog-api-key'],'key');return Response.json({models:[{name:'models/actual-gemini-id'}]});}});assert.deepEqual(gemini,[{id:'actual-gemini-id'}]);
});
test('Signed native history is retained by its protocol and omitted from chat payloads',async()=>{
  const config=snapshot('anthropic'),wire=providerRequest(config,request).body.tools[0].name;
  const generation=await generateProvider(config,'key',request,{fetchImpl:async()=>response(anthropicTool(wire))});
  const replay=providerRequest(channelSnapshot({...config,protocol:'chatCompletions'}),history(generation.result)).body;assert(!JSON.stringify(replay).includes('provider_state'));assert(!JSON.stringify(replay).includes('signed-opaque-state'));
});
