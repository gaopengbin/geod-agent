import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGatewayServer} from '../server.mjs';
import {validateActivity,openActivityStore} from '../activity-store.mjs';
const event=()=>({event_id:randomUUID(),kind:'personal_model',state:'completed',reason:'none',occurred_at:new Date().toISOString(),input_tokens:123,output_tokens:4,usage_known:true});

test('first observed client is once per account across devices and opt-in resets',()=>{
 const store=openActivityStore(':memory:');
 try{
  const e={...event(),kind:'app_first_seen',state:'started',usage_known:false,input_tokens:null,output_tokens:null};
  const body={schema_version:1,accountId:'a',events:[e]};validateActivity(body);
  assert.deepEqual(store.record('a',[e]),{accepted:1,duplicates:0});
  assert.deepEqual(store.record('a',[{...e,event_id:randomUUID()}]),{accepted:0,duplicates:1});
  assert.equal(store.record('b',[{...e,event_id:randomUUID()}]).accepted,1);
  assert.throws(()=>validateActivity({...body,events:[{...e,usage_known:true,input_tokens:1,output_tokens:2}]}));
 }finally{store.close();}
});
test('activity rejects raw private data and does not invent unknown token usage',()=>{
 const body={schema_version:1,accountId:'geod-only',events:[event()]};assert.equal(validateActivity(body).length,1);
 for(const extra of [{model:'private'},{channel_url:'secret'},{prompt:'private'},{reason:'raw failure'},{input_tokens:-1},{input_tokens:1.5},{usage_known:false},{occurred_at:'2000-01-01T00:00:00Z'}])assert.throws(()=>validateActivity({...body,events:[{...event(),...extra}]}));
 assert.equal(validateActivity({...body,events:[{...event(),usage_known:false,input_tokens:null,output_tokens:null}]}).length,1);
});
test('native activity HTTP retry is idempotent, account-bound and never charges Credits',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'geod-activity-')),path=join(dir,'ledger.sqlite');
 const server=createGatewayServer({dbPath:path,tokenLimit:10000,secret:'s'.repeat(40),quotaEnforced:false},{fetchImpl:async()=>Response.json({active:{userId:'geod-only',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const body={schema_version:1,accountId:'geod-only',events:[event()]};
 const send=(b,token='A'.repeat(43))=>fetch(`http://127.0.0.1:${server.address().port}/api/agent/activity`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(b)});
 try{
  assert.equal((await send(body,'')).status,401);assert.equal((await send({...body,accountId:'other'})).status,409);
  assert.equal((await send({...body,events:[{...event(),path:'private'}]})).status,400);
  assert.deepEqual(await(await send(body)).json(),{accepted:1,duplicates:0});assert.deepEqual(await(await send(body)).json(),{accepted:0,duplicates:1});
  const db=new Database(path,{readonly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM agent_activity_events').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM model_generations').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM usage_ledger').get().n,0);}finally{db.close();}
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true});}
});
