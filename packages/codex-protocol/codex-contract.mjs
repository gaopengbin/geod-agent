import { createHash } from 'node:crypto';

export class ContractError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 400; }
}
const fail = code => { throw new ContractError(code); };
const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(part => {
      if (['input_text', 'output_text', 'text'].includes(part.type)) return part.text ?? '';
      fail('CODEX_INPUT_MODALITY_UNSUPPORTED');
    }).join('\n') : fail('INVALID_CODEX_CONTENT');
const messageContent=(value,role)=>{
  if(!Array.isArray(value)||!value.some(part=>part.type==='input_image'))return text(value);
  if(role!=='user')fail('CODEX_IMAGE_ROLE_UNSUPPORTED');
  return value.map(part=>{
    if(['input_text','text'].includes(part.type))return{type:'text',text:part.text??''};
    if(part.type!=='input_image'||typeof part.image_url!=='string'||!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url))fail('CODEX_IMAGE_INVALID');
    if(part.image_url.length>14_000_000)fail('CODEX_IMAGE_TOO_LARGE');
    const detail=part.detail??'auto';if(!['low','high','original','auto'].includes(detail))fail('CODEX_IMAGE_INVALID');
    return{type:'image_url',image_url:{url:part.image_url,detail}};
  });
};
const key = (name, namespace) => `${namespace ?? ''}\u0000${name}`;
const wireName = (name, namespace) => namespace
  ? `tool_${createHash('sha256').update(key(name, namespace)).digest('hex').slice(0, 24)}` : name;

/** Preserve the Codex contract while adapting a text/function model provider. */
export function codexRequest(request) {
  if (!request || !Array.isArray(request.input) || !Array.isArray(request.tools ?? [])) fail('INVALID_CODEX_REQUEST');
  const definitions = new Map();
  const tools = [];
  const addTool = (tool, namespace) => {
    if (!['function', 'custom'].includes(tool.type) || typeof tool.name !== 'string') fail('CODEX_TOOL_TYPE_UNSUPPORTED');
    const name = wireName(tool.name, namespace);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || definitions.has(name)) fail('INVALID_CODEX_TOOL');
    definitions.set(name, { name: tool.name, namespace, custom: tool.type === 'custom' });
    tools.push({ type: 'function', function: { name, description: tool.description ?? '',
      parameters: tool.type === 'custom'
        ? { type: 'object', properties: { input: { type: 'string', description: 'Exact free-form tool input.' } }, required: ['input'], additionalProperties: false }
        : tool.parameters ?? { type: 'object', properties: {} } } });
  };
  for (const tool of request.tools ?? []) {
    if (tool.type === 'namespace') for (const member of tool.tools ?? []) addTool(member, tool.name);
    else addTool(tool);
  }
  const messages = [];
  if (request.instructions) messages.push({ role: 'system', content: text(request.instructions) });
  const calls = new Map();
  let pendingReasoning = '';
  let pendingProviderState = null;
  for (const item of request.input) {
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const name = wireName(item.name, item.namespace);
      // Historical tool records survive disabling a connector. Only current
      // definitions authorize newly returned model tool calls.
      if (typeof item.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) fail('INVALID_CODEX_HISTORY_TOOL');
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments;
      const call = { id: item.call_id, type: 'function', function: { name, arguments: args } };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        previous.tool_calls ??= []; previous.tool_calls.push(call);
        previous.reasoning_content ??= pendingReasoning;
        if(pendingProviderState)previous.provider_state ??= pendingProviderState;
      }
      else messages.push({ role: 'assistant', content: null, reasoning_content: pendingReasoning, ...(pendingProviderState?{provider_state:pendingProviderState}:{}), tool_calls: [call] });
      pendingReasoning = '';
      pendingProviderState = null;
      calls.set(item.call_id, call);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      if (!calls.has(item.call_id)) fail('CODEX_HISTORY_TOOL_PAIR_INVALID');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : text(item.output) });
    } else if (item.type === 'reasoning') {
      pendingReasoning = [...(item.summary ?? []), ...(item.content ?? [])].map(part => part.text ?? '').join('\n');
      if(typeof item.encrypted_content==='string')pendingProviderState=item.encrypted_content;
    } else if (item.type === 'message' || item.role) {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) fail('INVALID_CODEX_ROLE');
      // DeepSeek's system role carries Responses developer instructions without demoting them to user content.
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: messageContent(item.content,item.role), ...(item.role === 'assistant' ? { reasoning_content: pendingReasoning,...(pendingProviderState?{provider_state:pendingProviderState}:{}) } : {}) });
      if (item.role === 'assistant' || item.role === 'user') {pendingReasoning = '';pendingProviderState=null;}
    } else fail('CODEX_INPUT_TYPE_UNSUPPORTED');
  }
  if (!messages.length || JSON.stringify(request).length > 48_000_000) fail('CODEX_CONTEXT_TOO_LARGE');
  return { messages, tools, definitions, hasImages:messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url')) };
}

export function codexResult(message, definitions) {
  const toolCalls = (message.tool_calls ?? []).map(call => {
    const definition = definitions.get(call.function?.name);
    if (!definition || typeof call.function?.arguments !== 'string' || typeof call.id !== 'string') fail('CODEX_UNDECLARED_TOOL');
    let input;
    if (definition.custom) {
      try { input = JSON.parse(call.function.arguments).input; } catch { fail('CODEX_CUSTOM_INPUT_INVALID'); }
      if (typeof input !== 'string') fail('CODEX_CUSTOM_INPUT_INVALID');
    }
    return { ...call, function: { ...call.function, name: definition.name },
      ...(definition.namespace ? { namespace: definition.namespace } : {}),
      ...(definition.custom ? { custom: true, input } : {}) };
  });
  return { role: 'assistant', content: message.content ?? null, toolCalls,
    reasoning: message.reasoning_content ?? null,
    phase: message.phase ?? (toolCalls.length ? 'commentary' : 'final_answer'),
    phaseSource: message.phase ? 'provider' : 'compatibility' };
}
