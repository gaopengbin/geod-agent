import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openMessageStore, validateAnnouncement } from '../messages-store.mjs';
import { createGatewayServer, readConfig } from '../server.mjs';

const message = (id, extra = {}) => ({ id, title: { zh: '服务公告', en: 'Service notice' }, body: { zh: '测试消息内容。', en: 'Test message.' }, ...extra });
test('messages respect draft, audience, dates, versions and retraction', () => {
  const folder = mkdtempSync(join(tmpdir(), 'geod-messages-'));
  const store = openMessageStore(join(folder, 'ledger.sqlite'), { clock: () => new Date('2026-10-06T10:00:00Z') });
  try {
    store.put(message('draft'));
    store.put(message('global'), true);
    store.put(message('targeted', { audienceAccountId: 'user-a' }), true);
    store.put(message('future', { startsAt: '2026-10-07T00:00:00Z' }), true);
    store.put(message('expired', { expiresAt: '2026-10-05T00:00:00Z' }), true);
    store.put(message('new-version', { minimumVersion: '0.2.3' }), true);
    assert.deepEqual(store.list('user-b', '0.2.2').items.map(item => item.id), ['global']);
    assert.deepEqual(new Set(store.list('user-a', '0.2.3').items.map(item => item.id)), new Set(['global', 'targeted', 'new-version']));
    store.publish('draft');
    assert.equal(store.list('user-a', '0.2.3').unreadCount, 4);
    store.retract('global');
    assert.equal(store.list('user-a', '0.2.3').items.some(item => item.id === 'global'), false);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('read receipts persist per account and announcement revision', () => {
  const folder = mkdtempSync(join(tmpdir(), 'geod-message-reads-')), path = join(folder, 'ledger.sqlite');
  let store = openMessageStore(path);
  try {
    store.put(message('notice'), true);
    store.put(message('private', { audienceAccountId: 'user-a' }), true);
    assert.equal(store.markRead('user-b', '0.2.3', ['notice', 'private']).accepted, 1);
    assert.equal(store.markRead('user-b', '0.2.3', ['notice']).accepted, 0);
    assert.equal(store.list('user-b', '0.2.3').unreadCount, 0);
    assert.equal(store.list('user-a', '0.2.3').unreadCount, 2);
    store.close(); store = openMessageStore(path);
    assert.equal(store.list('user-b', '0.2.3').unreadCount, 0);
    store.put(message('notice', { body: { zh: '公告已修订。' } }), true);
    assert.equal(store.list('user-b', '0.2.3').unreadCount, 1);
    assert.equal(store.list('user-b', '0.2.3').items[0].revision, 2);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('announcement actions and malformed publication inputs are rejected', () => {
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com', 'file:///C:/test']) {
    assert.throws(() => validateAnnouncement(message('bad-link', { action: { kind: 'link', label: { zh: '打开' }, url } })), /INVALID_MESSAGE_ACTION/);
  }
  assert.throws(() => validateAnnouncement(message('../outside')), /INVALID_MESSAGE/);
  assert.throws(() => validateAnnouncement(message('oversized', { body: { zh: 'a'.repeat(8001) } })), /INVALID_MESSAGE_TEXT/);
  assert.throws(() => validateAnnouncement(message('bad-range', { minimumVersion: '0.3.0', maximumVersion: '0.2.0' })), /INVALID_MESSAGE_VERSION/);
  assert.equal(validateAnnouncement(message('safe-update', { action: { kind: 'update', label: { zh: '检查更新' } } })).action.kind, 'update');
});
test('HTTP inbox authenticates GeoD accounts and rejects cross-account writes', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'geod-message-http-')), path = join(folder, 'ledger.sqlite');
  const publisher = openMessageStore(path);
  publisher.put(message('global'), true); publisher.put(message('private', { audienceAccountId: 'user-a' }), true); publisher.close();
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: 's'.repeat(40), DEEPSEEK_API_KEY: 'unused-test-key', GEOD_IDENTITY_ORIGIN: 'http://127.0.0.1:1', GEOD_AGENT_DB_PATH: path, GEOD_AGENT_WELCOME_CREDITS: '0' });
  let modelCalls = 0;
  const gateway = createGatewayServer(config, { fetchImpl: async (url, options) => {
    if (!url.endsWith('/api/geod/oauth/introspect')) { modelCalls++; throw new Error('Unexpected model request'); }
    const token = JSON.parse(options.body).token;
    return Response.json({ active: ['A'.repeat(43), 'B'.repeat(43)].includes(token) ? { userId: token[0] === 'A' ? 'user-a' : 'user-b', clientId: 'geod-agent-desktop', scope: 'geod:agent', expiresAt: Date.now() + 60000 } : null });
  } });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const headers = owner => ({ authorization: `Bearer ${owner.repeat(43)}`, 'content-type': 'application/json' });
  try {
    assert.equal((await fetch(`${base}/api/agent/messages?clientVersion=0.2.3`)).status, 401);
    const own = await (await fetch(`${base}/api/agent/messages?clientVersion=0.2.3`, { headers: headers('A') })).json();
    assert.equal(own.unreadCount, 2);
    assert.equal((await fetch(`${base}/api/agent/messages/read`, { method: 'POST', headers: headers('A'), body: JSON.stringify({ accountId: 'user-b', clientVersion: '0.2.3', messageIds: ['global'] }) })).status, 409);
    assert.equal((await fetch(`${base}/api/agent/messages/read`, { method: 'POST', headers: headers('A'), body: JSON.stringify({ accountId: 'user-a', clientVersion: '0.2.3', messageIds: ['global', 'private'] }) })).status, 200);
    const other = await (await fetch(`${base}/api/agent/messages?clientVersion=0.2.3`, { headers: headers('B') })).json();
    assert.equal(other.unreadCount, 1); assert.equal(other.items[0].id, 'global');
    assert.equal((await fetch(`${base}/api/agent/messages/publish`, { method: 'POST', headers: headers('A'), body: '{}' })).status, 404);
    assert.equal(modelCalls, 0);
  } finally { await new Promise(resolve => gateway.close(resolve)); rmSync(folder, { recursive: true, force: true }); }
});
