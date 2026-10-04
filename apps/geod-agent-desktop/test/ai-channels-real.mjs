// Experimental integration acceptance, not a claim that BYOK is enabled in UI.
// Uses the same real Codex app-server/host and independent test workspaces.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createHost} from '../src-tauri/codex-host.mjs';
import {channelSnapshot, generateProvider, listProviderModels} from '../../../packages/codex-protocol/provider-adapter.mjs';

const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const root = resolve(argument('--output') ?? 'artifacts/ai-channels-verification-20261003'); mkdirSync(root, {recursive: true});
const runtime = resolve('apps/geod-agent-desktop/src-tauri/resources/codex');
const codex = process.env.GEOD_CODEX_EXE ?? join(runtime, 'codex.exe');
// The controller alone owns these values. Codex and its command runner inherit
// an environment without model credentials; child controllers get explicit refs.
const credentialValues = new Map(['GEOD_QA_DEEPSEEK_KEY', 'GEOD_QA_LITELLM_KEY'].map(key => [key, process.env[key]]));
for (const key of ['GEOD_QA_DEEPSEEK_KEY', 'GEOD_QA_LITELLM_KEY', 'DEEPSEEK_API_KEY', 'LITELLM_MASTER_KEY']) delete process.env[key];
const secrets = ref => {
  const value = credentialValues.get(ref); if (!value) throw new Error(`Missing credential reference ${ref}`); return value;
};
const makeRoute = (id, model, protocol = 'chatCompletions') => channelSnapshot({id, name: id, model, protocol,
  baseUrl: protocol === 'responses' ? process.env.GEOD_QA_LITELLM_BASE ?? 'http://127.0.0.1:44124/v1' : 'https://api.deepseek.com/v1',
  credentialRef: protocol === 'responses' ? 'GEOD_QA_LITELLM_KEY' : 'GEOD_QA_DEEPSEEK_KEY', contextWindow: 128000,
  maxOutputTokens: 4096, inputModalities: ['text'], thinking: protocol === 'responses' ? null : 'enabled'});
const routes = [makeRoute('direct-flash', 'deepseek-flash'), makeRoute('direct-pro', 'deepseek-v4-pro'), makeRoute('litellm-responses', 'deepseek-flash', 'responses')];
const definitions = [
  {name: 'workspace_read_file', description: 'Read a UTF-8 file from this test workspace.', parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false}},
  {name: 'workspace_write_file', description: 'Write UTF-8 contents to a file inside this test workspace.', parameters: {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}, required: ['path', 'content'], additionalProperties: false}},
];
const hash = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scenario(route, label, {isolated = false, probeCancel = false, restore = false} = {}) {
  const work = join(root, `${route.id}-${label}`); const home = join(work, 'home'); mkdirSync(work, {recursive: true});
  const nonce = `nonce-${randomUUID()}`; writeFileSync(join(work, 'input.txt'), nonce);
  const toolsFile = join(work, 'tools.json'); writeFileSync(toolsFile, JSON.stringify(definitions.map(fn => ({type: 'function', function: fn}))));
  const evidence = {label, selectedChannel: route.id, selectedModel: route.model, protocol: route.protocol, isolated,
    modelCredentialsExcludedFromCodexEnvironment: !['GEOD_QA_DEEPSEEK_KEY', 'GEOD_QA_LITELLM_KEY', 'DEEPSEEK_API_KEY', 'LITELLM_MASTER_KEY'].some(key => process.env[key]), requests: [], tools: [], streamingDeltas: 0};
  let listener; let host; let cancelNext = false; let cancelled = false; const requests = new Set();
  function command(value) { return listener?.(value); }
  const emit = value => {
    if (value.type === 'event' && value.method === 'item/agentMessage/delta') evidence.streamingDeltas++;
    if (value.type === 'model') {
      if (evidence.requests.length >= 12) { void command({type: 'response', requestId: value.requestId, error: 'QA_REQUEST_LIMIT'}); return; }
      const requestStarted = Date.now();
      const item = {generationId: value.generationId, channelId: route.id, model: route.model,
        requestedToolTypes: [...new Set((value.request.tools ?? []).map(tool => tool.type))], inputItems: value.request.input?.length};
      evidence.requests.push(item); const controller = new AbortController(); requests.add(controller);
      if (cancelNext) setTimeout(() => {cancelled = true; void command({type: 'interrupt'}); controller.abort();}, 300);
      void generateProvider(route, secrets(route.credentialRef), value.request, {
        generationId: value.generationId, signal: controller.signal, timeoutMs: 120000,
        onDelta: (part, text) => {if (text) item.firstDeltaMs ??= Date.now() - requestStarted; void command({type: 'delta', requestId: value.requestId, part, text});},
        onWire: (event, wire) => {if (event.endsWith('.delta') && wire.delta) item.firstDeltaMs ??= Date.now() - requestStarted; void command({type: 'wire', requestId: value.requestId, event, value: wire});},
      }).then(generation => {
        Object.assign(item, {upstreamRequestId: generation.id, upstreamModel: generation.model, inputTokens: generation.inputTokens,
          outputTokens: generation.outputTokens, cachedInputTokens: generation.cachedInputTokens, reasoningTokens: generation.reasoningTokens,
          usageKnown: generation.usageKnown, state: generation.state, durationMs: Date.now() - requestStarted});
        if (!cancelled) void command({type: 'response', requestId: value.requestId, value: generation});
      }).catch(error => {
        item.error = error.code ?? error.message; item.httpStatus = error.status ?? null;
        if (!cancelled) void command({type: 'response', requestId: value.requestId, error: `${item.error}${item.httpStatus ? ` (${item.httpStatus})` : ''}`});
      }).finally(() => requests.delete(controller));
    } else if (value.type === 'tool') {
      let result;
      try {
        const path = resolve(work, value.arguments.path);
        if (!path.startsWith(work + sep) || path.startsWith(home + sep)) throw new Error('WORKSPACE_DENIED');
        if (value.tool === 'workspace_read_file') result = {text: readFileSync(path, 'utf8')};
        else if (value.tool === 'workspace_write_file') {writeFileSync(path, value.arguments.content, 'utf8'); result = {written: true, sha256: hash(readFileSync(path))};}
        else throw new Error('UNDECLARED_TOOL');
        evidence.tools.push({tool: value.tool, path: value.arguments.path, sha256: value.tool === 'workspace_write_file' ? result.sha256 : hash(result.text)});
      } catch (error) {result = {error: error.message};}
      void command({type: 'response', requestId: value.requestId, value: {result}});
    } else if (value.type === 'request') {
      void command({type: 'response', requestId: value.requestId, value: {decision: 'decline'}});
    }
  };
  const boot = () => createHost({codex, home, toolsFile, emit, receive: fn => {listener = fn; return () => {listener = null;};},
    capabilities: {model: route.model, contextWindow: route.contextWindow, providerName: route.name, protocol: route.protocol,
      inputModalities: route.inputModalities, isolatedWorker: isolated}});
  const params = {conversationId: `${route.id}-${label}`, workspace: work, permission: 'fullAccess', history: [],
    input: '这是接入验收。只使用 workspace_read_file 读取 input.txt，再使用 workspace_write_file 写 output.txt，内容为读到的完整原文，不附加文字或换行。禁止命令和 shell。最后用中文一句话说明完成。'};
  const started = Date.now();
  try {
    host = await boot(); const result = await host.turn(params);
    evidence.turn = {status: result.status, threadId: result.threadId, text: result.text}; evidence.toolCycleMs = Date.now() - started;
    assert.equal(result.status, 'completed'); assert.equal(readFileSync(join(work, 'output.txt'), 'utf8'), nonce);
    assert.ok(evidence.tools.some(tool => tool.tool === 'workspace_read_file')); assert.ok(evidence.tools.some(tool => tool.tool === 'workspace_write_file'));
    assert.ok(evidence.streamingDeltas > 0); assert.ok(evidence.requests.some(item => item.state === 'settled' && item.usageKnown));
    evidence.fileReadbackSha256 = hash(readFileSync(join(work, 'output.txt'))); evidence.fileVerified = true;
    if (restore) {
      await host.close(); host = await boot();
      const restored = await host.turn({...params, input: '不调用工具，回复上一轮从 input.txt 读取的完整 nonce 原文，不附加其他文字。'});
      assert.equal(restored.status, 'completed'); assert.equal(restored.threadId, result.threadId); assert.ok(restored.text.includes(nonce));
      evidence.reopen = {status: restored.status, sameThread: true, contextVerified: true};
    }
    if (probeCancel) {
      cancelNext = true; const stopped = await host.turn({...params, input: '请写一篇很长的地理信息技术文章。'});
      assert.equal(stopped.status, 'interrupted'); evidence.cancel = {status: stopped.status};
      cancelNext = false; cancelled = false;
      const recovery = await host.turn({...params, input: '现在只回复“取消后可以继续”。'});
      assert.equal(recovery.status, 'completed'); assert.ok(recovery.text.includes('取消后'));
      evidence.afterCancel = {status: recovery.status, text: recovery.text};
    }
    evidence.passed = true;
  } catch (error) {evidence.passed = false; evidence.error = error.code ?? error.message;}
  finally {for (const controller of requests) controller.abort(); await host?.close(); evidence.durationMs = Date.now() - started; writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));}
  return evidence;
}

if (argument('--worker')) {
  const snapshot = channelSnapshot(JSON.parse(readFileSync(argument('--snapshot'), 'utf8')));
  const result = await scenario(snapshot, argument('--worker'), {isolated: true});
  console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1;
} else {
  const results = []; const selection = argument('--route');
  for (const route of routes.filter(route => !selection || route.id === selection)) {
    let models;
    try {models = await listProviderModels(route, secrets(route.credentialRef)); assert.ok(models.some(model => model.id === route.model));}
    catch (error) {results.push({selectedChannel: route.id, case: 'catalogue', passed: false, error: error.code ?? error.message, httpStatus: error.status}); continue;}
    results.push({selectedChannel: route.id, case: 'catalogue', passed: true, modelIds: models.map(model => model.id)});
    results.push(await scenario(route, 'main', {restore: true, probeCancel: route.id !== 'direct-pro'}));
    if (route.id !== 'direct-pro' && results.at(-1).passed) {
      const snapshotFile = join(root, `${route.id}-scheduled-route.json`); writeFileSync(snapshotFile, JSON.stringify(route, null, 2));
      // Switch the foreground selection before child/later execution; the saved route must win.
      const foregroundSelection = routes[1];
      for (const kind of ['child', 'scheduled']) {
        if (kind === 'scheduled') await wait(1000);
        const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--worker', kind, '--snapshot', snapshotFile, '--output', root], {cwd: process.cwd(), env: {...process.env, ...Object.fromEntries(credentialValues)}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        let output = ''; child.stdout.on('data', bytes => output += bytes); let error = ''; child.stderr.on('data', bytes => error += bytes);
        const status = await new Promise(resolve => child.once('exit', resolve));
        let evidence; try {evidence = JSON.parse(output.trim());} catch {evidence = {passed: false, error: 'WORKER_RESULT_INVALID'};}
        results.push({...evidence, case: kind, foregroundSelection: foregroundSelection.model, frozenModelVerified: evidence.selectedModel === route.model && status === 0, independentProcess: true});
      }
    }
    if (route.protocol === 'chatCompletions' && route.id === 'direct-flash') {
      let failure; try {await generateProvider(route, 'sk-invalid-geod-qa', {input: [{role: 'user', content: 'connection test'}], tools: []});} catch (error) {failure = {code: error.code, status: error.status};}
      results.push({selectedChannel: route.id, case: 'invalid-credential', passed: failure?.code === 'PROVIDER_HTTP_ERROR' && [401, 403].includes(failure?.status), errorObserved: failure});
    }
    console.log(JSON.stringify({route: route.id, results: results.filter(item => item.selectedChannel === route.id).map(item => ({case: item.case ?? item.label, passed: item.passed, error: item.error, durationMs: item.durationMs}))}));
  }
  const file = join(root, `summary${selection ? `-${selection}` : ''}.json`);
  writeFileSync(file, JSON.stringify({at: new Date().toISOString(), scope: 'isolated integration candidate; native BYOK UI and native scheduler not wired', results}, null, 2));
  console.log(JSON.stringify({evidence: file, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length}));
  if (results.some(item => !item.passed)) process.exitCode = 1;
}
