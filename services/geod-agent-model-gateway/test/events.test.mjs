import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer } from '../server.mjs';
import { validateEvents, openEventStore } from '../events-store.mjs';
const event = () => ({ event_id: randomUUID(), attempt_id: randomUUID(), occurred_at: new Date().toISOString(), state: 'completed', duration: '10-60s', reason: 'none' });
test('detailed receipt confirms persisted metadata without touching model or credit ledgers',()=>{
 const directory=mkdtempSync(join(tmpdir(),'geod-detail-')),path=join(directory,'events.sqlite');const store=openEventStore(path);
 const diagnostic={version:1,phase:'export',sources:[],storage:[{roles:['output','temporary'],volume:'E:',budget_kind:'estimate',required_bytes:400,available_bytes:600,met_budget:true}],storage_checked_at:new Date().toISOString(),failed_source:null,error_code:'EXPORT_FAILED',error_http_status:null,additional_sources:0};
 try{const rows=validateEvents({schema_version:1,accountId:'qa',events:[{...event(),client_version:'0.2.15',diagnostic,diagnostic_status:'available'}]});assert.deepEqual(store.record('qa',rows),{accepted:1,duplicates:0,diagnostics:{accepted:1,duplicates:0}});assert.deepEqual(store.record('qa',rows),{accepted:0,duplicates:1,diagnostics:{accepted:0,duplicates:1}});const db=new Database(path,{readonly:true});try{assert.deepEqual(JSON.parse(db.prepare('SELECT diagnostic_json FROM agent_events').get().diagnostic_json),diagnostic);}finally{db.close();}}finally{store.close();rmSync(directory,{recursive:true});}
});
test('events reject client identity labels, paths, raw errors and unbounded timestamps', () => {
  const body = { schema_version: 1, accountId: 'user-1', events: [event()] };
  assert.equal(validateEvents(body).length, 1);
  assert.equal(validateEvents({...body,events:[{...event(),download_kind:'vector'}]})[0].download_kind,'vector');
  assert.throws(()=>validateEvents({...body,events:[{...event(),download_kind:'private-file.tif'}]}));
  for (const extra of [{ audience: 'external' }, { path: 'private' }, { user_id: 'other' }, { reason: 'private failure' }, { occurred_at: '2000-01-01T00:00:00Z' }]) assert.throws(() => validateEvents({ ...body, events: [{ ...event(), ...extra }] }));
});
test('authenticated HTTP ingestion deduplicates retries, binds account and persists only safe data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'geod-events-')); const dbPath = join(directory, 'agent.sqlite');
  const server = createGatewayServer({ dbPath, tokenLimit: 10000, secret: 's'.repeat(40), quotaEnforced: false }, {
    fetchImpl: async () => Response.json({ active: { userId: 'geod-only', clientId: 'geod-agent-desktop', scope: 'geod:agent', expiresAt: Date.now() + 60000 } })
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/agent/events`;
  const body = { schema_version: 1, accountId: 'geod-only', events: [event()] };
  const send = (value, token = 'A'.repeat(43)) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    assert.equal((await send(body, '')).status, 401);
    assert.equal((await send({ ...body, accountId: 'wechat-user' })).status, 409);
    assert.equal((await send({ ...body, events: [{ ...event(), filename: 'secret.tif' }] })).status, 400);
    assert.deepEqual(await (await send(body)).json(), { accepted: 1, duplicates: 0 });
    const detailed={...event(),state:'failed',reason:'processing',download_kind:'raster'};
    assert.deepEqual(await (await send({...body,events:[detailed]})).json(),{accepted:1,duplicates:0});
    assert.deepEqual(await (await send({...body,events:[detailed]})).json(),{accepted:0,duplicates:1});
    assert.deepEqual(await (await send(body)).json(), { accepted: 0, duplicates: 1 });
    assert.deepEqual(await (await send({ ...body, events: [{ ...body.events[0], event_id: randomUUID() }] })).json(), { accepted: 0, duplicates: 1 });
    const db = new Database(dbPath, { readonly: true });
    try { const rows = db.prepare('SELECT * FROM agent_events').all(); assert.equal(rows.length, 2); assert.equal(rows[0].user_id, 'geod-only'); assert.equal(rows.find(r=>r.event_id===detailed.event_id).download_kind,'raster');assert.equal(rows.find(r=>r.event_id===detailed.event_id).reason,'processing');assert.equal(db.prepare('SELECT count(*) n FROM model_generations').get().n, 0); }
    finally { db.close(); }
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true }); }
});
