// Store bounded categories and request structure, never provider response text,
// user content, URLs, credentials, balances or tool schemas. Classifications are
// provider claims, not an independent check of the provider's billing ledger.
const reasons=new Set(['authentication','balance','payment_required','rate_limit','context_limit','image_unsupported','tools_invalid','messages_invalid','parameters_invalid','permission','provider_unavailable','unknown']);
const billingScopes=new Set(['api_key','account','upstream','unknown']);
const billingIssues=new Set(['quota_exhausted','balance_insufficient','precharge_rejected','unknown']);
const bodyFormats=new Set(['json','text','empty','oversized','unreadable']);
const codes=new Set(['invalid_api_key','insufficient_balance','insufficient_quota','insufficient_user_quota','pre_consume_token_quota_failed','rate_limit_exceeded','invalid_request_error','context_length_exceeded','permission_denied','model_not_found','invalid_request','authentication_error','invalid_parameter','invalid_parameter_error']);
const safeToken=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(v)&&!/^sk-|^Bearer|^AKID/i.test(v)?v:null;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;

function requestShape(request={}){
 const responses=Object.hasOwn(request,'input');
 const gemini=Array.isArray(request.contents);
 const items=responses?(Array.isArray(request.input)?request.input:typeof request.input==='string'?[{role:'user'}]:[]):gemini?request.contents:Array.isArray(request.messages)?request.messages:[];
 const role=item=>item?.role==='model'?'assistant':item?.role??(['function_call_output','custom_tool_call_output'].includes(item?.type)?'tool':['function_call','custom_tool_call','reasoning'].includes(item?.type)?'assistant':null);
 const lastRole=items.map(role).filter(Boolean).at(-1)??null;
 const images=items.reduce((n,item)=>n+(Array.isArray(item?.content)?item.content:Array.isArray(item?.parts)?item.parts:[]).filter(p=>['image_url','input_image','image'].includes(p?.type)||p?.inlineData?.mimeType?.startsWith('image/')||p?.fileData?.mimeType?.startsWith('image/')).length,0);
 return {messages:items.length,tools:Array.isArray(request.tools)?request.tools.length:0,images,lastRole,maxOutputTokens:request.max_output_tokens??request.max_completion_tokens??request.max_tokens??request.generationConfig?.maxOutputTokens};
}

function requestId(response,payload){
 // New API returns x-oneapi-request-id, including for forwarded rejections.
 return [response?.headers?.get('x-request-id'),response?.headers?.get('request-id'),response?.headers?.get('x-oneapi-request-id'),response?.headers?.get('x-amzn-requestid'),payload?.request_id,payload?.error?.request_id].map(safeToken).find(Boolean)??null;
}

function billingDiagnostic(detail,code){
 const precharge=code==='pre_consume_token_quota_failed'||/pre[ _-]?(?:consume|charge).{0,45}(?:fail|insufficient|not enough)|预(?:扣|消耗).{0,30}(?:不足|失败)/i.test(detail);
 const insufficient=/insufficient[\s_-]+(?:\w+[\s_-]+){0,3}(?:balance|credits?|quota)|(?:balance|credits?|quota).{0,40}(?:insufficient|not enough|too low|exhausted|exceeded)|(?:余额|额度).{0,25}(?:不足|耗尽|用尽)|不足.{0,12}(?:余额|额度)/i.test(detail);
 if(!precharge&&!insufficient&&!['insufficient_user_quota','insufficient_balance','insufficient_quota'].includes(code))return null;
 const scope=code==='pre_consume_token_quota_failed'?'api_key':code==='insufficient_user_quota'?'account':/(?:upstream|supplier|上游).{0,30}(?:quota|balance|credits?|额度|余额)/i.test(detail)?'upstream':/(?:user|account|wallet|用户|账户|钱包).{0,30}(?:quota|balance|额度|余额)/i.test(detail)?'account':/(?:api[ _-]?key|token|令牌).{0,30}(?:quota|balance|额度|余额)/i.test(detail)?'api_key':'unknown';
 return {scope,issue:precharge?'precharge_rejected':code==='insufficient_balance'||/balance|credits?|余额/i.test(detail)?'balance_insufficient':'quota_exhausted'};
}

export function safeDiagnostic(value){
 if(!value||!Number.isInteger(value.httpStatus)||value.httpStatus<100||value.httpStatus>599||!reasons.has(value.reason))return null;
 const shape=value.requestShape??{};
 const stages=new Set(['stream_parse','message_shape','tool_contract','provider_result']);
 const protocolCodes=new Set(['CODEX_UNDECLARED_TOOL','CODEX_CUSTOM_INPUT_INVALID','PROVIDER_STREAM_INCOMPLETE','PROVIDER_STREAM_INVALID','INVALID_USAGE_OR_MESSAGE','INVALID_TOOL_CONTRACT']);
 const protocol=stages.has(value.protocol?.stage)?{stage:value.protocol.stage,code:protocolCodes.has(value.protocol.code)?value.protocol.code:'INVALID_TOOL_CONTRACT',usagePresent:value.protocol.usagePresent===true,returnedTools:(Array.isArray(value.protocol.returnedTools)?value.protocol.returnedTools:[]).filter(n=>typeof n==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(n)&&!n.startsWith('sk_')).slice(0,12)}:null;
 let billing=billingScopes.has(value.billing?.scope)&&billingIssues.has(value.billing?.issue)?{scope:value.billing.scope,issue:value.billing.issue}:null;
 const providerCode=codes.has(value.providerCode)?value.providerCode:null;
 // Legacy diagnostics assigned 'balance' from status alone. Correct the view
 // without rewriting the original receipt or inventing a historical cause.
 if(!billing&&value.httpStatus===402)billing=billingDiagnostic('',providerCode);
 const reason=value.httpStatus===402&&value.reason==='balance'&&!billing?'payment_required':value.reason;
 if(!billing&&value.httpStatus===402)billing={scope:'unknown',issue:'unknown'};
 return {version:1,httpStatus:value.httpStatus,reason,providerCode,requestId:safeToken(value.requestId),...(protocol?{protocol}:{}),...(billing?{billing}:{}),...(bodyFormats.has(value.bodyFormat)?{bodyFormat:value.bodyFormat}:{}),retryAfterSeconds:count(value.retryAfterSeconds)===null?null:Math.min(value.retryAfterSeconds,86400),
  requestShape:{messages:count(shape.messages)??0,tools:count(shape.tools)??0,images:count(shape.images)??0,lastRole:['system','user','assistant','tool'].includes(shape.lastRole)?shape.lastRole:null,maxOutputTokens:count(shape.maxOutputTokens)}};
}

export function protocolDiagnostic(response,request,{stage,code,payload}={}){
 const calls=payload?.choices?.[0]?.message?.tool_calls;
 return safeDiagnostic({httpStatus:response?.status??200,reason:stage==='tool_contract'?'tools_invalid':'messages_invalid',requestId:requestId(response,payload)??safeToken(payload?.id),protocol:{stage,code,usagePresent:Number.isSafeInteger(payload?.usage?.prompt_tokens)&&Number.isSafeInteger(payload?.usage?.completion_tokens),returnedTools:(Array.isArray(calls)?calls:[]).map(c=>c?.function?.name)},requestShape:requestShape(request)});
}

export async function upstreamDiagnostic(response,request={}){
 let payload,reader,text='',bodyFormat='empty';
 try{
  reader=response.body?.getReader();
  if(reader){
   let bytes=0;const decoder=new TextDecoder();
   for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>16384){bodyFormat='oversized';text='';await reader.cancel();break;}text+=decoder.decode(next.value,{stream:true});}
   if(bodyFormat!=='oversized'){text+=decoder.decode();if(text.trim()){try{payload=JSON.parse(text);bodyFormat='json';}catch{bodyFormat='text';}}}
  }
 }catch{bodyFormat='unreadable';text='';}finally{reader?.releaseLock();}
 const e=payload?.error??payload??{};
 const code=[e.code,e.type].find(c=>codes.has(c))??null;
 const detail=bodyFormat==='json'?[typeof e==='string'?e:typeof e.message==='string'?e.message:'',typeof e.code==='string'?e.code:'',typeof e.type==='string'?e.type:''].join(' '):text;
 const status=response.status,billing=billingDiagnostic(detail,code);
 // An HTTP 402 is not proof that the key, account or upstream wallet is empty.
 // Keep unexplained payment rejections distinct; do not retry or alter budgets.
 const reason=status===401?'authentication':billing?'balance':status===402?'payment_required':status===429?'rate_limit':status>=500?'provider_unavailable':/context.{0,25}(?:length|limit)|maximum.*tokens|too many tokens/i.test(detail)?'context_limit':/image|vision|multimodal/i.test(detail)?'image_unsupported':/tool|function.{0,12}(?:name|schema|call)/i.test(detail)?'tools_invalid':/messages|role|reasoning_content/i.test(detail)?'messages_invalid':status===400||status===413||status===422?'parameters_invalid':status===403?'permission':'unknown';
 const retry=response.headers?.get('retry-after');const seconds=/^\d+$/.test(retry??'')?Number(retry):retry?Math.max(0,Math.ceil((Date.parse(retry)-Date.now())/1000)):null;
 return safeDiagnostic({httpStatus:status,reason,providerCode:code,requestId:requestId(response,payload),retryAfterSeconds:seconds,billing:billing??(status===402?{scope:'unknown',issue:'unknown'}:null),bodyFormat,requestShape:requestShape(request)});
}

export function upstreamFailureMessage(diagnostic){
 if(diagnostic?.reason==='balance'){
  if(diagnostic.billing?.issue==='precharge_rejected')return '模型渠道拒绝了本次额度预扣，请由服务方核对预扣与可用额度；任务状态已保留。';
  if(diagnostic.billing?.scope==='api_key')return '模型渠道报告 API Key 配额不足，请由服务方核对 Key 配额；任务状态已保留。';
  if(diagnostic.billing?.scope==='account')return '模型渠道报告账户额度不足，请由服务方核对结算账户；任务状态已保留。';
  if(diagnostic.billing?.scope==='upstream')return '模型渠道报告其上游额度不足，请由服务方检查上游渠道；任务状态已保留。';
  return '模型渠道报告额度不足，具体额度归属尚未确认；任务状态已保留。';
 }
 return {authentication:'模型渠道认证失败，需要检查服务端密钥配置。',payment_required:'模型渠道返回支付或额度拒绝（HTTP 402），具体原因尚未确认；任务状态已保留。',rate_limit:'模型渠道请求过于频繁，请按提示稍后重试。',context_limit:'请求超出模型上下文限制，需要整理上下文后再发送。',image_unsupported:'当前模型渠道不支持本次图片输入，请使用支持图片的模型。',tools_invalid:'模型渠道不接受当前工具定义，需要检查工具协议兼容性。',messages_invalid:'模型渠道不接受当前消息结构，需要检查消息协议兼容性。',parameters_invalid:'模型渠道不接受本次请求参数，需要检查协议兼容性。',permission:'模型渠道没有使用此模型的权限。',provider_unavailable:'模型渠道暂时不可用，请稍后检查状态。'}[diagnostic?.reason]??'模型渠道拒绝了请求，具体原因暂不可用；任务状态已保留。';
}
