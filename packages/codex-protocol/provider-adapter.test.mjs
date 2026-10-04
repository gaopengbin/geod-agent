import test from 'node:test';
import assert from 'node:assert/strict';
import {channelSnapshot, providerRequest, collectChat, collectResponses, generateProvider, listProviderModels} from './provider-adapter.mjs';
const config = {id: 'fixture', protocol: 'chatCompletions', baseUrl: 'https://example.test/v1', model: 'fixture-model', credentialRef: 'native-reference', contextWindow: 128000};
const request = {input: [{role: 'user', content: 'inspect'}], tools: [{type: 'namespace', name: 'gis', tools: [{type: 'custom', name: 'run', format: {type: 'text'}}]}]};
const bytes = async function* (text) { for (const byte of Buffer.from(text)) yield new Uint8Array([byte]); };
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
test('channel snapshot freezes routing, omits plaintext credentials and refuses URL secrets', () => {
  const input = {...config, apiKey: 'must-not-persist', inputModalities: ['text']}; const snapshot = channelSnapshot(input);
  input.model = 'changed'; input.inputModalities.push('image');
  assert.equal(snapshot.model, 'fixture-model'); assert.deepEqual(snapshot.inputModalities, ['text']);
  assert.ok(!JSON.stringify(snapshot).includes('must-not-persist')); assert.ok(Object.isFrozen(snapshot));
  for (const baseUrl of ['https://user:pass@example.test/v1', 'https://example.test/v1?key=secret', 'http://example.test/v1']) assert.throws(() => channelSnapshot({...config, baseUrl}));
});
test('chat adapter preserves namespaced custom tools across fragmented UTF-8 streams', async () => {
  const {contract, body} = providerRequest(channelSnapshot(config), request); const name = body.tools[0].function.name;
  const stream = ': comment\r\n' + event({choices: [{index: 0, delta: {reasoning_content: '检查真实文件。', tool_calls: [{index: 0, id: 'call_1', function: {name, arguments: '{"input":'}}]}}]})
    + event({choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: '"运行"}'}}]}, finish_reason: 'tool_calls'}]})
    + event({choices: [], usage: {prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: {cached_tokens: 0}}}) + 'data: [DONE]\r\n\r\n';
  const value = await collectChat(bytes(stream), contract);
  assert.equal(value.result.reasoning, '检查真实文件。'); assert.equal(value.result.toolCalls[0].namespace, 'gis');
  assert.equal(value.result.toolCalls[0].input, '运行'); assert.equal(value.inputTokens, 12); assert.equal(value.cachedInputTokens, 0);
});
test('missing provider usage stays unknown and incomplete/truncated tool streams fail', async () => {
  const {contract} = providerRequest(channelSnapshot(config), request);
  const value = await collectChat(bytes(event({choices: [{delta: {content: 'answer'}, finish_reason: 'stop'}]})), contract);
  assert.equal(value.inputTokens, null); assert.equal(value.cachedInputTokens, null);
  await assert.rejects(collectChat(bytes(event({choices: [{delta: {content: 'half'}}]})), contract), /INCOMPLETE/);
  await assert.rejects(collectChat(bytes(event({choices: [{delta: {}, finish_reason: 'length'}]})), contract), /TRUNCATED/);
});
test('responses transport preserves opaque reasoning and native custom tool data', async () => {
  const snapshot = channelSnapshot({...config, protocol: 'responses'}); const body = providerRequest(snapshot, {...request, input: [{type: 'reasoning', encrypted_content: 'opaque'}]}).body;
  assert.equal(body.input[0].encrypted_content, 'opaque'); assert.equal(body.tools[0].type, 'namespace');
  const response = {id: 'response_1', status: 'completed', output: [{type: 'reasoning', encrypted_content: 'preserve-this'}, {type: 'custom_tool_call', name: 'run', namespace: 'gis', call_id: 'x', input: 'opaque custom'}], usage: {input_tokens: 20, output_tokens: 3}};
  const events = [];
  const result = await collectResponses(bytes(event({type: 'response.completed', response})), (kind, value) => events.push(value));
  assert.deepEqual(result.result.response, response); assert.equal(events[0].response.output[0].encrypted_content, 'preserve-this');
  assert.equal(result.result.toolCalls[0].namespace, 'gis'); assert.equal(result.result.toolCalls[0].custom, true); assert.equal(result.result.toolCalls[0].input, 'opaque custom');
});
test('provider errors are sanitized, redirects are refused, cancellation aborts transport', async () => {
  const snapshot = channelSnapshot(config);
  await assert.rejects(generateProvider(snapshot, 'secret', request, {fetchImpl: async (_, options) => {assert.equal(options.redirect, 'error'); return new Response('{"error":"secret"}', {status: 401});}}), error => error.status === 401 && !error.message.includes('secret'));
  const controller = new AbortController(); const operation = generateProvider(snapshot, 'secret', request, {signal: controller.signal, fetchImpl: async (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))});
  controller.abort(); await assert.rejects(operation, /CANCELLED/);
});
test('models discovery uses actual catalogue IDs without inventing aliases', async () => {
  const result = await listProviderModels(channelSnapshot(config), 'secret', {fetchImpl: async () => Response.json({data: [{id: 'real-model'}, {name: 'not-an-id'}]})});
  assert.deepEqual(result, [{id: 'real-model'}]);
});
test('cached/reasoning usage reaches the Codex bridge, while incomplete Responses fail', async () => {
  const stream = event({choices: [{index: 0, delta: {content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 25, completion_tokens: 10, prompt_cache_hit_tokens: 20, completion_tokens_details: {reasoning_tokens: 6}}}) + 'data: [DONE]\n\n';
  const value = await generateProvider(channelSnapshot(config), 'secret', request, {fetchImpl: async () => new Response(stream, {headers: {'Content-Type': 'text/event-stream'}})});
  assert.equal(value.result.usage.cachedInputTokens, 20); assert.equal(value.result.usage.reasoningTokens, 6);
  await assert.rejects(collectResponses(bytes(event({type: 'response.created', response: {status: 'in_progress'}}))), /INCOMPLETE/);
});
