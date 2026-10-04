// Real mounted viewers, production MCP, UI controls and two actual AI turns.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:1420'));
const conversationId = 'ion-buildings-4d47a261-2cd6-41e1-ae3d-473831f572bd';
const output = resolve('../../docs/implementation/evidence/cesium-view-switch-2026-10-03');
mkdirSync(output, { recursive: true });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const call = (name, args = {}) => page.evaluate(async ({ conversationId, name, args }) => {
  const source = await (await fetch('/src/agent-panel.tsx')).text();
  const specifier = source.match(/from "([^\"]*\/src\/api.ts[^\"]*)"/)[1];
  const { api } = await import(specifier);
  return api.mcpCall('builtin-cesium-mcp', name, args, 'view-switch-' + crypto.randomUUID(), conversationId);
}, { conversationId, name, args });
const load = taskId => page.evaluate(async ({ taskId, conversationId }) => {
  const { executeDataDownloadTool } = await import('/src/data-download-tools.ts');
  return executeDataDownloadTool(conversationId, 'data_download_load', { taskId }, 'view-load-' + crypto.randomUUID());
}, { taskId, conversationId });
const view = () => call('getViewMode');
const waitMode = async mode => {
  await page.waitForFunction(mode => mode === '2d'
    ? !document.querySelector('.data-preview-overlay') || document.querySelector('.data-preview-overlay').hidden
    : document.querySelector('.data-preview-overlay') && !document.querySelector('.data-preview-overlay').hidden, mode);
  assert.equal((await view()).data.mode, mode);
};
try {
  assert(page); assert(!await page.getByRole('button', { name: '停止回复', exact: true }).isVisible());
  await page.reload(); await page.getByRole('textbox', { name: '发送给 GeoD Agent', exact: true }).waitFor(); await page.waitForTimeout(400);
  const initial = await view(); assert.equal(initial.data.mode, '2d'); assert.equal(initial.data.has3DScene, false);
  assert.equal((await call('setViewMode', { mode: '3d' })).error, 'NO_3D_SCENE');
  const task = await page.evaluate(async conversationId => {
    const { dataDownloads } = await import('/src/data-downloads.ts');
    return (await dataDownloads.list(conversationId)).filter(t => t.kind === 'tiles3d' && t.status === 'completed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }, conversationId); assert(task);
  assert.equal((await load(task.id)).loaded, true);
  assert.equal((await view()).data.mode, '3d');
  const before = (await call('getSceneState')).data;
  const switched = await call('setViewMode', { mode: '2d' }); assert.equal(switched.data.mode, '2d'); assert.equal(switched.data.has3DScene, true);
  await waitMode('2d'); await page.waitForTimeout(100);
  assert(!await page.locator('.data-preview-overlay').isVisible());
  assert(await page.getByRole('button', { name: '切换到三维', exact: true }).isVisible());
  const hidden = (await call('getSceneState')).data;
  assert.equal(hidden.opened, true); assert.equal(hidden.visible, false); assert.equal(hidden.rendering, false);
  assert.deepEqual(hidden.camera, before.camera); assert.deepEqual(hidden.layers, before.layers);
  await page.screenshot({ path: resolve(output, 'native-2d.png') });
  await page.getByRole('button', { name: '切换到三维', exact: true }).click(); await waitMode('3d'); await page.waitForTimeout(100);
  assert.equal((await call('getSceneState')).data.rendering, true);
  assert.deepEqual((await call('getSceneState')).data.camera, before.camera);
  await page.getByRole('button', { name: '切换到二维', exact: true }).click(); await waitMode('2d');
  assert.equal((await call('setViewMode', { mode: '3d' })).data.mode, '3d');
  const isolated = await page.evaluate(async () => { const { api } = await import('/src/api.ts'); return api.mcpCall('builtin-cesium-mcp', 'closeScene', {}, null, 'other-conversation'); });
  assert.equal(isolated.error, 'VIEW_NOT_AVAILABLE'); assert.equal((await view()).data.mode, '3d');
  const rapid = await page.evaluate(async conversationId => {
    const { api } = await import('/src/api.ts');
    return Promise.all(['2d', '3d'].map(mode => api.mcpCall('builtin-cesium-mcp', 'setViewMode', { mode }, null, conversationId)));
  }, conversationId);
  assert(rapid[1].success); await waitMode('3d');
  assert.equal((await call('closeScene')).data.has3DScene, false); await waitMode('2d');
  assert.equal((await call('getSceneState')).data.opened, false);
  assert.equal((await call('setViewMode', { mode: '3d' })).error, 'NO_3D_SCENE');
  assert.equal((await load(task.id)).loaded, true);
  const native = { before, hidden, initial, rapid, taskId: task.id, errors };
  writeFileSync(resolve(output, 'native.json'), JSON.stringify({ pass: true, ...native }, null, 2));
  if (process.argv.includes('--native-only')) { console.log(JSON.stringify({ pass: true, checks: ['2D/3D MCP', 'visible DOM', 'render loop paused', 'camera/layers retained', 'UI buttons', 'concurrent switching', 'close/reopen', 'conversation isolation'] })); }
  else {
    await page.evaluate(async () => {
      const source = await (await fetch('/src/agent-panel.tsx')).text();
      const specifier = source.match(/from "([^\"]*\/src\/api.ts[^\"]*)"/)[1]; const { api } = await import(specifier);
      window.__viewModelAudit = { api, turn: api.codexTurn, call: api.mcpCall, calls: [], results: [], events: [] };
      api.codexTurn = async (...args) => {
        const audit = window.__viewModelAudit, onEvent = args[4];
        args[4] = event => { audit.events.push(event); onEvent(event); };
        const result = await audit.turn(...args); audit.results.push(result); return result;
      };
      api.mcpCall = async (...args) => { const a = window.__viewModelAudit; const result = await a.call(...args); a.calls.push({ connectorId: args[0], name: args[1], args: args[2], result }); return result; };
    });
    const modelBefore = (await call('getSceneState')).data;
    const turns = [];
    for (const [input, mode] of [['切换到二维', '2d'], ['切回三维', '3d']]) {
      const counts = await page.evaluate(() => ({ results: window.__viewModelAudit.results.length, calls: window.__viewModelAudit.calls.length }));
      await page.getByRole('textbox', { name: '发送给 GeoD Agent', exact: true }).fill(input);
      await page.evaluate(() => document.querySelector('textarea').closest('form').requestSubmit());
      let audit;
      for (let attempt = 0; attempt < 90; attempt++) {
        audit = await page.evaluate(counts => { const a = window.__viewModelAudit; return { results: a.results.slice(counts.results), calls: a.calls.slice(counts.calls) }; }, counts);
        if (audit.results.length) break;
        await page.waitForTimeout(2000);
      }
      assert(audit.results.length, 'Actual model turn timed out');
      assert.equal(audit.results[0].status, 'completed');
      assert(audit.calls.some(c => c.connectorId === 'builtin-cesium-mcp' && c.name === 'setViewMode' && c.args.mode === mode && c.result.success), JSON.stringify(audit));
      await waitMode(mode); await page.waitForTimeout(150);
      const scene = (await call('getSceneState')).data;
      assert.equal(scene.opened, true); assert.equal(scene.visible, mode === '3d');
      assert.deepEqual(scene.camera, modelBefore.camera); assert.deepEqual(scene.layers, modelBefore.layers);
      await page.screenshot({ path: resolve(output, `model-${mode}.png`) });
      turns.push({ input, mode, ...audit, actualMode: await view() });
      console.log(JSON.stringify({ mode, answer: audit.results[0].text, tools: audit.calls.map(c => c.name) }));
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
    writeFileSync(resolve(output, 'real-model.json'), JSON.stringify({ pass: true, native, turns, checkedAt: new Date().toISOString() }, null, 2));
  }
} catch (error) { await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {}); console.error(error); process.exitCode = 1; }
finally {
  await page.evaluate(() => { const a = window.__viewModelAudit; if (a) { a.api.codexTurn = a.turn; a.api.mcpCall = a.call; } }).catch(() => {});
  await browser.close();
}
