// Sends an actual user turn through the production composer and hosted Codex runtime.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:1420'));
const output = resolve('../../docs/implementation/evidence/cesium-mcp-2026-10-03');
mkdirSync(output, { recursive: true });
const input = '三维场景验收：请在当前名古屋的三维建筑场景中加载 OSM 地面底图，把镜头调整为从南侧斜看建筑，俯角约 45 度；不要操作二维地图，不要重新下载。完成后读取实际的三维相机和底图加载状态，简短告诉我结果。';
try {
  assert(page); assert(!await page.getByRole('button', { name: '停止回复', exact: true }).isVisible());
  if (await page.getByRole('button', { name: '检查状态', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '检查状态', exact: true }).click();
    await page.getByRole('button', { name: '检查状态', exact: true }).waitFor({ state: 'hidden' });
  }
  await page.evaluate(async () => {
    const source = await (await fetch('/src/agent-panel.tsx')).text();
    const specifier = source.match(/from "([^\"]*\/src\/api.ts[^\"]*)"/)[1];
    const { api } = await import(specifier);
    window.__cesiumModelAudit = { events: [], calls: [], results: [], originalTurn: api.codexTurn, originalCall: api.mcpCall, api };
    api.codexTurn = async (...args) => {
      const audit = window.__cesiumModelAudit, onEvent = args[4];
      audit.conversationId = args[1];
      args[4] = event => { audit.events.push(event); onEvent(event); };
      const result = await audit.originalTurn(...args); audit.results.push(result); return result;
    };
    api.mcpCall = async (...args) => {
      const audit = window.__cesiumModelAudit;
      const result = await audit.originalCall(...args);
      audit.calls.push({ connectorId: args[0], tool: args[1], arguments: args[2], result });
      return result;
    };
  });
  await page.getByRole('textbox', { name: '发送给 GeoD Agent', exact: true }).fill(input);
  await page.evaluate(() => document.querySelector('textarea').closest('form').requestSubmit());
  const started = Date.now(); let audit;
  while (Date.now() - started < 240000) {
    audit = await page.evaluate(() => {
      const a = window.__cesiumModelAudit;
      return { conversationId: a.conversationId, results: a.results, calls: a.calls, requests: a.events.filter(e => e.type === 'tool').map(e => ({ tool: e.tool, arguments: e.arguments })), items: a.events.filter(e => e.type === 'event' && e.method === 'item/completed').map(e => ({ type: e.params.item.type, name: e.params.item.name, tool: e.params.item.tool })), lastActivity: document.querySelector('.agent-panel')?.innerText.slice(-800) };
    });
    if (audit.results.length) break;
    await page.waitForTimeout(2000);
  }
  writeFileSync(resolve(output, 'real-model.json'), JSON.stringify({ input, ...audit, checkedAt: new Date().toISOString() }, null, 2));
  assert(audit.results.length, 'The actual model turn did not finish');
  assert.equal(audit.results[0].status, 'completed', JSON.stringify(audit.results[0]));
  const calls = audit.calls.filter(c => c.connectorId === 'builtin-cesium-mcp');
  assert(calls.some(c => c.tool === 'setBasemap' && c.result.success), JSON.stringify(audit.calls));
  assert(calls.some(c => ['setView', 'flyTo'].includes(c.tool) && c.result.success));
  assert(calls.some(c => c.tool === 'getSceneState' && c.result.data.opened));
  assert(calls.some(c => c.tool === 'getView' && c.result.success));
  assert(!audit.calls.some(c => c.connectorId === 'builtin-openlayers-mcp'));
  const scene = await page.evaluate(async () => {
    const a = window.__cesiumModelAudit;
    return a.originalCall('builtin-cesium-mcp', 'getSceneState', {}, null, a.conversationId);
  });
  assert(scene.data.imagery.some(i => i.loaded > 0 && i.visible), JSON.stringify(scene));
  assert(Math.abs(scene.data.camera.pitch + 45) < 2, JSON.stringify(scene.data.camera));
  assert(scene.data.camera.latitude < (scene.data.bounds[1] + scene.data.bounds[3]) / 2);
  writeFileSync(resolve(output, 'real-model.json'), JSON.stringify({ pass: true, input, conversationId: audit.conversationId, results: audit.results, calls: audit.calls, requests: audit.requests, actualScene: scene, durationMs: Date.now() - started, checkedAt: new Date().toISOString() }, null, 2));
  await page.screenshot({ path: resolve(output, 'real-model.png') });
  console.log(JSON.stringify({ pass: true, calls: calls.map(c => c.tool), answer: audit.results[0].text, camera: scene.data.camera }));
} catch (error) { await page.screenshot({ path: resolve(output, 'real-model-failure.png') }).catch(() => {}); console.error(error); process.exitCode = 1; }
finally {
  await page.evaluate(() => { const a = window.__cesiumModelAudit; if (a) { a.api.codexTurn = a.originalTurn; a.api.mcpCall = a.originalCall; } }).catch(() => {});
  await browser.close();
}
