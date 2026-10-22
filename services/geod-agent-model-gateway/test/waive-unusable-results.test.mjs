import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {waiveUnusableResults} from '../waive-unusable-results.mjs';
test('waivers release only reviewed unusable results, retain unknown provider usage and replay without duplicate money effects',()=>{
 const d=new Database(':memory:');d.exec("ATTACH ':memory:' AS wallet;CREATE TABLE model_generations(user_id,generation_id,state,error_code,response_ciphertext,reserved_tokens,updated_at);CREATE TABLE usage_ledger(entry_id,user_id,generation_id,kind,tokens,created_at);CREATE TABLE reconciliation_audit(audit_id,user_id,generation_id,decision,evidence,operator,created_at);CREATE TABLE wallet.geod_credit_charges(account,generation_id);CREATE TABLE wallet.geod_credit_reservations(account,generation_id,state,maximum_nano);INSERT INTO model_generations VALUES('u','bad','pending_reconcile','UPSTREAM_INVALID_TOOL',NULL,20000,NULL),('u','live','streaming',NULL,NULL,100,NULL);INSERT INTO wallet.geod_credit_reservations VALUES('u','bad','reserved',1234)");
 try{
  const args={userId:'u',generationIds:['bad'],operator:'qa',evidence:'Reviewed unusable tool response. Absorb unknown provider costs.'};
  assert.equal(waiveUnusableResults(d,args).applied,false);assert.equal(d.prepare('SELECT count(*) n FROM reconciliation_audit').get().n,0);
  waiveUnusableResults(d,{...args,apply:true});waiveUnusableResults(d,{...args,apply:true});
  assert.equal(d.prepare('SELECT count(*) n FROM reconciliation_audit').get().n,1);assert.equal(d.prepare('SELECT count(*) n FROM usage_ledger').get().n,1);
  assert.equal(d.prepare('SELECT state FROM wallet.geod_credit_reservations').get().state,'released');assert.equal(d.prepare("SELECT state FROM model_generations WHERE generation_id='live'").get().state,'streaming');
  assert.throws(()=>waiveUnusableResults(d,{...args,generationIds:['live'],apply:true}));assert.equal(JSON.parse(d.prepare('SELECT evidence FROM reconciliation_audit').get().evidence).providerUsage,'unknown');
 }finally{d.close();}
});
