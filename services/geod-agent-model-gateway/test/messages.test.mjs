import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openMessageStore, validateAnnouncement } from '../messages-store.mjs';
import { createGatewayServer, readConfig } from '../server.mjs';

const message = (id, extra = {}) => ({ id, title: { zh: '服务公告', en: 'Service notice' }, body: { zh: '测试消息内容。', en: 'Test message.' }, ...extra });
test('anonymous GeoD announcements exclude private notices and never call identity or billing', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'geod-public-')), path = join(folder, 'ledger.sqlite');
  const publisher = openMessageStore(path);
  for (const [id, extra] of [['public', { product: 'geod' }], ['shared', { product: 'all' }], ['agent', {}], ['private', { product: 'all', audienceAccountId: 'user-a' }], ['future-version', { product: 'geod', minimumVersion: '3.6.12' }], ['expired', { product: 'geod', expiresAt: '2025-01-01' }]]) publisher.put(message(id, extra), true);
  publisher.put(message('draft', { product: 'geod' })); publisher.close();
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: 's'.repeat(40), DEEPSEEK_API_KEY: 'unused-test-key', GEOD_IDENTITY_ORIGIN: 'http://127.0.0.1:1', GEOD_AGENT_DB_PATH: path, GEOD_AGENT_WELCOME_CREDITS: '20000' });
  let upstreamCalls = 0;
  const gateway = createGatewayServer(config, { fetchImpl: async () => { upstreamCalls++; throw new Error('Public notices cannot call identity or model'); } });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const response = await fetch(`${base}/api/agent/messages/public?product=geod&clientVersion=3.6.11&accountId=user-a`);
    assert.equal(response.status, 200); const feed = await response.json();
    assert.equal(feed.accountId, null); assert.equal(feed.unreadCount, 2);
    assert.deepEqual(new Set(feed.items.map(x => x.id)), new Set(['public', 'shared']));
    assert(feed.items.every(x => x.readAt === null));
    assert.equal((await fetch(`${base}/api/agent/messages/public?product=geod-agent&clientVersion=0.2.4`)).status, 400);
    assert.equal((await fetch(`${base}/api/agent/messages/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'geod', accountId: 'user-a', clientVersion: '3.6.11', messageIds: ['public'] }) })).status, 400);
    const db = new Database(path + '-credits.sqlite', { readonly: true });
    try { for (const table of ['geod_credit_lots', 'geod_credit_grants', 'geod_welcome_decisions']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0); } finally { db.close(); }
    assert.equal(upstreamCalls, 0);
  } finally { await new Promise(resolve => gateway.close(resolve)); rmSync(folder, { recursive: true, force: true }); }
});
test('legacy GeoD inbox isolates product audiences and read receipts', () => {
  const folder = mkdtempSync(join(tmpdir(), 'geod-products-'));
  const store = openMessageStore(join(folder, 'ledger.sqlite'));
  try {
    store.put(message('agent'), true);
    store.put(message('desktop', { product: 'geod' }), true);
    store.put(message('shared', { product: 'all' }), true);
    store.put(message('target', { product: 'all', audienceAccountId: 'a' }), true);
    assert.deepEqual(new Set(store.list('a', '3.6.11', 'geod').items.map(x => x.id)), new Set(['desktop', 'shared', 'target']));
    assert.equal(store.markRead('b', '3.6.11', ['desktop', 'agent', 'target'], 'geod').accepted, 1);
    assert.equal(store.list('b', '0.2.4').unreadCount, 2);
    assert.equal(store.list('a', '3.6.11', 'geod').unreadCount, 3);
    assert.throws(() => validateAnnouncement(message('bad', { product: 'anything' })), /INVALID_MESSAGE_PRODUCT/);
    assert.throws(() => validateAnnouncement(message('targeted-desktop', { product: 'geod', audienceAccountId: 'a' })), /GEOD_PUBLIC_NOTICES_ONLY/);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('classic GeoD public notices need no token and cannot create a wallet', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'geod-scope-')), path = join(folder, 'ledger.sqlite');
  const publisher = openMessageStore(path);
  publisher.put(message('desktop', { product: 'geod' }), true); publisher.close();
  let modelCalls = 0;
  const config = readConfig({ GEOD_AGENT_GATEWAY_SECRET: 's'.repeat(40), DEEPSEEK_API_KEY: 'unused-test-key', GEOD_IDENTITY_ORIGIN: 'http://127.0.0.1:1', GEOD_AGENT_DB_PATH: path, GEOD_AGENT_WELCOME_CREDITS: '20000' });
  const gateway = createGatewayServer(config, { fetchImpl: async (url, options) => {
    if (!url.endsWith('/api/geod/oauth/introspect')) { modelCalls++; throw new Error('Unexpected model request'); }
    return Response.json({ active: { userId: 'legacy-account', clientId: 'geod-desktop', scope: 'geod:notifications', expiresAt: Date.now() + 60000 } });
  } });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`, headers = { authorization: `Bearer ${'D'.repeat(43)}`, 'content-type': 'application/json' };
  try {
    const own = await (await fetch(`${base}/api/agent/messages/public?product=geod&clientVersion=3.6.11`)).json();
    assert.equal(own.product, 'geod'); assert.equal(own.accountId, null); assert.equal(own.unreadCount, 1);
    assert.equal((await fetch(`${base}/api/agent/messages/read`, { method: 'POST', headers, body: JSON.stringify({ product: 'geod', accountId: 'other', clientVersion: '3.6.11', messageIds: ['desktop'] }) })).status, 400);
    assert.equal((await fetch(`${base}/api/agent/messages/read`, { method: 'POST', headers, body: JSON.stringify({ product: 'geod', accountId: 'legacy-account', clientVersion: '3.6.11', messageIds: ['desktop'] }) })).status, 400);
    for (const route of ['/api/agent/messages?clientVersion=0.2.4', '/api/agent/usage', '/api/agent/billing/wallet']) assert.equal((await fetch(`${base}${route}`, { headers })).status, 401, route);
    assert.equal((await fetch(`${base}/api/agent/generations`, { method: 'POST', headers, body: '{}' })).status, 401);
    const db = new Database(path + '-credits.sqlite', { readonly: true });
    try {
      for (const table of ['geod_credit_lots', 'geod_credit_grants', 'geod_welcome_decisions']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    } finally { db.close(); }
    assert.equal(modelCalls, 0);
  } finally { await new Promise(resolve => gateway.close(resolve)); rmSync(folder, { recursive: true, force: true }); }
});
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
