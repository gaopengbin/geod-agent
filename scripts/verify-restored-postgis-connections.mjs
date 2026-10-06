// Read the four original local test connections through actual Rust IPC and pgEdge MCP.
// Do not create connections, import boundaries, edit chats, or access credentials in JS.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root = resolve('artifacts/windows-independent-launch-20261006');
const output = join(root, 'restored-postgis-connections.json');
assert(!existsSync(output), 'Keep prior acceptance evidence');
const expected = JSON.parse(readFileSync(join(root, 'development-restoration.json'), 'utf8'));
assert(expected.passed);
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const report = {passed: false, startedAt: new Date().toISOString(), modelCalls: 0,
  connectionConfigurationModified: false, credentialsEnteredOrReturned: false, databaseWrites: false,
  chatsEdited: false, installed: false, checks: []};
const format = '{"id":{{json .Id}},"image":{{json .Config.Image}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}},"ports":{{json .NetworkSettings.Ports}}}';
const inspected = spawnSync('docker', ['inspect', 'geod-agent-postgis-test', '--format', format],
  {encoding: 'utf8', windowsHide: true, timeout: 15000});
assert.equal(inspected.status, 0, 'The existing Docker test database must be available');
const container = JSON.parse(inspected.stdout);
assert.equal(container.image, 'postgis/postgis@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677');
assert.equal(container.status, 'running');
assert.equal(container.health, 'healthy');
assert.deepEqual(container.ports['5432/tcp'], [{HostIp: '127.0.0.1', HostPort: '55438'}]);
report.container = container;

const {chromium} = await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://127.0.0.1:1420/');
  assert(page, 'Keep the existing development desktop');
  async function snapshot() {
    const state = await page.evaluate(async () => {
      const {api} = await import('/src/api.ts');
      const {snapshotLocalRecords} = await import('/src/local-state.ts');
      const rows = Object.fromEntries((await snapshotLocalRecords()).entries);
      const auth = await api.authStatus();
      const key = `geod-agent-conversations-0.1:account:${auth.userId}`;
      return {owner: auth.userId, history: rows[key], active: rows[`geod-agent-active-conversation-0.1:account:${auth.userId}`],
        pending: Object.fromEntries(Object.entries(rows).filter(([key]) => key.includes('pending'))),
        language: rows['geod-agent-language-v1'], connections: await api.dataConnectionsList(),
        background: await api.backgroundStatus(), sourceCount: (await api.sourcesList()).length};
    });
    return {owner: state.owner, application: {count: JSON.parse(state.history).length, sha256: hash(state.history),
      active: state.active, pending: Object.fromEntries(Object.entries(state.pending).map(([key, value]) => [key, hash(value)])),
      language: state.language}, connections: state.connections, background: state.background, sourceCount: state.sourceCount};
  }
  const before = await snapshot();
  assert.equal(before.owner, expected.owner);
  assert.deepEqual(before.application, expected.application);
  assert.deepEqual(before.connections.map(c => c.id).sort(), expected.connectionIds);
  assert.equal(before.sourceCount, 16);
  assert.equal(before.background.pid, expected.background.pid);
  assert(before.background.running && before.background.activeAiTurns === 0 && before.background.activeCommands === 0 && before.background.activeDownloads === 0);
  report.before = {application: before.application, sourceCount: before.sourceCount, backgroundPid: before.background.pid};
  for (const connection of before.connections) {
    assert(connection.host === '127.0.0.1' && connection.port === 55438 && connection.database === 'geod_test');
    const result = await page.evaluate(async id => {
      const {api} = await import('/src/api.ts');
      try {
        const result = await api.dataLayerInspect(id, 'demo.boundaries_3857.geom', 1);
        if (result.error) return {errorCode: result.error.code};
        return {readOnly: result.readOnly, layer: result.selectedLayer, crs: result.sourceCrs,
          columns: result.columns, sampleRecords: result.sampleRecords, featureCount: result.featureCount, mcp: result.mcp};
      } catch (error) {return {errorCode: error?.code ?? 'NATIVE_READ_FAILED'};}
    }, connection.id);
    assert(!result.errorCode, `Stored connection read failed: ${result.errorCode}`);
    assert.equal(result.readOnly, true);
    assert.equal(result.layer, 'demo.boundaries_3857.geom');
    assert.equal(result.crs, 'EPSG:3857');
    assert.equal(result.sampleRecords.length, 1);
    assert(result.columns.some(column => column.spatial));
    assert.equal(result.mcp.transport, 'stdio');
    assert(result.mcp.toolCalls > 0);
    report.checks.push({connectionId: connection.id, readOnly: true, layer: result.layer, crs: result.crs,
      columns: result.columns.map(c => c.name), sampleRecords: result.sampleRecords.length,
      sampleSha256: hash(JSON.stringify(result.sampleRecords)), featureCount: result.featureCount, mcp: result.mcp});
    writeFileSync(output, JSON.stringify(report, null, 2));
  }
  assert.equal(new Set(report.checks.map(c => c.sampleSha256)).size, 1);
  const after = await snapshot();
  assert.deepEqual(after.application, before.application);
  assert.deepEqual(after.connections, before.connections);
  assert.equal(after.sourceCount, before.sourceCount);
  assert.equal(after.background.pid, before.background.pid);
  assert(after.background.running && after.background.activeAiTurns === 0 && after.background.activeCommands === 0 && after.background.activeDownloads === 0);
  report.after = {application: after.application, sourceCount: after.sourceCount, backgroundPid: after.background.pid};
  Object.assign(report, {passed: true, originalConnections: report.checks.length, finishedAt: new Date().toISOString()});
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: true, originalConnections: report.checks.length,
    conversations: after.application.count, actualNativeMcpReads: report.checks.length, modelCalls: 0}));
} catch (error) {
  Object.assign(report, {error: String(error), finishedAt: new Date().toISOString()});
  writeFileSync(output, JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}
