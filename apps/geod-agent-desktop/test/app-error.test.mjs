import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../src/app-error.ts';

test('native rejection objects and wrapped JSON preserve the actual actionable reason', () => {
  const error = {code:'PLAN_STALE',message:'The plan changed or expired; review it again'};
  const expected = '计划已过期或图源配置已变化，请重新生成计划。';
  for (const value of [error, {error}, {message:error}, JSON.stringify(error), new Error(JSON.stringify(error))]) {
    assert.equal(errorMessage(value), expected);
    assert.ok(!errorMessage(value).includes('[object Object]'));
  }
  assert.equal(errorMessage({code:'PLAN_STALE',message:'图源配置已经变化，请重新生成并核对计划'}), '图源配置已经变化，请重新生成并核对计划');
  assert.equal(errorMessage(new Error('SOURCE_NETWORK')), 'SOURCE_NETWORK');
});

test('unknown, empty and cyclic errors produce readable fallbacks', () => {
  const cycle = {}; cycle.message = cycle;
  for (const value of [undefined, null, {}, '', cycle, '[object Object]', {message:{}}]) {
    assert.equal(errorMessage(value), '操作失败，请查看本地任务记录。');
  }
  assert.equal(errorMessage({code:'DISK_INSUFFICIENT',message:'Not enough space'}), '保存位置或缓存空间不足，请释放空间后重试。');
});
