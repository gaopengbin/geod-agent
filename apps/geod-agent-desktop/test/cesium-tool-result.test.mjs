import assert from 'node:assert/strict';
import test from 'node:test';
import { cesiumToolResult } from '../src/cesium-tool-result.ts';

test('validates the MCP wire output after omitting optional undefined fields', () => {
  assert.deepEqual(cesiumToolResult('removeEntity', { success: true, message: 'Entity removed', error: undefined }), { success: true, message: 'Entity removed' });
  assert.deepEqual(cesiumToolResult('removeEntity', { success: false, message: undefined, error: 'Entity not found' }), { success: false, error: 'Entity not found' });
});

test('still rejects genuinely invalid tool results', () => {
  const result = cesiumToolResult('removeEntity', { success: 'true' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'INVALID_SCENE_RESULT');
  assert(result.issues.some(issue => issue.path === '$.success'));
});
