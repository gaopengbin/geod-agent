/** Actual native pgEdge + Docker certificate authentication + the real input form. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [playwrightModule, evidencePath, credentialFile] = process.argv.slice(2);
const { chromium } = await import(playwrightModule);
const draft = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
const fixture = path.dirname(credentialFile);
const report = { pass: false, cases: [] }, created = [];
await fs.mkdir(evidencePath, { recursive: true });
let browser, page, root;
async function connect() {
  for (let i = 0; i < 150; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9233'); break; }
    catch (error) { if (i === 149) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  for (let i = 0; i < 150; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
    if (page) break; await new Promise(r => setTimeout(r, 100));
  }
  if (!page) throw new Error('Actual desktop not ready');
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
async function rpc(command, args = {}) {
  const result = await page.evaluate(async ({ command, args }) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(command, args) }; }
    catch (error) { return { error }; }
  }, { command, args });
  if (result.error) throw result.error; return result.value;
}
function record(name, result) {
  if (JSON.stringify(result).includes(draft.sslClientKey) || JSON.stringify(result).includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Private key appeared in result');
  report.cases.push({ name, pass: true, result }); console.log(name, 'PASS');
}
async function noTemporaryKeys() {
  const entries = await fs.readdir(path.join(root, 'certificates'));
  if (entries.some(v => v.startsWith('.tls-session-'))) throw new Error('Temporary private key directory remains');
}
async function reject(name, changes, expected) {
  let value;
  try { value = await rpc('data_connection_save', { draft: { ...draft, ...changes } }); }
  catch (error) { value = { error }; }
  if (!expected.includes(value.error?.code)) {
    if (value.connection) { created.push(value.connection.id); }
    throw new Error(`${name}: expected rejection, received ${value.error?.code ?? 'connection accepted'}`);
  }
  await noTemporaryKeys(); record(name, value.error);
}
const conversationId = `mtls-native-${crypto.randomUUID()}`;
try {
  await connect();
  const status = await rpc('auth_status');
  if (!status.userId) throw new Error('Native account missing');
  root = path.join(process.env.APPDATA, 'dev.geod-agent.desktop', 'data-inputs', crypto.createHash('sha256').update(status.userId).digest('hex'));
  await rpc('workspace_set', { conversationId, directory: evidencePath, permission: 'fullAccess' });
  const initial = await rpc('data_connection_save', { draft });
  if (initial.error || initial.connection?.clientCertificate !== true) throw new Error(`mTLS connection failed: ${initial.error?.code}`);
  const id = initial.connection.id; created.push(id);
  if (!initial.layers.some(v => v.name === 'public.regions.geom') || initial.mcp?.version !== '1.1.0') throw new Error('Actual MCP discovery missing');
  record('4096-bit client key, mandatory certificate authentication and actual MCP discovery', { connection: { id, clientCertificate: initial.connection.clientCertificate }, layers: initial.layers, mcp: initial.mcp });
  const encryptedPath = path.join(root, 'certificates', `${id}.client-tls`);
  const sealed = await fs.readFile(encryptedPath);
  const publicRegistry = await fs.readFile(path.join(root, 'connections.json'), 'utf8');
  if (sealed.includes(Buffer.from(draft.sslClientKey)) || sealed.includes(Buffer.from('PRIVATE KEY')) || publicRegistry.includes('PRIVATE KEY') || publicRegistry.includes('sslClientKey')) throw new Error('Unencrypted TLS material persisted');
  await noTemporaryKeys(); record('DPAPI protected storage and no private material in connection metadata', { encryptedBytes: sealed.length, clientKeyLargerThan2560Bytes: Buffer.byteLength(draft.sslClientKey) > 2560, temporaryKeysRemoved: true });
  const selection = { filters: [{ field: 'name', op: 'eq', value: 'certificate-east' }], maxFeatures: 1 };
  const inspected = await rpc('data_layer_inspect', { connectionId: id, layer: 'public.regions.geom', selection });
  if (inspected.error || inspected.featureCount !== 1 || inspected.sampleRecords[0]?.score !== 41) throw new Error(`mTLS read failed: ${inspected.error?.code}`);
  record('Certificate connection reads actual attributes with a typed filter', inspected);
  const boundary = await rpc('data_input_read', { conversationId, request: { connectionId: id, layer: 'public.regions.geom', ...selection } });
  if (boundary.error || boundary.boundary?.polygonCount !== 1) throw new Error(`mTLS boundary failed: ${boundary.error?.code}`);
  record('Actual certificate-authenticated polygon becomes a WGS84 range', { boundary: boundary.boundary, mcp: boundary.mcp });
  await reject('Server refuses a missing client certificate; no password fallback', { sslClientCert: undefined, sslClientKey: undefined }, ['INPUT_TLS_FAILED']);
  await reject('Half-configured client identity is rejected', { sslClientKey: undefined }, ['INPUT_TLS_INVALID']);
  await reject('TLS cannot be disabled for a client identity', { sslMode: 'disable' }, ['INPUT_TLS_INVALID']);
  await reject('Certificate/key mismatch is rejected', { sslClientKey: await fs.readFile(path.join(fixture, 'wrong-user.key'), 'utf8') }, ['INPUT_TLS_INVALID', 'INPUT_TLS_FAILED']);
  await reject('Actual server rejects a certificate for another database role', { sslClientCert: await fs.readFile(path.join(fixture, 'wrong-user.pem'), 'utf8'), sslClientKey: await fs.readFile(path.join(fixture, 'wrong-user.key'), 'utf8') }, ['INPUT_TLS_FAILED']);
  await reject('Actual server rejects an expired client certificate', { sslClientCert: await fs.readFile(path.join(fixture, 'expired.pem'), 'utf8'), sslClientKey: await fs.readFile(path.join(fixture, 'expired.key'), 'utf8') }, ['INPUT_TLS_FAILED']);
  await reject('verify-full rejects a mismatched server name', { host: '127.0.0.1' }, ['INPUT_TLS_FAILED']);
  await reject('verify-full rejects an unknown server CA', { sslRootCert: undefined }, ['INPUT_TLS_FAILED']);
  const verifyCa = await rpc('data_connection_save', { draft: { ...draft, host: '127.0.0.1', sslMode: 'verify-ca' } });
  if (verifyCa.error) throw new Error(`verify-ca failed: ${verifyCa.error.code}`);
  created.push(verifyCa.connection.id); record('verify-ca checks the CA while accepting the selected host', { mcp: verifyCa.mcp, clientCertificate: verifyCa.connection.clientCertificate });
  const timeout = await rpc('data_layer_inspect', { connectionId: id, layer: 'public.delayed_regions', limit: 1 });
  if (timeout.error?.code !== 'INPUT_TIMEOUT') throw new Error(`Actual slow query expected timeout, received ${timeout.error?.code}`);
  await noTemporaryKeys(); record('Actual slow query timeout reaps its TLS session and private files', timeout.error);

  await page.goto('http://127.0.0.1:1420/test/data-input-harness.html?theme=dark&id=mtls-real-form');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '数据库', exact: true }).click();
  await dialog.getByRole('button', { name: '添加 PostgreSQL / PostGIS', exact: true }).click();
  const uiName = `本机证书表单验收 ${crypto.randomBytes(4).toString('hex')}`;
  for (const [name, value] of [['连接名称', uiName], ['主机', 'localhost'], ['端口', '55440'], ['数据库', draft.database], ['用户名', draft.user]]) await dialog.getByLabel(name, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: '验证证书及主机', exact: true }).click();
  await dialog.locator('.data-input-ca textarea').fill(draft.sslRootCert);
  await dialog.getByRole('button', { name: '客户端证书 · 双向 TLS', exact: true }).click();
  const files = dialog.locator('.data-input-client-tls input[type=file]');
  await files.nth(0).setInputFiles(path.join(fixture, 'client.pem'));
  await files.nth(1).setInputFiles(path.join(fixture, 'client.key'));
  await dialog.getByRole('button', { name: 'client.key', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidencePath, 'actual-certificate-form-dark.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({ path: path.join(evidencePath, 'actual-certificate-form-light.png'), fullPage: true });
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).click();
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
  const ui = (await rpc('data_connections_list')).find(v => v.name === uiName);
  if (!ui?.clientCertificate) throw new Error('Actual certificate input form did not save a tested connection');
  created.push(ui.id); record('Real input form selects PEM files, tests and saves the native mTLS connection', { connectionId: ui.id, darkAndLightScreenshots: true });
  await page.goto('http://127.0.0.1:1420'); await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  try { await rpc('plugin:window|close'); } catch (error) { if (!String(error).includes('closed')) throw error; }
  await browser.close(); browser = null;
  execFileSync('python', ['-X', 'utf8', 'scripts/start-codex-dev.py', '--local-gateway'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  await connect();
  const reopened = await rpc('data_layer_inspect', { connectionId: id, layer: 'public.regions.geom', selection });
  if (reopened.error || reopened.sampleRecords[0]?.score !== 41) throw new Error(`Saved mTLS connection did not survive GUI restart: ${reopened.error?.code}`);
  await noTemporaryKeys(); record('Reopened desktop decrypts its own saved identity and reads real data', { featureCount: reopened.featureCount, mcp: reopened.mcp });
  report.pass = true;
} catch (error) {
  report.failure = error?.message ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1;
} finally {
  if (page && browser) {
    for (const id of created) await rpc('data_connection_remove', { connectionId: id }).catch(() => {});
    if (root) {
      const remaining = await fs.readdir(path.join(root, 'certificates')).catch(() => []);
      if (remaining.some(v => created.some(id => v === `${id}.client-tls` || v === `${id}.pem`) || v.startsWith('.tls-session-'))) {
        report.pass = false; report.cleanupFailure = 'Owned test certificate files remain'; process.exitCode = 1;
      }
    }
    if (page.url().includes('/test/')) await page.goto('http://127.0.0.1:1420').catch(() => {});
  }
  await fs.writeFile(path.join(evidencePath, 'acceptance.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
}
