// Store bounded categories and request structure, never provider response text,
// user content, URLs, credentials or tool schemas.
const reasons=new Set(['authentication','balance','rate_limit','context_limit','image_unsupported','tools_invalid','messages_invalid','parameters_invalid','permission','provider_unavailable','unknown']);
export function safeDiagnostic(value){
 if(!value||!Number.isInteger(value.httpStatus)||value.httpStatus<100||value.httpStatus>599||!reasons.has(value.reason))return null;
 const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(v)&&!/^sk-|^Bearer|^AKID/i.test(v)?v:null;
 const shape=value.requestShape??{};
 const codes=new Set(['invalid_api_key','insufficient_balance','insufficient_quota','rate_limit_exceeded','invalid_request_error','context_length_exceeded','permission_denied','model_not_found','invalid_request','authentication_error','invalid_parameter','invalid_parameter_error']);
 const stages=new Set(['stream_parse','message_shape','tool_contract','provider_result']);
 const protocolCodes=new Set(['CODEX_UNDECLARED_TOOL','CODEX_CUSTOM_INPUT_INVALID','PROVIDER_STREAM_INCOMPLETE','PROVIDER_STREAM_INVALID','INVALID_USAGE_OR_MESSAGE','INVALID_TOOL_CONTRACT']);
 const protocol=stages.has(value.protocol?.stage)?{stage:value.protocol.stage,code:protocolCodes.has(value.protocol.code)?value.protocol.code:'INVALID_TOOL_CONTRACT',usagePresent:value.protocol.usagePresent===true,returnedTools:(Array.isArray(value.protocol.returnedTools)?value.protocol.returnedTools:[]).filter(n=>typeof n==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(n)&&!n.startsWith('sk_')).slice(0,12)}:null;
 return {version:1,httpStatus:value.httpStatus,reason:value.reason,providerCode:codes.has(value.providerCode)?value.providerCode:null,requestId:token(value.requestId),...(protocol?{protocol}:{}),retryAfterSeconds:Number.isSafeInteger(value.retryAfterSeconds)&&value.retryAfterSeconds>=0?Math.min(value.retryAfterSeconds,86400):null,
  requestShape:{messages:Number.isSafeInteger(shape.messages)?shape.messages:0,tools:Number.isSafeInteger(shape.tools)?shape.tools:0,images:Number.isSafeInteger(shape.images)?shape.images:0,lastRole:['system','user','assistant','tool'].includes(shape.lastRole)?shape.lastRole:null,maxOutputTokens:Number.isSafeInteger(shape.maxOutputTokens)?shape.maxOutputTokens:null}};
}
export function protocolDiagnostic(response,request,{stage,code,payload}={}){
 const calls=payload?.choices?.[0]?.message?.tool_calls;
 return safeDiagnostic({httpStatus:response?.status??200,reason:stage==='tool_contract'?'tools_invalid':'messages_invalid',requestId:response?.headers?.get('x-request-id')??response?.headers?.get('request-id')??payload?.id,protocol:{stage,code,usagePresent:Number.isSafeInteger(payload?.usage?.prompt_tokens)&&Number.isSafeInteger(payload?.usage?.completion_tokens),returnedTools:(Array.isArray(calls)?calls:[]).map(c=>c?.function?.name)},requestShape:{messages:request?.messages?.length??0,tools:request?.tools?.length??0,lastRole:request?.messages?.at(-1)?.role,maxOutputTokens:request?.max_tokens}});
}
export async function upstreamDiagnostic(response,request={}){
 let payload,reader;
 try{reader=response.body?.getReader();if(reader){let text='',bytes=0;const decoder=new TextDecoder();for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>16384){await reader.cancel();break;}text+=decoder.decode(next.value,{stream:true});}if(bytes<=16384)payload=JSON.parse(text);}}catch{/* Status alone still gives a safe category. */}finally{reader?.releaseLock();}
 const e=payload?.error??payload??{};const detail=String(e.message??'')+' '+String(e.code??'')+' '+String(e.type??'');
 const status=response.status;
 const reason=status===401?'authentication':status===402||/insufficient.*(?:balance|credit|quota)|balance.*insufficient|余额不足/i.test(detail)?'balance':status===429?'rate_limit':status>=500?'provider_unavailable':/context.{0,25}(?:length|limit)|maximum.*tokens|too many tokens/i.test(detail)?'context_limit':/image|vision|multimodal/i.test(detail)?'image_unsupported':/tool|function.{0,12}(?:name|schema|call)/i.test(detail)?'tools_invalid':/messages|role|reasoning_content/i.test(detail)?'messages_invalid':status===400||status===413||status===422?'parameters_invalid':status===403?'permission':'unknown';
 const retry=response.headers?.get('retry-after');const seconds=/^\d+$/.test(retry??'')?Number(retry):retry?Math.max(0,Math.ceil((Date.parse(retry)-Date.now())/1000)):null;
 return safeDiagnostic({httpStatus:status,reason,providerCode:typeof e.code==='string'?e.code:e.type,requestId:response.headers?.get('x-request-id')??response.headers?.get('request-id'),retryAfterSeconds:seconds,
  requestShape:{messages:request.messages?.length??0,tools:request.tools?.length??0,images:(request.messages??[]).reduce((n,m)=>n+(Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').length:0),0),lastRole:request.messages?.at(-1)?.role,maxOutputTokens:request.max_tokens}});
}
export const upstreamFailureMessage=diagnostic=>({authentication:'模型渠道认证失败，需要检查服务端密钥配置。',balance:'模型渠道余额不足，需要补充渠道额度。',rate_limit:'模型渠道请求过于频繁，请按提示稍后重试。',context_limit:'请求超出模型上下文限制，需要整理上下文后再发送。',image_unsupported:'当前模型渠道不支持本次图片输入，请使用支持图片的模型。',tools_invalid:'模型渠道不接受当前工具定义，需要检查工具协议兼容性。',messages_invalid:'模型渠道不接受当前消息结构，需要检查消息协议兼容性。',parameters_invalid:'模型渠道不接受本次请求参数，需要检查协议兼容性。',permission:'模型渠道没有使用此模型的权限。',provider_unavailable:'模型渠道暂时不可用，请稍后检查状态。'}[diagnostic?.reason]??'模型渠道拒绝了请求，具体原因暂不可用；任务状态已保留。');
