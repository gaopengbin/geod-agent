// Experimental channel transport. Credentials are supplied by the native owner;
// they never belong to the serializable channel snapshot or Codex host process.
import {codexRequest, codexResult} from './codex-contract.mjs';
import {ProviderError, providerFail as fail} from './provider-error.mjs';
import {nativeProviderRequest,collectNativeProvider,providerTransport} from './provider-native.mjs';
export {ProviderError} from './provider-error.mjs';

export function channelSnapshot(config) {
  if (!config || !['chatCompletions', 'responses', 'anthropic', 'gemini'].includes(config.protocol)) fail('CHANNEL_PROTOCOL_INVALID');
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash) fail('CHANNEL_URL_CONTAINS_CREDENTIALS');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('CHANNEL_URL_INVALID');
  if (!config.id || !config.model || !config.credentialRef || !Number.isInteger(config.contextWindow) || config.contextWindow < 16000) fail('CHANNEL_CONFIG_INVALID');
  const snapshot = {
    id: config.id, name: config.name ?? config.id, protocol: config.protocol,
    baseUrl: url.href.replace(/\/+$/, ''), model: config.model,
    credentialRef: config.credentialRef, contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens ?? 4096,
    inputModalities: Object.freeze([...(config.inputModalities ?? ['text'])]),
    thinking: config.thinking ?? null, billingScope: 'personal',
  };
  if (!Number.isInteger(snapshot.maxOutputTokens) || snapshot.maxOutputTokens < 128 || snapshot.maxOutputTokens >= snapshot.contextWindow || ![null, 'enabled', 'disabled','adaptive'].includes(snapshot.thinking) || (snapshot.thinking==='adaptive'&&snapshot.protocol!=='anthropic')) fail('CHANNEL_CONFIG_INVALID');
  return Object.freeze(snapshot);
}

const usageValue = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function usageOf(usage, responses = false) {
  return {
    inputTokens: usageValue(responses ? usage?.input_tokens : usage?.prompt_tokens),
    outputTokens: usageValue(responses ? usage?.output_tokens : usage?.completion_tokens),
    cachedInputTokens: usageValue(responses ? usage?.input_tokens_details?.cached_tokens : usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens),
    reasoningTokens: usageValue(responses ? usage?.output_tokens_details?.reasoning_tokens : usage?.completion_tokens_details?.reasoning_tokens),
  };
}

export function providerRequest(snapshot, request) {
  if (snapshot.protocol === 'responses') {
    if ((request.input ?? []).some(item => Array.isArray(item.content) && item.content.some(part => part.type === 'input_image')) && !snapshot.inputModalities.includes('image')) fail('CHANNEL_IMAGE_UNSUPPORTED');
    // Preserve namespaces, custom tools, opaque reasoning and item IDs as-is.
    return {body: {...request, model: snapshot.model, stream: true, store: false, max_output_tokens: snapshot.maxOutputTokens}};
  }
  const contract = codexRequest(request);
  if (contract.hasImages && !snapshot.inputModalities.includes('image')) fail('CHANNEL_IMAGE_UNSUPPORTED');
  if (['anthropic','gemini'].includes(snapshot.protocol)) return {contract,body:nativeProviderRequest(snapshot,contract)};
  const messages = contract.messages.map(message => {
    const {provider_state,...clean}=message;
    if (snapshot.thinking === null) { const {reasoning_content, ...generic} = clean; return generic; }
    return clean;
  });
  return {contract, body: {model: snapshot.model, messages, tools: contract.tools,
    stream: true, stream_options: {include_usage: true}, max_tokens: snapshot.maxOutputTokens,
    ...(snapshot.thinking === null ? {} : {thinking: {type: snapshot.thinking}})}};
}

/** Decode arbitrary UTF-8 chunk boundaries, CRLF, comments and multi-line SSE. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder(); let buffer = '', data = [], event = '';
  const consume = line => {
    if (!line) { const value = data.length ? {event, data: data.join('\n')} : null; event = ''; data = []; return value; }
    if (line.startsWith(':')) return null;
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    if (data.join('\n').length > 16_000_000) fail('PROVIDER_EVENT_TOO_LARGE');
    return null;
  };
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, {stream: true});
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const value = consume(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1);
      if (value) yield value;
    }
    if (buffer.length > 16_000_000) fail('PROVIDER_EVENT_TOO_LARGE');
  }
  buffer += decoder.decode();
  if (buffer) { const value = consume(buffer.replace(/\r$/, '')); if (value) yield value; }
  const remaining = consume(''); if (remaining) yield remaining;
}

export async function collectChat(body, contract, onDelta = () => {}) {
  let content = '', reasoning = '', usage = null, id = null, model = null, finish = null;
  const calls = new Map();
  for await (const event of sseEvents(body)) {
    if (event.data === '[DONE]') break;
    let chunk; try { chunk = JSON.parse(event.data); } catch { fail('PROVIDER_STREAM_INVALID'); }
    if (chunk.error) fail('PROVIDER_STREAM_ERROR');
    id = chunk.id ?? id; model = chunk.model ?? model; usage = chunk.usage ?? usage;
    const choice = chunk.choices?.find(choice => choice.index === 0) ?? chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === 'string') { content += delta.content; onDelta('content', delta.content); }
    if (typeof delta.reasoning_content === 'string') { reasoning += delta.reasoning_content; onDelta('reasoning', delta.reasoning_content); }
    for (const fragment of delta.tool_calls ?? []) {
      if (!Number.isInteger(fragment.index)) fail('PROVIDER_TOOL_STREAM_INVALID');
      const call = calls.get(fragment.index) ?? {id: '', type: 'function', function: {name: '', arguments: ''}};
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      calls.set(fragment.index, call);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (content.length + reasoning.length + JSON.stringify([...calls]).length > 16_000_000) fail('PROVIDER_OUTPUT_TOO_LARGE');
  }
  if (!['stop', 'tool_calls'].includes(finish)) fail(finish === 'length' ? 'PROVIDER_OUTPUT_TRUNCATED' : 'PROVIDER_STREAM_INCOMPLETE');
  const result = codexResult({content: content || null, reasoning_content: reasoning || null,
    tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)}, contract.definitions);
  return {id, model, result, ...usageOf(usage)};
}

export async function collectResponses(body, onWire = () => {}) {
  let completed = null;
  for await (const event of sseEvents(body)) {
    if (event.data === '[DONE]') break;
    let value; try { value = JSON.parse(event.data); } catch { fail('PROVIDER_STREAM_INVALID'); }
    const kind = value.type ?? event.event;
    if (!kind) fail('PROVIDER_STREAM_INVALID');
    if (['response.failed', 'response.incomplete', 'error'].includes(kind)) fail('PROVIDER_RESPONSE_FAILED');
    onWire(kind, value);
    if (kind === 'response.completed') completed = value.response;
  }
  if (!completed || completed.status !== 'completed') fail('PROVIDER_STREAM_INCOMPLETE');
  const messages = (completed.output ?? []).filter(item => item.type === 'message');
  const toolCalls = (completed.output ?? []).filter(item => ['function_call', 'custom_tool_call'].includes(item.type)).map(item => ({
    id: item.call_id, type: 'function', function: {name: item.name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({input: item.input}) : item.arguments},
    ...(item.namespace ? {namespace: item.namespace} : {}), ...(item.type === 'custom_tool_call' ? {custom: true, input: item.input} : {}),
  }));
  return {id: completed.id, model: completed.model, ...usageOf(completed.usage, true),
    result: {response: completed, content: messages.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join(''), toolCalls,
      phase: messages.at(-1)?.phase ?? (toolCalls.length ? 'commentary' : 'final_answer'),
      reasoning: (completed.output ?? []).filter(item => item.type === 'reasoning').flatMap(item => item.summary ?? []).map(part => part.text ?? '').join('') || null}};
}

export async function listProviderModels(snapshot, apiKey, {fetchImpl = fetch, signal} = {}) {
  const transport=providerTransport(snapshot,apiKey,true);
  const response = await fetchImpl(transport.url, {headers:transport.headers, signal, redirect: 'error'});
  if (!response.ok) fail('PROVIDER_MODELS_HTTP_ERROR', response.status);
  const value = await response.json();
  const models=snapshot.protocol==='gemini'?value.models:value.data;
  if (!Array.isArray(models)) fail('PROVIDER_MODELS_INVALID');
  return models.filter(model => typeof (snapshot.protocol==='gemini'?model.name:model.id) === 'string').map(model => ({id: snapshot.protocol==='gemini'?model.name.replace(/^models\//,''):model.id}));
}

export async function generateProvider(snapshot, apiKey, request, {generationId, onDelta, onWire, fetchImpl = fetch, signal, timeoutMs = 180000} = {}) {
  const {body, contract} = providerRequest(snapshot, request);
  const controller = new AbortController(); const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  try {
    const transport=providerTransport(snapshot,apiKey);
    const response = await fetchImpl(transport.url, {
      method: 'POST', headers: {...transport.headers,'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    });
    // Never surface raw provider error bodies: they may echo request secrets.
    if (!response.ok) fail('PROVIDER_HTTP_ERROR', response.status);
    if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) fail('PROVIDER_STREAM_REQUIRED');
    const value = snapshot.protocol === 'responses'
      ? await collectResponses(response.body, onWire) : ['anthropic','gemini'].includes(snapshot.protocol)
        ? await collectNativeProvider(snapshot,response.body,contract,onDelta,sseEvents)
        : await collectChat(response.body, contract, onDelta);
    return {...value, result: {...value.result, usage: {cachedInputTokens: value.cachedInputTokens, reasoningTokens: value.reasoningTokens}}, generationId, state: 'settled', channelId: snapshot.id, selectedModel: snapshot.model,
      billingScope: snapshot.billingScope, usageKnown: value.inputTokens !== null && value.outputTokens !== null};
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError(signal?.aborted ? 'PROVIDER_CANCELLED' : 'PROVIDER_TIMEOUT');
    if (error instanceof ProviderError || error.code?.startsWith('CODEX_')) throw error;
    throw new ProviderError('PROVIDER_UNAVAILABLE');
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
