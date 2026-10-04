import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCesium, attachCesiumView, cesiumCall, cesiumTools, setCesiumEnabled } from '../src/cesium-mcp.ts';

const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };

test('Cesium schemas remain discoverable before a scene is open', async () => {
  const list = await cesiumTools('closed');
  assert(list.tools.some(tool => tool.name === 'getView'));
  assert(list.tools.some(tool => tool.name === 'setBasemap'));
  assert(list.tools.some(tool => tool.name === 'getSceneState'));
  assert(!('token' in list.tools.find(tool => tool.name === 'setBasemap').inputSchema.properties));
  const state = await cesiumCall('closed', 'getSceneState', {});
  assert.equal(state.data.opened, false);
  assert.equal((await cesiumCall('closed', 'getView', {})).error, 'SCENE_NOT_OPEN');
});

test('MCP dispatch validates inputs and isolates the actual conversation', async () => {
  const calls = [];
  const detach = attachCesium('current', async (name, args) => { calls.push({ name, args }); return { success: true, data: { actual: true } }; });
  try {
    assert.equal((await cesiumCall('other', 'getView', {})).error, 'SCENE_NOT_OPEN');
    assert.equal(calls.length, 0);
    assert.equal((await cesiumCall('current', 'setView', { longitude: 500, latitude: 0 })).error, 'INVALID_SCENE_ARGUMENTS');
    assert.equal(calls.length, 0);
    assert.equal((await cesiumCall('current', 'getView', {})).data.actual, true);
    assert.equal(calls[0].name, 'getView');
    assert.equal((await cesiumCall('current', 'madeUpTool', {})).error, 'UNKNOWN_SCENE_TOOL');
    setCesiumEnabled(false);
    assert.equal((await cesiumCall('current', 'getView', {})).error, 'CESIUM_DISABLED');
  } finally { setCesiumEnabled(true); detach(); }
});

test('an old viewer cannot detach or return a result for its replacement', async () => {
  let finish;
  const oldDetach = attachCesium('same', () => new Promise(resolve => { finish = resolve; }));
  const pending = cesiumCall('same', 'getView', {});
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  const detach = attachCesium('same', async () => ({ success: true, data: { replacement: true } }));
  oldDetach();
  finish({ success: true });
  try {
    assert.equal((await pending).error, 'SCENE_SESSION_CHANGED');
    assert.equal((await cesiumCall('same', 'getView', {})).data.replacement, true);
  } finally { detach(); }
});

test('workspace view tools work without a Cesium viewer and reject another conversation', async () => {
  let mode = '2d'; const calls = [];
  const detach = attachCesiumView('workspace', async (name, args) => {
    calls.push(name);
    if (name === 'setViewMode') mode = args.mode;
    return { success: true, data: { mode, has3DScene: false } };
  });
  try {
    assert.equal((await cesiumCall('workspace', 'getViewMode', {})).data.mode, '2d');
    assert.equal((await cesiumCall('workspace', 'setViewMode', { mode: '2d' })).success, true);
    const count = calls.length;
    assert.equal((await cesiumCall('other', 'closeScene', {})).error, 'VIEW_NOT_AVAILABLE');
    assert.equal((await cesiumCall('workspace', 'setViewMode', { mode: 'flat' })).error, 'INVALID_VIEW_MODE');
    assert.equal(calls.length, count);
    assert.equal((await cesiumCall('workspace', 'closeScene', {})).success, true);
  } finally { detach(); }
  assert.equal((await cesiumCall('workspace', 'getViewMode', {})).error, 'VIEW_NOT_AVAILABLE');
});

test('scene state reports retained-but-hidden 3D and old host cleanup preserves its replacement', async () => {
  const oldDetach = attachCesiumView('workspace', async () => ({ success: true, data: { mode: '3d' } }));
  const detach = attachCesiumView('workspace', async () => ({ success: true, data: { mode: '2d' } }));
  const sceneDetach = attachCesium('workspace', async () => ({ success: true, data: { opened: true } }));
  oldDetach();
  try {
    const result = await cesiumCall('workspace', 'getSceneState', {});
    assert.equal(result.data.opened, true);
    assert.equal(result.data.visible, false);
    assert.equal(result.data.viewMode, '2d');
  } finally { detach(); sceneDetach(); }
});
