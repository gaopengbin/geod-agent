import assert from 'node:assert/strict';
import test from 'node:test';
import { bookmarkBoundary, readBoundaryBookmarks, writeBoundaryBookmarks } from '../src/boundary-bookmarks.ts';
import { receiveBoundarySelection, selectBoundaryForConversation } from '../src/boundary-selection.ts';

test('bookmarks preserve immutable geometry references and stay in their conversation', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const boundary = { boundaryId: 'range-one', name: '矩形', bounds: [116, 39, 117, 40], polygonCount: 1 };
  const first = bookmarkBoundary([], boundary); writeBoundaryBookmarks(storage, 'one', first);
  assert.deepEqual(readBoundaryBookmarks(storage, 'one'), first); assert.deepEqual(readBoundaryBookmarks(storage, 'two'), []);
  const edited = bookmarkBoundary(first, { ...boundary, boundaryId: 'range-two', name: '调整范围' }, first[0].id);
  assert.equal(edited.length, 1); assert.equal(edited[0].id, 'range-one'); assert.equal(edited[0].boundaryId, 'range-two'); assert.equal(first[0].boundaryId, 'range-one');
  writeBoundaryBookmarks(storage, 'one', edited); assert.equal(readBoundaryBookmarks(storage, 'one')[0].name, '调整范围');
  writeBoundaryBookmarks(storage, 'one', []); assert.deepEqual(readBoundaryBookmarks(storage, 'one'), []);
  values.set('geod.boundary-bookmarks.v1:one', '{bad json'); assert.deepEqual(readBoundaryBookmarks(storage, 'one'), []);
});

test('map selection only reaches the matching active conversation and propagates busy errors', async () => {
  const selected = []; const boundary = { boundaryId: 'range-one', name: '矩形' };
  const detachOld = receiveBoundarySelection('one', async value => selected.push(value));
  await selectBoundaryForConversation('one', boundary); assert.deepEqual(selected, [boundary]);
  await assert.rejects(selectBoundaryForConversation('two', boundary), /对话尚未就绪/);
  const detachNew = receiveBoundarySelection('one', async () => { throw new Error('正在回复'); });
  detachOld(); await assert.rejects(selectBoundaryForConversation('one', boundary), /正在回复/);
  detachNew(); await assert.rejects(selectBoundaryForConversation('one', boundary), /对话尚未就绪/);
});
