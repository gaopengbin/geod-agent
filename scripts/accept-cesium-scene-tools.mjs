/** Actual native download, production Cesium viewer and published MCP bridge. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule, evidencePath] = process.argv.slice(2), { chromium } = await import(playwrightModule);
await fs.mkdir(evidencePath, { recursive: true });
const sourceRoot = path.resolve('artifacts/desktop-parity/tiles3d-request-volume-20261002');
const sourceManifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
for (const entry of sourceManifest.resources) {
  const bytes = await fs.readFile(path.join(sourceRoot, entry.path));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
}
const rootUrl = 'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56/1.0/TilesetWithRequestVolume/tileset.json';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233'), page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const report = { pass: false, cases: [], sourceManifest }, network = [], errors = [];
page.on('response', response => { if (/elevation3d\.arcgis\.com|CesiumMilkTruck\.glb/.test(response.url())) network.push({ url: response.url(), status: response.status() }); });
page.on('pageerror', error => errors.push(error.message));
const save = () => fs.writeFile(path.join(evidencePath, 'acceptance.json'), JSON.stringify(report, null, 2));
const passed = async (name, result) => { report.cases.push({ name, pass: true, result }); await save(); console.log(name, 'PASS'); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (run, name, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await run(); if (value) return value; await sleep(200); } throw new Error(`Timeout: ${name}`); };
const rpc = async (command, args = {}) => {
  const result = await page.evaluate(async ({ command, args }) => { try { return { value: await window.__TAURI_INTERNALS__.invoke(command, args) }; } catch (error) { return { error }; } }, { command, args });
  if (result.error) throw new Error(`${command}: ${JSON.stringify(result.error)}`); return result.value;
};
const chats = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([, value]) => JSON.parse(value)));
let conversationId, task, modelId, animationId;
const scene = async (name, args = {}, conversation = conversationId) => page.evaluate(async ({ conversation, name, args }) => {
  // Vite timestamps a module after HMR. Use the exact module already loaded by
  // the real App, so this test calls its conversation-owned MCP server.
  const moduleUrl = performance.getEntriesByType('resource').filter(entry => /\/src\/cesium-mcp\.ts\?t=/.test(entry.name)).at(-1)?.name ?? '/src/cesium-mcp.ts';
  return (await import(moduleUrl)).cesiumCall(conversation, name, args);
}, { conversation, name, args });
const state = async () => { const result = await scene('getSceneState'); assert.equal(result.success, true, JSON.stringify(result)); return result.data; };
const send = async text => { await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
try {
  assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).count(), 0);
  const previous = new Set((await chats()).map(chat => chat.conversationId)); await page.locator('.sidebar-new-chat').click();
  conversationId = await wait(async () => (await chats()).find(chat => !previous.has(chat.conversationId))?.conversationId, 'Actual new conversation');
  const workspace = await rpc('workspace_get', { conversationId });
  await rpc('workspace_set', { conversationId, directory: workspace.directory, permission: 'fullAccess' });
  // The model's first real turn mounts the normal workspace, without inserted messages.
  await page.reload(); await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  await send('这是三维工具的本地验收会话，稍后测试真实场景。现在只简短回复“可以开始”。');
  await wait(async () => { const chat = (await chats()).find(v => v.conversationId === conversationId); return chat && !chat.pendingId && chat.messages?.at(-1)?.role === 'assistant' && !(await page.getByRole('button', { name: '停止回复', exact: true }).count()); }, 'First actual model turn', 150000);
  task = await rpc('data_download_plan', { conversationId, title: 'Cesium 官方样例 · 三维工具验收', idempotencyKey: crypto.randomUUID(), request: { kind: 'tiles3d', spec: { tilesetUrl: rootUrl } } });
  await rpc('data_download_start_auto', { conversationId, taskId: task.id, planHash: task.planHash });
  task = await wait(async () => { const value = await rpc('data_download_get', { conversationId, taskId: task.id }); if (value.status === 'failed') throw new Error(value.error); return value.status === 'completed' ? value : null; }, 'Actual native 3D download');
  assert.equal(task.manifest.resources.length, sourceManifest.resources.length);
  const loaded = await page.evaluate(async ({ conversationId, task }) => (await import('/src/data-downloads.ts')).previewDataTask(conversationId, task), { conversationId, task });
  assert.equal(loaded.loaded, true, JSON.stringify(loaded));
  await page.getByRole('button', { name: '定位三维成果', exact: true }).waitFor();
  assert.equal((await state()).visible, true);
  await passed('Actual native verified public bundle opens the production Cesium scene through actual MCP', { conversationId, taskId: task.id, loaded, sourceUrl: rootUrl, resources: task.manifest.resources.length });
  const denied = await scene('setView', { longitude: 10, latitude: 10 }, `other-${crypto.randomUUID()}`);
  assert.equal(denied.success, false); await passed('Another conversation cannot mutate this scene', denied);

  const terrain = await scene('loadTerrain', { provider: 'arcgis' }); assert.equal(terrain.success, true, JSON.stringify(terrain));
  assert.equal((await state()).terrain.provider, 'arcgis');
  const height = await scene('sampleTerrain', { positions: [{ longitude: 86.925, latitude: 27.988 }, { longitude: -75.6132, latitude: 40.042 }], level: 12 });
  assert.equal(height.success, true, JSON.stringify(height)); assert(height.data.positions[0].height > 7000 && height.data.positions[0].height < 9200);
  assert(network.some(v => v.status === 200 && v.url.includes('/tile/'))); assert.equal((await state()).terrain.sampledPositions, 2);
  await passed('Public ArcGIS terrain returns actual mountain elevations and real terrain tiles', { terrain, height, responses: network.filter(v => v.url.includes('elevation3d')) });
  const invalid = await scene('sampleTerrain', { positions: [{ longitude: 200, latitude: 90 }] }); assert.equal(invalid.success, false);
  await scene('setView', { longitude: 86.925, latitude: 27.92, height: 14000, heading: 0, pitch: -30 });
  await sleep(2500); await page.locator('.tiles3d-preview__canvas').screenshot({ path: path.join(evidencePath, 'actual-arcgis-terrain.png') });
  await scene('loadTerrain', { provider: 'flat' }); assert.equal((await state()).terrain.provider, 'flat');
  const flat = await scene('sampleTerrain', { positions: [{ longitude: 86.925, latitude: 27.988 }], level: 1 }); assert.equal(flat.success, true); assert.equal(flat.data.positions[0].height, 0);
  await passed('Terrain can switch to the actual ellipsoid and rejects invalid sample coordinates', { flat, invalid });

  const modelUrl = 'https://raw.githubusercontent.com/CesiumGS/cesium/1.146/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb';
  const added = await scene('addModel', { longitude: -75.6132, latitude: 40.042, height: 40, url: modelUrl, scale: 10, label: '真实 GLB 模型' });
  assert.equal(added.success, true, JSON.stringify(added)); modelId = added.data.entityId;
  assert(modelId, JSON.stringify(added)); await scene('setView', { longitude: -75.6132, latitude: 40.0406, height: 260, pitch: -32, heading: 0 });
  const actualModel = await wait(async () => (await state()).models.items.find(model => model.entityId === modelId && model.loaded), 'External GLB actual render readiness', 90000);
  assert(network.some(v => v.status === 200 && v.url === modelUrl));
  const located = await scene('trackEntity', { entityId: modelId, pitch: -25, heading: 0, range: 180 }); assert.equal(located.success, true, JSON.stringify(located));
  await sleep(2000); assert.equal((await state()).models.items.find(model => model.entityId === modelId).inCameraFrustum, true);
  await page.locator('.tiles3d-preview__canvas').screenshot({ path: path.join(evidencePath, 'actual-external-glb.png') });
  await passed('External official GLB fetched over HTTPS and is actually ready in the rendered Cesium scene', { added, actualModel });

  const begin = '2026-10-03T00:00:00Z', middle = '2026-10-03T00:00:10Z', end = '2026-10-03T00:00:20Z';
  const animation = await scene('createAnimation', { name: '真实路线动画', modelUri: modelUrl, waypoints: [{ longitude: -75.614, latitude: 40.042, height: 40, time: begin }, { longitude: -75.612, latitude: 40.042, height: 40, time: end }], shouldAnimate: false, multiplier: 1, showPath: true });
  assert.equal(animation.success, true, JSON.stringify(animation)); animationId = animation.data.entityId;
  await scene('controlClock', { action: 'setTime', time: middle });
  await scene('trackEntity', { entityId: animationId, pitch: -25, range: 100 });
  const mid = (await state()).animations.find(v => v.entityId === animationId); assert(mid.position); assert(Math.abs(mid.position.longitude + 75.613) < 0.00001);
  await scene('controlAnimation', { action: 'play' }); const before = await state(); await sleep(1200); const moving = await state();
  assert.notEqual(moving.clock.currentTime, before.clock.currentTime); assert(moving.animations.find(v => v.entityId === animationId).position.longitude > mid.position.longitude);
  await scene('controlAnimation', { action: 'pause' }); const paused = await state(); await sleep(600); assert.equal((await state()).clock.currentTime, paused.clock.currentTime);
  assert((await state()).models.items.some(v => v.entityId === animationId && v.loaded));
  await passed('Real clock and sampled model position support create, seek, play and pause', { animation, mid, moving: moving.clock, paused: paused.clock });
  await page.locator('.tiles3d-preview__canvas').screenshot({ path: path.join(evidencePath, 'actual-animation.png') });
  await scene('setViewMode', { mode: '2d' }); const hidden = await state(); assert.equal(hidden.visible, false); assert.equal(hidden.rendering, false);
  await scene('setViewMode', { mode: '3d' }); const restored = await state(); assert.equal(restored.visible, true); assert(restored.models.items.find(v => v.entityId === modelId).loaded);
  await passed('Switching actual workspace views keeps terrain, model and animation state', { hidden: hidden.viewMode, restored: restored.viewMode, clock: restored.clock });

  await send('现在通过 Cesium MCP 查一次真实场景状态：地形是什么、外部模型实际加载了没有、动画在播放还是暂停？请依据工具返回用两三句话告诉我，不要调整场景。');
  const actualChat = await wait(async () => { const chat = (await chats()).find(v => v.conversationId === conversationId); return chat && !chat.pendingId && chat.messages?.at(-1)?.role === 'assistant' && chat.display.filter(v => v.role === 'user').length >= 2 && !(await page.getByRole('button', { name: '停止回复', exact: true }).count()) ? chat : null; }, 'Actual hosted AI reads the actual Cesium state', 150000);
  const lastUser = actualChat.display.findLastIndex(v => v.role === 'user'), calls = JSON.stringify(actualChat.display.slice(lastUser + 1).filter(v => v.role === 'tool'));
  assert(calls.includes('getSceneState')); assert(/暂停|停止/.test(actualChat.messages.at(-1).content));
  await fs.writeFile(path.join(evidencePath, 'actual-ai-conversation.json'), JSON.stringify(actualChat, null, 2));
  await page.screenshot({ path: path.join(evidencePath, 'actual-ai-scene-readback.png'), fullPage: true });
  await passed('Actual Codex and hosted AI read actual terrain, loaded models and paused animation through Cesium MCP', { answer: actualChat.messages.at(-1).content });
  assert.equal(errors.length, 0, JSON.stringify(errors)); report.pass = true;
} catch (error) {
  report.failure = error?.stack ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1;
  await page.screenshot({ path: path.join(evidencePath, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (animationId) await scene('removeAnimation', { entityId: animationId }).catch(() => {});
  report.network = network; report.pageErrors = errors; report.finishedAt = new Date().toISOString(); await save();
  await browser.close();
}
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));
