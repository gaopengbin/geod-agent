// Claude Messages and Gemini Developer API. Native transport still owns keys.
import {randomUUID} from 'node:crypto';
import {codexResult} from './codex-contract.mjs';
import {providerFail as fail} from './provider-error.mjs';
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const statePrefix='geod-native-state-v1:';
const stateOf=(snapshot,content,calls=[])=>statePrefix+Buffer.from(JSON.stringify({protocol:snapshot.protocol,model:snapshot.model,content,calls})).toString('base64');
function previousState(snapshot,message){
  if(typeof message.provider_state!=='string'||!message.provider_state.startsWith(statePrefix))return null;
  let value;try{value=JSON.parse(Buffer.from(message.provider_state.slice(statePrefix.length),'base64').toString('utf8'));}catch{fail('CHANNEL_THOUGHT_STATE_INVALID');}
  if(value.protocol!==snapshot.protocol)return null;
  if(!Array.isArray(value.content)||!Array.isArray(value.calls))fail('CHANNEL_THOUGHT_STATE_INVALID');
  return value;
}
const jsonArguments=text=>{let value;try{value=JSON.parse(text);}catch{fail('PROVIDER_TOOL_STREAM_INVALID');}if(!value||typeof value!=='object'||Array.isArray(value))fail('PROVIDER_TOOL_STREAM_INVALID');return value;};
const textParts=content=>typeof content==='string'?(content?[{type:'text',text:content}]:[]):Array.isArray(content)?content:[];
function image(part){
  const value=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url??'');
  if(!value)fail('CHANNEL_IMAGE_UNSUPPORTED');return {mime:value[1],data:value[2]};
}
function append(messages,role,content,field='content'){
  if(!content.length)return;const previous=messages.at(-1);
  if(previous?.role===role)previous[field].push(...content);else messages.push({role,[field]:content});
}
export function providerTransport(snapshot,key,catalogue=false){
  const base=snapshot.baseUrl.replace(/\/+$/,'');
  if(snapshot.protocol==='anthropic')return {url:`${base}/${catalogue?'models':'messages'}`,headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}};
  if(snapshot.protocol==='gemini')return {url:catalogue?`${base}/models`:`${base}/models/${encodeURIComponent(snapshot.model.replace(/^models\//,''))}:streamGenerateContent?alt=sse`,headers:{'x-goog-api-key':key}};
  return {url:`${base}/${catalogue?'models':snapshot.protocol==='responses'?'responses':'chat/completions'}`,headers:{Authorization:`Bearer ${key}`}};
}
export function nativeProviderRequest(snapshot,contract){
  const systems=contract.messages.filter(message=>message.role==='system').map(message=>({type:'text',text:message.content}));
  if(snapshot.protocol==='anthropic'){
    const messages=[];
    for(const message of contract.messages){
      if(message.role==='system')continue;
      if(message.role==='tool'){append(messages,'user',[{type:'tool_result',tool_use_id:message.tool_call_id,content:message.content}]);continue;}
      const saved=message.role==='assistant'?previousState(snapshot,message):null;
      const content=saved?saved.content:textParts(message.content).map(part=>{
        if(part.type==='text')return part;const media=image(part);return {type:'image',source:{type:'base64',media_type:media.mime,data:media.data}};
      });
      if(!saved)for(const call of message.tool_calls??[])content.push({type:'tool_use',id:call.id,name:call.function.name,input:jsonArguments(call.function.arguments)});
      append(messages,message.role,content);
    }
    const body={model:snapshot.model,max_tokens:snapshot.maxOutputTokens,messages,stream:true,...(systems.length?{system:systems}:{}),...(contract.tools.length?{tools:contract.tools.map(tool=>({name:tool.function.name,description:tool.function.description,input_schema:tool.function.parameters}))}:{})};
    if(snapshot.thinking==='enabled'){
      if(snapshot.maxOutputTokens<=1024)fail('CHANNEL_THINKING_BUDGET');
      body.thinking={type:'enabled',budget_tokens:Math.min(4096,Math.max(1024,Math.floor(snapshot.maxOutputTokens/2)))};
    }else if(snapshot.thinking==='adaptive')body.thinking={type:'adaptive'};
    else if(snapshot.thinking==='disabled')body.thinking={type:'disabled'};
    return body;
  }
  if(snapshot.protocol!=='gemini')fail('CHANNEL_PROTOCOL_INVALID');
  const contents=[],calls=new Map();
  for(const message of contract.messages){
    if(message.role==='system')continue;
    if(message.role==='tool'){
      const call=calls.get(message.tool_call_id);if(!call)fail('CODEX_HISTORY_TOOL_PAIR_INVALID');
      let response;try{response=JSON.parse(message.content);}catch{}if(!response||typeof response!=='object'||Array.isArray(response))response={output:message.content};
      append(contents,'user',[{functionResponse:{name:call.name,response,...(call.originalId?{id:call.originalId}:{})}}],'parts');continue;
    }
    const saved=message.role==='assistant'?previousState(snapshot,message):null;
    const parts=saved?saved.content:textParts(message.content).map(part=>{if(part.type==='text')return {text:part.text};const media=image(part);return {inlineData:{mimeType:media.mime,data:media.data}};});
    for(const call of message.tool_calls??[]){
      const original=saved?.calls.find(value=>value.id===call.id);calls.set(call.id,{name:call.function.name,originalId:original?.originalId??(!saved?call.id:null)});
      if(!saved)parts.push({functionCall:{name:call.function.name,args:jsonArguments(call.function.arguments),id:call.id}});
    }
    append(contents,message.role==='assistant'?'model':'user',parts,'parts');
  }
  return {contents,...(systems.length?{systemInstruction:{parts:systems.map(part=>({text:part.text}))}}:{}),
    ...(contract.tools.length?{tools:[{functionDeclarations:contract.tools.map(tool=>({name:tool.function.name,description:tool.function.description,parametersJsonSchema:tool.function.parameters}))}]}:{}),
    generationConfig:{maxOutputTokens:snapshot.maxOutputTokens,...(snapshot.thinking==='enabled'?{thinkingConfig:{includeThoughts:true}}:snapshot.thinking==='disabled'?{thinkingConfig:{thinkingBudget:0,includeThoughts:false}}:{})}};
}
function parsed(event){let value;try{value=JSON.parse(event.data);}catch{fail('PROVIDER_STREAM_INVALID');}if(value.error||value.type==='error')fail('PROVIDER_STREAM_ERROR');return value;}
async function collectAnthropic(snapshot,body,contract,onDelta,events){
  const blocks=new Map(),active=new Set();let message=null,usage={},finish=null,stopped=false,bytes=0;
  for await(const event of events(body)){
    const value=parsed(event);bytes+=event.data.length;if(bytes>32_000_000)fail('PROVIDER_OUTPUT_TOO_LARGE');
    if(value.type==='message_start'){if(message)fail('PROVIDER_STREAM_INVALID');message=value.message;usage={...message.usage};}
    else if(value.type==='content_block_start'){
      if(!Number.isInteger(value.index)||blocks.has(value.index))fail('PROVIDER_STREAM_INVALID');
      if(!['text','thinking','redacted_thinking','tool_use'].includes(value.content_block?.type))fail('PROVIDER_CONTENT_UNSUPPORTED');
      blocks.set(value.index,{...value.content_block});active.add(value.index);
    }else if(value.type==='content_block_delta'){
      const block=blocks.get(value.index),delta=value.delta;if(!block||!active.has(value.index))fail('PROVIDER_STREAM_INVALID');
      if(delta.type==='text_delta'&&block.type==='text'){block.text=(block.text??'')+delta.text;onDelta('content',delta.text);}
      else if(delta.type==='thinking_delta'&&block.type==='thinking'){block.thinking=(block.thinking??'')+delta.thinking;onDelta('reasoning',delta.thinking);}
      else if(delta.type==='signature_delta'&&block.type==='thinking')block.signature=(block.signature??'')+delta.signature;
      else if(delta.type==='input_json_delta'&&block.type==='tool_use')block.partial=(block.partial??'')+delta.partial_json;
    }else if(value.type==='content_block_stop'){
      const block=blocks.get(value.index);if(!block||!active.delete(value.index))fail('PROVIDER_STREAM_INVALID');
      if(block.type==='tool_use'){if(block.partial!==undefined)block.input=jsonArguments(block.partial||'{}');delete block.partial;}
    }else if(value.type==='message_delta'){finish=value.delta?.stop_reason??finish;usage={...usage,...value.usage};}
    else if(value.type==='message_stop'){stopped=true;break;}
  }
  if(!message||!stopped||active.size||!['end_turn','tool_use','stop_sequence','refusal'].includes(finish))fail(finish==='max_tokens'?'PROVIDER_OUTPUT_TRUNCATED':'PROVIDER_STREAM_INCOMPLETE');
  const content=[...blocks].sort(([a],[b])=>a-b).map(([,block])=>block);
  const result=codexResult({content:content.filter(block=>block.type==='text').map(block=>block.text??'').join(''),reasoning_content:content.filter(block=>block.type==='thinking').map(block=>block.thinking??'').join('')||null,
    tool_calls:content.filter(block=>block.type==='tool_use').map(block=>({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}}))},contract.definitions);
  result.providerState=stateOf(snapshot,content);
  const input=count(usage.input_tokens),cached=count(usage.cache_read_input_tokens),created=count(usage.cache_creation_input_tokens);
  return {id:message.id,model:message.model,result,inputTokens:input===null?null:input+(cached??0)+(created??0),outputTokens:count(usage.output_tokens),cachedInputTokens:cached,cacheWriteInputTokens:created,reasoningTokens:count(usage.output_tokens_details?.thinking_tokens)};
}
async function collectGemini(snapshot,body,contract,onDelta,events){
  const parts=[],calls=[],ids=new Set();let id=null,model=null,usage=null,finish=null,content='',reasoning='',bytes=0;
  for await(const event of events(body)){
    if(event.data==='[DONE]')break;const value=parsed(event);bytes+=event.data.length;if(bytes>32_000_000)fail('PROVIDER_OUTPUT_TOO_LARGE');
    if(value.promptFeedback?.blockReason)fail('PROVIDER_CONTENT_BLOCKED');
    id=value.responseId??id;model=value.modelVersion??model;usage=value.usageMetadata??usage;
    const candidate=value.candidates?.find(candidate=>candidate.index===0)??value.candidates?.[0];
    if(candidate?.finishReason)finish=candidate.finishReason;
    for(const part of candidate?.content?.parts??[]){
      parts.push(part);
      if(part.text!==undefined){
        if(typeof part.text!=='string')fail('PROVIDER_STREAM_INVALID');
        if(part.thought){reasoning+=part.text;onDelta('reasoning',part.text);}else {content+=part.text;onDelta('content',part.text);}
      }
      if(part.functionCall){
        const call=part.functionCall;if(call.partialArgs!==undefined)fail('PROVIDER_TOOL_STREAM_INVALID');
        const callId=call.id??`gemini_${randomUUID()}`;if(ids.has(callId))fail('PROVIDER_TOOL_STREAM_INVALID');ids.add(callId);
        const args=call.args??{};if(!args||typeof args!=='object'||Array.isArray(args))fail('PROVIDER_TOOL_STREAM_INVALID');
        calls.push({id:callId,originalId:call.id??null,type:'function',function:{name:call.name,arguments:JSON.stringify(args)}});
      }
      if(part.inlineData||part.executableCode||part.codeExecutionResult)fail('PROVIDER_CONTENT_UNSUPPORTED');
    }
  }
  if(finish!=='STOP')fail(finish==='MAX_TOKENS'?'PROVIDER_OUTPUT_TRUNCATED':['SAFETY','RECITATION','PROHIBITED_CONTENT','BLOCKLIST'].includes(finish)?'PROVIDER_CONTENT_BLOCKED':'PROVIDER_STREAM_INCOMPLETE');
  const result=codexResult({content,reasoning_content:reasoning||null,tool_calls:calls},contract.definitions);
  result.providerState=stateOf(snapshot,parts,calls.map(call=>({id:call.id,originalId:call.originalId})));
  const input=count(usage?.promptTokenCount),total=count(usage?.totalTokenCount),candidate=count(usage?.candidatesTokenCount),thoughts=count(usage?.thoughtsTokenCount);
  return {id,model,result,inputTokens:input,outputTokens:total!==null&&input!==null&&total>=input?total-input:candidate===null?null:candidate+(thoughts??0),cachedInputTokens:count(usage?.cachedContentTokenCount),reasoningTokens:thoughts};
}
export function collectNativeProvider(snapshot,body,contract,onDelta=()=>{},events){
  return snapshot.protocol==='anthropic'?collectAnthropic(snapshot,body,contract,onDelta,events):collectGemini(snapshot,body,contract,onDelta,events);
}
