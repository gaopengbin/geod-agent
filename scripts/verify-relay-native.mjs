// Invoked only by the finite, project-scoped, pinned-tunnel preflight.
// No synthetic replies, protocol fallback, UI history edits or app restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] ?? '');
const preflight = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
const base = process.env.GEOD_QA_RELAY_BASE;
const key = process.env.GEOD_QA_RELAY_KEY;
delete process.env.GEOD_QA_RELAY_KEY;
assert(preflight.passed && !preflight.quotaIsUnlimited && preflight.actualKeyName.startsWith('geod-agent-'));
assert(preflight.expiresAt > Date.now() / 1000 && preflight.quotaRemaining <= preflight.quotaPerUsd);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? '') && key);
assert(root.startsWith(path.resolve('artifacts/relay-provider-acceptance-20261005') + path.sep));
assert(!fs.existsSync(path.join(root, 'native-result.json')), 'Never overwrite prior native results');

const models = [
  {id: 'claude-sonnet-5', protocol: 'anthropic'},
  {id: 'gpt-5.6-terra', protocol: 'responses'},
  {id: 'gemini-3.7-flash', protocol: 'chatCompletions'},
];
assert.deepEqual(models.map(m => m.id), preflight.models.map(m => m.model));
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const {chromium} = await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://127.0.0.1:1420/');
assert(page, 'The existing development desktop must be ready');
const report = {passed: false, startedAt: new Date().toISOString(), models: [],
  officialProvidersVerified: false, ordinaryCandidateInstalled: false,
  productionGatewayModified: false, appRestarted: false, shippingCandidateModified: false};
const fixtures = [], pageErrors = [];
page.on('pageerror', () => pageErrors.push('WEBVIEW_PAGE_ERROR'));
let original, stage = 'baseline';
const rpc = async (command, args = {}) => {
  const answer = await page.evaluate(async ({command, args}) => {
    try { return {value: await window.__TAURI_INTERNALS__.invoke(command, args)}; }
    catch (error) { return {errorCode: error?.code ?? 'NATIVE_RPC_REJECTED'}; }
  }, {command, args});
  if (answer.errorCode) throw Object.assign(new Error('Native operation failed'), {code: answer.errorCode});
  return answer.value;
};

async function state() {
  const data = await page.evaluate(async () => {
    const {api} = await import('/src/api.ts');
    const {snapshotLocalRecords} = await import('/src/local-state.ts');
    const auth = await api.authStatus(), entries = (await snapshotLocalRecords()).entries;
    const channels = await window.__TAURI_INTERNALS__.invoke('ai_channels_list');
    const desktop = await api.desktopSettings();
    const rows = Object.fromEntries(entries);
    const historyKey = `geod-agent-conversations-0.1:account:${auth.userId}`;
    if (!rows[historyKey]) throw Error('Original history unavailable');
    return {owner: auth.userId, history: rows[historyKey], nativeVersion: desktop.version,
      development: desktop.development,
      active: rows[`geod-agent-active-conversation-0.1:account:${auth.userId}`],
      pending: Object.fromEntries(entries.filter(([name]) => name.includes('pending'))),
      language: rows['geod-agent-language-v1'], defaultModel: channels.default,
      channelIds: channels.channels.map(channel => channel.id).sort(),
      background: await api.backgroundStatus()};
  });
  return {owner: data.owner, nativeVersion: data.nativeVersion, development: data.development,
    conversations: JSON.parse(data.history).length,
    conversationIds: JSON.parse(data.history).map(c => c.conversationId).sort(),
    historySha256: sha(data.history), active: data.active,
    pendingSha256: sha(data.pending), language: data.language,
    defaultModel: data.defaultModel, channelIds: data.channelIds,
    backgroundPid: data.background.pid, backgroundRunning: data.background.running,
    activeAiTurns: data.background.activeAiTurns, activeCommands: data.background.activeCommands,
    activeDownloads: data.background.activeDownloads};
}

async function turn(fixture, recall = false) {
  const runId = randomUUID();
  fixture.activeRunId = runId;
  const value = await page.evaluate(async ({id, runId, recall}) => {
    const {api} = await import('/src/api.ts');
    const {runCodexTurn} = await import('/src/codex-client.ts');
    const generations = [], tools = [];
    let modelRequests = 0, streamingDeltas = 0;
    const pendingTurn = runCodexTurn(runId, id,
      recall ? 'Do not call any tools. Return only the GeoJSON file name actually returned by the tool earlier in this conversation.'
        : 'Integration verification: call workspace_gis_files_list exactly once. Return only the GeoJSON file name actually returned by that tool. Do not run commands or use other tools.',
      [], {onModel: () => { if (++modelRequests > 3) throw Error('QA_REQUEST_LIMIT'); },
        onEvent: event => {
          if (event.type === 'event' && event.params?.item?.type === 'commandExecution')
            throw Error('QA_COMMAND_EXECUTION_FORBIDDEN');
          if (event.type === 'event' && event.method.includes('delta')) streamingDeltas++;
        },
        onGeneration: generation => generations.push(Object.fromEntries(
          ['generationId', 'state', 'model', 'selectedModel', 'channelId', 'channelRevision', 'billingScope',
            'inputTokens', 'outputTokens', 'usageKnown'].map(name => [name, generation[name]]))),
        onRequest: async () => ({decision: 'decline'}),
        execute: async call => {
          if (recall || call.function.name !== 'workspace_gis_files_list' || tools.length)
            throw Error('QA_EXACT_TOOL_ONLY');
          const files = await api.workspaceGisFilesList(id);
          tools.push({name: call.function.name, files});
          return {result: {files}};
        },
      });
    let timer;
    let result;
    try {
      result = await Promise.race([pendingTurn, new Promise((_, reject) => {
        timer = setTimeout(() => {
          void api.codexCommand(runId, {type: 'interrupt'}).catch(() => {});
          reject(Error('QA_TURN_TIME_LIMIT'));
        }, 240000);
      })]);
    } finally { clearTimeout(timer); }
    return {runId, result, tools, generations, streamingDeltas,
      receipt: await window.__TAURI_INTERNALS__.invoke('billing_run_snapshot', {runId})};
  }, {id: fixture.id, runId, recall});
  assert.equal(value.result.status, 'completed');
  assert(value.result.text.includes(fixture.file), 'Require the unprompted random file name');
  assert(value.streamingDeltas > 0);
  assert(value.generations.length >= (recall ? 1 : 2));
  assert(value.generations.every(g => g.state === 'settled' && g.billingScope === 'personal'
    && g.channelId === fixture.channelId && g.selectedModel === fixture.model.id
    && g.inputTokens > 0 && g.outputTokens > 0 && g.usageKnown));
  if (recall) {
    assert.equal(value.tools.length, 0);
    assert.equal(value.result.threadId, fixture.threadId);
  } else {
    assert.equal(value.tools.length, 1);
    assert(value.tools[0].files.some(name => name.includes(fixture.file)));
  }
  // Only our random fixture marker and metadata leave WebView memory.
  const receipt = {runId, threadId: value.result.threadId, actualFileName: fixture.file,
    answerContainsActualFileName: true, answerSha256: sha(value.result.text),
    toolCalls: value.tools.length, streamingDeltas: value.streamingDeltas,
    generations: value.generations, runState: value.receipt.status,
    usageResolved: value.receipt.usageResolved};
  write(`${fixture.model.protocol}-${recall ? 'recall' : 'tool-loop'}.json`, receipt);
  assert(value.receipt.usageResolved, 'Require actual settled native billing readback');
  delete fixture.activeRunId;
  return receipt;
}

try {
  original = await state(); write('native-before.json', original);
  write('native-ownership.json', {owner: original.owner, startedAt: report.startedAt, fixtures: []});
  assert(original.backgroundRunning && !original.activeAiTurns && !original.activeCommands && !original.activeDownloads);
  assert.equal(await page.locator('.conversation-running-dot').count(), 0);
  assert.equal(await page.getByRole('button', {name: /停止回复|Stop reply/}).count(), 0);
  for (const model of models) {
    stage = `${model.protocol}:configure`;
    const id = randomUUID(), directory = path.join(root, `workspace-${id}`);
    assert(!original.conversationIds.includes(id));
    fs.mkdirSync(directory);
    const file = `relay-${randomUUID()}.geojson`;
    fs.writeFileSync(path.join(directory, file), JSON.stringify({type: 'FeatureCollection', features: [
      {type: 'Feature', properties: {purpose: 'public random QA fixture'}, geometry:
        {type: 'Polygon', coordinates: [[[116, 39], [116.01, 39], [116.01, 39.01], [116, 39.01], [116, 39]]]}}
    ]}));
    const fixture = {id, directory, file, model}; fixtures.push(fixture);
    const channel = await rpc('ai_channel_save', {draft: {name: `GeoD relay QA ${model.protocol}`,
      baseUrl: `${base}/v1`, protocol: model.protocol, apiKey: key, enabled: true,
      models: [{id: model.id, name: model.id, contextWindow: 128000, maxOutputTokens: 2048,
        inputModalities: ['text']}]}});
    fixture.channelId = channel.id;
    write('native-ownership.json', {owner: original.owner, startedAt: report.startedAt,
      fixtures: fixtures.map(f => ({id: f.id, directory: f.directory, channelId: f.channelId}))});
    await rpc('workspace_set', {conversationId: id, directory, permission: 'confirmEach'});
    await rpc('ai_model_select', {conversationId: id, channelId: channel.id, modelId: model.id});
    stage = `${model.protocol}:tool-loop`;
    const first = await turn(fixture); fixture.threadId = first.threadId;
    stage = `${model.protocol}:recall`;
    const recall = await turn(fixture, true);
    report.models.push({model: model.id, protocol: model.protocol, toolLoop: first, recall, passed: true});
    write('native-progress.json', report);
    console.log(JSON.stringify({phase: stage, passed: true, model: model.id}));
  }
} catch (error) {
  report.error = {stage, code: error?.code ?? 'QA_NATIVE_ASSERTION'};
} finally {
  const cleanup = {passed: false, deletedChannelIds: [], errors: []};
  for (const fixture of fixtures) if (fixture.activeRunId) {
    try { await rpc('codex_command', {runId: fixture.activeRunId, command: {type: 'interrupt'}}); }
    catch (error) { if (error.code !== 'CODEX_RUN_NOT_FOUND') cleanup.errors.push('OWNED_INTERRUPT_FAILED'); }
  }
  if (original) {
    try {
      const stopped = spawnSync('python', ['-X', 'utf8', 'scripts/finish-relay-owned-processes.py',
        path.join(root, 'native-ownership.json')], {encoding: 'utf8', windowsHide: true});
      assert.equal(stopped.status, 0, 'Owned engine cleanup must succeed');
      cleanup.processes = JSON.parse(stopped.stdout);
    } catch { cleanup.errors.push('OWNED_ENGINE_CLEANUP_FAILED'); }
  }
  for (const fixture of fixtures) if (fixture.channelId) {
    try { await rpc('ai_channel_remove', {channelId: fixture.channelId}); cleanup.deletedChannelIds.push(fixture.channelId); }
    catch { cleanup.errors.push('OWNED_CHANNEL_REMOVAL_FAILED'); }
  }
  if (original) {
    try {
      const after = await state(); write('native-after.json', after);
      for (const name of ['owner', 'nativeVersion', 'development', 'conversations', 'conversationIds', 'historySha256', 'active', 'pendingSha256', 'language',
        'defaultModel', 'channelIds', 'backgroundPid', 'backgroundRunning']) assert.deepEqual(after[name], original[name]);
      assert.deepEqual(pageErrors, []);
      cleanup.originalStatePreserved = true;
    } catch { cleanup.errors.push('ORIGINAL_STATE_CHANGED'); }
  }
  cleanup.passed = !!original && cleanup.errors.length === 0 && cleanup.processes?.passed;
  report.cleanup = cleanup;
  report.pageErrors = pageErrors;
  report.passed = report.models.length === models.length && !report.error && cleanup.passed;
  report.finishedAt = new Date().toISOString();
  write('native-result.json', report);
  await browser.close();
}
console.log(JSON.stringify({passed: report.passed, modelCases: report.models.length,
  cleanupPassed: report.cleanup.passed, error: report.error ?? null}));
if (!report.passed) process.exitCode = 1;
