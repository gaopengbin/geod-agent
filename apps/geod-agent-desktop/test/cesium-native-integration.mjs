// Operates the production Cesium viewer and its real in-memory MCP transport.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:1420'));
const conversationId = process.argv[3] || 'ion-buildings-4d47a261-2cd6-41e1-ae3d-473831f572bd';
const output = resolve('../../docs/implementation/evidence/cesium-mcp-2026-10-03');
mkdirSync(output, { recursive: true });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const call = (tool, args = {}) => page.evaluate(async ({ conversationId, tool, args }) => {
  const { api } = await import('/src/api.ts'); return api.mcpCall('builtin-cesium-mcp', tool, args, null, conversationId);
}, { conversationId, tool, args });
try {
  assert(page); assert(!await page.getByRole('button', { name: '停止回复', exact: true }).isVisible());
  // Package installation can leave old HMR module instances in a running page.
  await page.reload();
  await page.getByRole('textbox', { name: '发送给 GeoD Agent', exact: true }).waitFor();
  await page.waitForTimeout(500);
  const setup = await page.evaluate(async conversationId => {
    const { api } = await import('/src/api.ts');
    const { dataDownloads } = await import('/src/data-downloads.ts');
    const overview = await api.extensionsList();
    const tools = await api.mcpTools('builtin-cesium-mcp', conversationId);
    const tasks = (await dataDownloads.list(conversationId)).filter(t => t.kind === 'tiles3d' && t.status === 'completed');
    return { overview, tools, tasks: tasks.map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })) };
  }, conversationId);
  assert(setup.overview.connectors.some(c => c.id === 'builtin-cesium-mcp' && c.enabled));
  assert(setup.tools.tools.some(t => t.name === 'getView'));
  const task = setup.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; assert(task);
  const loaded = await page.evaluate(async ({ conversationId, taskId }) => {
    const { executeDataDownloadTool } = await import('/src/data-download-tools.ts');
    return executeDataDownloadTool(conversationId, 'data_download_load', { taskId }, 'cesium-mcp-preview-' + crypto.randomUUID());
  }, { conversationId, taskId: task.id });
  assert.equal(loaded.loaded, true, JSON.stringify(loaded));
  const scene = await call('getSceneState'); assert.equal(scene.data.opened, true, JSON.stringify(scene)); assert.equal(scene.data.globe, true, JSON.stringify(scene));
  assert(scene.data.layers.some(l => l.id === `download-${task.id}`));
  const camera = (await call('getView')).data;
  const changed = await call('setView', { longitude: camera.longitude, latitude: camera.latitude, height: camera.height, heading: 30, pitch: -65 });
  assert.equal(changed.success, true, JSON.stringify(changed));
  // The bridge targets a ground point; camera geodetic angles differ slightly over the ellipsoid.
  const actual = (await call('getView')).data; assert(Math.abs(actual.heading - 30) < 0.1, JSON.stringify(actual)); assert(Math.abs(actual.pitch + 65) < 0.1, JSON.stringify(actual));
  const bounds = scene.data.bounds, longitude = (bounds[0] + bounds[2]) / 2, latitude = (bounds[1] + bounds[3]) / 2;
  const marker = await call('addMarker', { id: 'geod-cesium-native-test', longitude, latitude, label: 'Cesium MCP 实测', color: '#FFCC00' });
  assert.equal(marker.success, true, JSON.stringify(marker));
  const properties = await call('getEntityProperties', { entityId: marker.data.entityId }); assert.equal(properties.success, true, JSON.stringify(properties));
  const removed = await call('removeEntity', { entityId: marker.data.entityId }); assert.equal(removed.success, true, JSON.stringify({ marker, properties, removed }));
  const hide = await call('setLayerVisibility', { id: `download-${task.id}`, visible: false }); assert.equal(hide.success, true);
  assert.equal((await call('listLayers')).data.layers.find(l => l.id === `download-${task.id}`).visible, false);
  assert.equal((await call('setLayerVisibility', { id: `download-${task.id}`, visible: true })).success, true);
  assert.equal((await call('fitScene')).success, true);
  const registered = await page.evaluate(async () => { const { api } = await import('/src/api.ts'); return (await api.sourcesList()).find(source => source.id === 'esri-world-imagery'); });
  if (registered) {
    const source = await call('loadSource', { sourceId: registered.id }); assert.equal(source.success, true, JSON.stringify(source));
    let state;
    for (let attempt = 0; attempt < 45; attempt++) {
      state = await call('getSceneState');
      if (state.data.imagery.some(l => l.sourceId === registered.id && l.loaded > 0)) break;
      await page.waitForTimeout(1000);
    }
    assert(state.data.imagery.some(l => l.sourceId === registered.id && l.loaded > 0), JSON.stringify(state));
  }
  assert.equal((await call('setBasemap', { basemap: 'osm' })).success, true);
  let ready;
  for (let attempt = 0; attempt < 45; attempt++) {
    ready = await call('getSceneState');
    if (ready.data.imagery.some(l => l.loaded > 0 && l.visible)) break;
    await page.waitForTimeout(1000);
  }
  assert(ready.data.imagery.some(l => l.loaded > 0 && l.visible), JSON.stringify(ready));
  const isolated = await page.evaluate(async () => { const { api } = await import('/src/api.ts'); return api.mcpCall('builtin-cesium-mcp', 'getView', {}, null, 'other-conversation'); });
  assert.equal(isolated.error, 'SCENE_NOT_OPEN');
  await page.waitForTimeout(1200); await page.screenshot({ path: resolve(output, 'native-scene.png') });
  const evidence = { pass: true, conversationId, task, loaded, toolCount: setup.tools.tools.length, cameraBefore: camera, cameraAfter: actual, scene: ready.data, marker, properties, checks: ['production native preview', 'published bridge and contracts', 'MCP listTools/callTool', 'actual camera readback', 'entity create/read/remove', 'downloaded layer hide/show', ...(registered ? ['registered Esri source loaded'] : []), 'native OSM imagery loaded', 'conversation isolation'], pageErrors: errors, checkedAt: new Date().toISOString() };
  assert.equal(errors.length, 0, JSON.stringify(errors));
  writeFileSync(resolve(output, 'native-acceptance.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ pass: true, task: task.title, toolCount: evidence.toolCount, imagery: ready.data.imagery, output }));
} catch (error) { await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {}); console.error(error); process.exitCode = 1; }
finally { await browser.close(); }
