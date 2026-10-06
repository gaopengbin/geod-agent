// Observe the restored development desktop without starting user work or editing history.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve('artifacts/windows-independent-launch-20261006');
const output = join(root, 'development-restoration.json');
assert(!existsSync(output), 'Preserve prior restoration evidence');
const expected = JSON.parse(readFileSync('artifacts/retained-profile-backup-20261005/before.json', 'utf8')).application;
const migration = JSON.parse(readFileSync(join(root, 'profile-copy-aaf25f33f07f5f29.json'), 'utf8'));
assert(migration.passed && migration.profiles.every(p => p.copied && p.allFileHashesMatch && p.originalFileHashesUnchanged));
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const report = {passed: false, startedAt: new Date().toISOString(), ordinaryCandidateInstalled: false,
  historyEdited: false, userTasksStarted: false, modelCalls: 0, productionModified: false};
const {chromium} = await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://127.0.0.1:1420/');
  assert(page, 'The actual development WebView must be ready');
  await page.locator('.app-shell, .app').first().waitFor({timeout: 20000}).catch(() => {});
  const state = await page.evaluate(async () => {
    const {api} = await import('/src/api.ts');
    const {snapshotLocalRecords} = await import('/src/local-state.ts');
    const auth = await api.authStatus();
    const entries = (await snapshotLocalRecords()).entries;
    const rows = Object.fromEntries(entries);
    const key = `geod-agent-conversations-0.1:account:${auth.userId}`;
    if (!rows[key]) throw Error('Original authenticated history is missing');
    const sources = await api.sourcesList();
    const settings = await api.desktopSettings();
    const payment = await api.agentPaymentSnapshot();
    const connections = [...await window.__TAURI_INTERNALS__.invoke('data_connections_list'),
      ...(await window.__TAURI_INTERNALS__.invoke('sql_connections_list')).connections];
    return {owner: auth.userId, history: rows[key], active: rows[`geod-agent-active-conversation-0.1:account:${auth.userId}`],
      pending: Object.fromEntries(entries.filter(([name]) => name.includes('pending'))),
      language: rows['geod-agent-language-v1'], sources: sources.map(s => s.id).sort(),
      connectionIds: connections.map(c => c.id).sort(), nativeVersion: settings.version, development: settings.development,
      background: await api.backgroundStatus(), paymentStatus: payment.status,
      ui: {composerCount: document.querySelectorAll('textarea').length, dialogs: document.querySelectorAll('[role=dialog]').length}};
  });
  const application = {count: JSON.parse(state.history).length, sha256: hash(state.history), active: state.active,
    pending: Object.fromEntries(Object.entries(state.pending).map(([key, value]) => [key, hash(value)])), language: state.language};
  report.application = application;
  report.owner = state.owner;
  report.nativeVersion = state.nativeVersion;
  report.development = state.development;
  report.sources = state.sources;
  report.connectionIds = state.connectionIds;
  report.background = state.background;
  report.paymentStatus = state.paymentStatus;
  report.ui = state.ui;
  assert.deepEqual(application, expected, 'Original raw conversations, pending recovery, selection and language must match');
  assert.equal(state.owner, 'user-d60315b4-51dd-42a6-9aa9-97747648f922');
  assert.equal(state.nativeVersion, '0.2.0');
  assert(state.development);
  assert.equal(state.sources.length, 16);
  const originalConnections = JSON.parse(readFileSync('artifacts/release-candidate-integrated-20261004-actual/original-connections-restored.json', 'utf8'));
  assert.deepEqual(state.connectionIds, originalConnections.ids.slice().sort());
  assert(state.background.running && !state.background.maintenanceActive);
  assert.equal(state.background.activeAiTurns, 0);
  assert.equal(state.background.activeCommands, 0);
  assert.equal(state.background.activeDownloads, 0);
  assert.equal(state.paymentStatus.billingMode, 'unlimited-test');
  assert.equal(state.paymentStatus.checkoutEnabled, false);
  assert.equal(state.paymentStatus.welcomeCreditEnabled, false);
  assert.equal(state.paymentStatus.creditHistoryEnabled, false);
  assert.equal(state.paymentStatus.paymentHistoryEnabled, false);
  const inspected = spawnSync('python', ['-X', 'utf8', '-c',
    'from pathlib import Path; import sys,psutil,json; sys.path.insert(0,str(Path("scripts").resolve())); from windows_detached_process import process_in_job,process_package_identity; rows=[]\n' +
    'for pid,created in [(75684,1791268191.8117428),(96872,1791268194.512353),(86904,1791268122.5282643)]:\n p=psutil.Process(pid); assert p.create_time()==created; rows.append({"pid":pid,"created":p.create_time(),"exe":p.exe(),"outsideWindowsJobs":not process_in_job(pid),"packageIdentity":process_package_identity(pid)})\nprint(json.dumps(rows))'],
    {encoding: 'utf8', windowsHide: true});
  assert.equal(inspected.status, 0, 'Original native and gateway processes must still exist');
  report.processes = JSON.parse(inspected.stdout);
  assert(report.processes.every(p => p.outsideWindowsJobs && p.packageIdentity === null));
  assert.equal(state.background.pid, 96872);
  await page.screenshot({path: join(root, 'development-restored.png')});
  Object.assign(report, {passed: true, finishedAt: new Date().toISOString()});
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: true, conversations: application.count, sources: state.sources.length,
    connections: state.connectionIds.length, backgroundPid: state.background.pid, nativeVersion: state.nativeVersion}));
} catch (error) {
  writeFileSync(join(root, 'development-restoration-attempt.json'), JSON.stringify({...report, error: String(error)}, null, 2));
  throw error;
} finally {
  await browser.close();
}
