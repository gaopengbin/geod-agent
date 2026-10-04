/** Actual native job ledger, public reference data, production viewer and AI. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [modulePath, output] = process.argv.slice(2), { chromium } = await import(modulePath);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const report = { pass: false, cases: [] }, errors = [];
page.on('pageerror', error => errors.push(error.message));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (run, label, timeout = 90000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await run(); if (value) return value; await sleep(250); } throw new Error(`Timeout: ${label}`); };
const rpc = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const chats = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([, value]) => JSON.parse(value)));
const send = async value => { await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).fill(value); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
const passed = async (name, value) => { report.cases.push({ name, pass: true, value }); await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(name, 'PASS'); };
let conversationId;
try {
  await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).count(), 0);
  const previous = new Set((await chats()).map(chat => chat.conversationId));
  await page.locator('.sidebar-new-chat').click();
  conversationId = await wait(async () => (await chats()).find(chat => !previous.has(chat.conversationId))?.conversationId, 'New actual QA conversation');
  const workspace = await rpc('workspace_get', { conversationId });
  await rpc('workspace_set', { conversationId, directory: workspace.directory, permission: 'fullAccess' });
  await page.reload(); await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  await send('这是旧版三维格式的本地验收会话，稍后加载真实官方样例。现在只简短回复可以开始。');
  await wait(async () => { const chat = (await chats()).find(v => v.conversationId === conversationId); return chat && !chat.pendingId && chat.messages?.at(-1)?.role === 'assistant' && !(await page.getByRole('button', { name: '停止回复', exact: true }).count()); }, 'Actual initial AI turn', 150000);
  for (const number of [1, 2]) {
    const tilesetUrl = `https://raw.githubusercontent.com/CesiumGS/cesium/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/Specs/Data/Cesium3DTiles/Batched/BatchedDeprecated${number}/tileset.json`;
    let task = await rpc('data_download_plan', { conversationId, title: `Cesium 官方旧版 b3dm ${number}`, idempotencyKey: crypto.randomUUID(), request: { kind: 'tiles3d', spec: { tilesetUrl } } });
    await rpc('data_download_start_auto', { conversationId, taskId: task.id, planHash: task.planHash });
    task = await wait(async () => { const value = await rpc('data_download_get', { conversationId, taskId: task.id }); if (value.status === 'failed') throw new Error(JSON.stringify(value.error)); return value.status === 'completed' ? value : null; }, 'Actual native legacy download');
    assert.equal(task.manifest.resources.length, 2);
    for (const asset of task.manifest.resources) {
      const bytes = await fs.readFile(path.join(task.outputDir, asset.path));
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
      if (asset.path.endsWith('.b3dm')) {
        assert.equal(bytes.readUInt32LE(8), bytes.length);
        assert.equal(JSON.parse(bytes.subarray(28, 28 + bytes.readUInt32LE(12))).BATCH_LENGTH, 10);
      }
    }
    const inspected = await rpc('data_download_inspect', { conversationId, taskId: task.id });
    const loaded = await page.evaluate(({ conversationId, task }) => import('/src/data-downloads.ts').then(module => module.previewDataTask(conversationId, task)), { conversationId, task });
    assert.equal(loaded.loaded, true, JSON.stringify(loaded));
    await page.locator('.tiles3d-preview__canvas').screenshot({ path: path.join(output, `native-legacy-${number}.png`) });
    await passed(`Actual native public b3dm ${number} download, strict inspection and production rendering`, { taskId: task.id, sourceUrl: tilesetUrl, outputDir: task.outputDir, manifest: task.manifest, inspected, loaded });
  }
  await send('通过 Cesium MCP 只查询一次当前三维场景状态。告诉我已下载模型是否实际加载，以及地形类型，用一两句话回答。不要调整场景。');
  const chat = await wait(async () => { const value = (await chats()).find(v => v.conversationId === conversationId); return value && !value.pendingId && value.messages?.at(-1)?.role === 'assistant' && value.display.filter(v => v.role === 'user').length >= 2 && !(await page.getByRole('button', { name: '停止回复', exact: true }).count()) ? value : null; }, 'Actual AI scene readback', 150000);
  const lastUser = chat.display.findLastIndex(v => v.role === 'user');
  assert(JSON.stringify(chat.display.slice(lastUser + 1).filter(v => v.role === 'tool')).includes('getSceneState'));
  await fs.writeFile(path.join(output, 'actual-ai-conversation.json'), JSON.stringify(chat, null, 2));
  await passed('Actual Codex and hosted AI read the loaded legacy scene', { conversationId, answer: chat.messages.at(-1).content });
  assert.equal(errors.length, 0, JSON.stringify(errors)); report.pass = true;
} catch (error) { report.failure = error.stack ?? error; console.error(report.failure); process.exitCode = 1; }
finally { report.pageErrors = errors; report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2)); await browser.close(); }
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));
