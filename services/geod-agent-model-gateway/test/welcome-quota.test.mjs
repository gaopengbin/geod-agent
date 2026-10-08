import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import Database from 'better-sqlite3';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';
import {readWelcomeCreditPolicy} from '../welcome-credit-policy.mjs';
import {welcomeCreditReport,welcomeCreditCsv} from '../welcome-credit-report.mjs';
const options={loadGeneration:()=>null,welcomeCredit:{policyId:'quota-v1',creditNanoCny:'20000000000'}};
function fixture(){const root=mkdtempSync(join(tmpdir(),'geod-welcome-quota-'));return {path:join(root,'wallet.sqlite'),close:()=>rmSync(root,{recursive:true,force:true})};}
test('100 cumulative grants, persistent audit, restart and policy changes never reset slots',()=>{
 const f=fixture();let ledger=createPaymentLedgerCandidate(f.path,options);
 try{
  for(let i=0;i<100;i++)assert.equal(ledger.grantWelcome('account-'+i).replayed,false);
  assert.deepEqual(ledger.welcomeStatus(),{limit:100,issued:100,remaining:0,available:false});
  assert.equal(ledger.grantWelcome('account-100').state,'quota-exhausted');
  for(let i=0;i<5;i++){assert.equal(ledger.grantWelcome('account-100').state,'quota-exhausted');assert.equal(ledger.grantWelcome('account-0').replayed,true);}
  assert.equal(ledger.summary('account-100').balanceNanoCny,'0');
  ledger.close();ledger=createPaymentLedgerCandidate(f.path,{...options,welcomeCredit:{...options.welcomeCredit,policyId:'quota-v2'}});
  assert.equal(ledger.grantWelcome('account-101').state,'quota-exhausted');
  assert.equal(ledger.summary('account-0').grants.length,1);
  const report=welcomeCreditReport(f.path);assert.equal(report.grants.length,100);assert.equal(report.decisions.length,102);
  assert(report.grants.every(g=>g.credits==='20000'&&g.grantId&&g.createdAtUtc));
  assert.equal(report.decisions.find(x=>x.account==='account-99').issuedCount,100);
  assert.equal(report.decisions.find(x=>x.account==='account-100').state,'quota-exhausted');
  assert.match(welcomeCreditCsv(report),/quota-exhausted/);
 }finally{ledger.close();f.close();}
});
test('independent processes competing for the last slot cannot exceed 100',async()=>{
 const f=fixture();const init=createPaymentLedgerCandidate(f.path,options);
 for(let i=0;i<99;i++)init.grantWelcome('seed-'+i);init.close();
 try{
  const run=i=>new Promise((resolve,reject)=>{const c=fork(new URL('./helpers/welcome-quota-child.mjs',import.meta.url),[f.path,'racer-'+i],{stdio:['ignore','ignore','pipe','ipc']});let result,errors='';c.stderr.on('data',x=>errors+=x);c.on('message',x=>result=x);c.on('error',reject);c.on('exit',code=>code?reject(new Error(errors)):resolve(result));});
  const results=await Promise.all(Array.from({length:8},(_,i)=>run(i)));
  assert.equal(results.filter(r=>r.state==='granted').length,1);assert.equal(results.filter(r=>r.state==='quota-exhausted').length,7);
  const report=welcomeCreditReport(f.path);assert.equal(report.issued,100);assert.equal(report.decisions.length,107);
 }finally{f.close();}
});
test('legacy grants count toward quota; historical audit never invents limit snapshots',()=>{
 const f=fixture();let ledger=createPaymentLedgerCandidate(f.path,options);ledger.grantWelcome('old');ledger.close();
 const db=new Database(f.path);db.exec('DROP TABLE geod_welcome_decisions');db.close();
 ledger=createPaymentLedgerCandidate(f.path,{...options,welcomeCredit:{...options.welcomeCredit,maxRecipients:1}});
 try{assert.equal(ledger.grantWelcome('new').state,'quota-exhausted');const r=welcomeCreditReport(f.path,{limit:1});assert.equal(r.issued,1);assert.equal(r.decisions.find(x=>x.account==='old').recipientLimit,null);}finally{ledger.close();f.close();}
});
test('failed record insert rolls back credit and slot together',()=>{
 const f=fixture(),ledger=createPaymentLedgerCandidate(f.path,options),db=new Database(f.path);
 try{db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON geod_welcome_decisions BEGIN SELECT RAISE(ABORT,'audit failed'); END");assert.throws(()=>ledger.grantWelcome('account'));assert.equal(ledger.welcomeStatus().issued,0);assert.equal(ledger.summary('account').balanceNanoCny,'0');db.exec('DROP TRIGGER reject_audit');assert.equal(ledger.grantWelcome('account').replayed,false);}finally{db.close();ledger.close();f.close();}
});
test('recipient limit defaults to 100 and rejects malformed values',()=>{
 assert.equal(readWelcomeCreditPolicy({},{quotaEnforced:true}).maxRecipients,100);
 assert.equal(readWelcomeCreditPolicy({GEOD_AGENT_WELCOME_MAX_RECIPIENTS:'0'},{quotaEnforced:true}).maxRecipients,0);
 for(const value of ['-1','1.5','100x','','1000001'])assert.throws(()=>readWelcomeCreditPolicy({GEOD_AGENT_WELCOME_MAX_RECIPIENTS:value},{quotaEnforced:true}),{code:'WELCOME_CREDIT_CONFIG_INVALID'});
});
