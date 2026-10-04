import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLedger} from '../ledger.mjs';
import {readSponsors,sponsorRoute} from '../sponsors.mjs';
import {sponsorBudgetWindow} from '../sponsor-budget.mjs';
const declaration={id:'month-qa',name:'Calendar budget QA',allowedUsers:['*'],apiKeyEnv:'QA_KEY',baseUrl:'https://provider.example/v1',models:[{id:'qa',name:'QA',contextWindow:16000,maxOutputTokens:512,inputModalities:['text']}],quotaMode:'enforced',perUserTokenLimit:1000,totalTokenLimit:1600};
const config=(changes={})=>readSponsors({GEOD_AGENT_SPONSORS_JSON:JSON.stringify([{...declaration,...changes}]),QA_KEY:'fixture-provider-key'})[0];
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'geod-month-budget-'));let clock=Date.parse('2026-09-30T23:59:59.000Z');const file=join(root,'ledger.sqlite');let ledger=openLedger(file,1000,'s'.repeat(40),false,{now:()=>clock});return{get ledger(){return ledger},setTime:value=>{clock=Date.parse(value)},reopen:()=>{ledger.close();ledger=openLedger(file,1000,'s'.repeat(40),false,{now:()=>clock})},close:()=>{ledger.close();rmSync(root,{recursive:true,force:true})}};};
const reserve=(f,provider,user,id,tokens=600)=>f.ledger.reserve({userId:user,generationId:id,conversationId:'calendar-chat',requestHash:id,model:'qa',reserveTokens:tokens,sponsor:provider});
const settle=(f,user,id,usage)=>{f.ledger.markStreaming(user,id);f.ledger.settle(user,id,usage,0,'provider-'+id,{content:'Controlled ledger fixture'});};

test('operator period options preserve existing revisions and cannot be injected by a client',()=>{
 const lifetime=config();assert.equal(lifetime.revision,config({budgetPeriod:'lifetime'}).revision);assert.equal(lifetime.budgetPeriod,'lifetime');const month=config({budgetPeriod:'month'});assert.notEqual(lifetime.revision,month.revision);
 assert.throws(()=>config({budgetPeriod:'week'}));const input={providerId:month.id,modelId:'qa',revision:month.revision};assert.throws(()=>sponsorRoute([month],{...input,budgetPeriod:'lifetime'},'alice'),e=>e.code==='SPONSOR_INVALID');
});
test('UTC calendar windows include year rollover and leap February',()=>{
 assert.deepEqual(sponsorBudgetWindow(config(),Date.now()),{start:null,end:null});
 assert.deepEqual(sponsorBudgetWindow(config({budgetPeriod:'month'}),Date.parse('2026-12-31T23:59:59Z')),{start:'2026-12-01T00:00:00.000Z',end:'2027-01-01T00:00:00.000Z'});
 assert.deepEqual(sponsorBudgetWindow(config({budgetPeriod:'month'}),Date.parse('2028-02-29T23:59:59Z')),{start:'2028-02-01T00:00:00.000Z',end:'2028-03-01T00:00:00.000Z'});
});
test('monthly individual and shared reservations renew without clearing history or hosted usage',()=>{
 const f=fixture(),month=config({budgetPeriod:'month'});
 try{
  assert(!reserve(f,month,'alice','sep-alice').quotaExceeded);settle(f,'alice','sep-alice',900);
  assert(reserve(f,month,'alice','sep-over',200).quotaExceeded);assert(!reserve(f,month,'bob','sep-bob').quotaExceeded);assert(reserve(f,month,'charlie','sep-shared',200).quotaExceeded);
  f.setTime('2026-10-01T00:00:00.000Z');const renewed=f.ledger.sponsorUsage('alice',month);assert.equal(renewed.committedTokens,0);assert.equal(renewed.remainingTokens,1000);assert.equal(renewed.periodStart,'2026-10-01T00:00:00.000Z');assert(!reserve(f,month,'alice','oct-alice').quotaExceeded);assert.equal(f.ledger.get('alice','sep-alice').inputTokens,900);
  assert.equal(f.ledger.sponsorUsage('alice',config()).committedTokens,900);assert.equal(f.ledger.usage('alice').committedTokens,0);assert.equal(f.ledger.usage('alice').quotaEnforced,false);
 }finally{f.close()}
});
test('late settlement and pending reconciliation stay attributed to their reservation month',()=>{
 const f=fixture(),month=config({budgetPeriod:'month'});
 try{
  reserve(f,month,'alice','late-sep');f.ledger.markStreaming('alice','late-sep');f.setTime('2026-10-01T00:00:00Z');f.reopen();
  assert.equal(f.ledger.get('alice','late-sep').state,'pending_reconcile');let usage=f.ledger.sponsorUsage('alice',month);assert.equal(usage.remainingTokens,1000);assert.equal(usage.priorReservedTokens,600);assert.equal(f.ledger.pendingList().length,1);
  f.ledger.reconcile({userId:'alice',generationId:'late-sep',decision:'settle',inputTokens:900,outputTokens:0,upstreamRequestId:'late-evidence',operator:'qa-operator',evidence:'Actual controlled provider receipt confirms the prior request'});
  usage=f.ledger.sponsorUsage('alice',month);assert.equal(usage.priorReservedTokens,0);assert.equal(usage.committedTokens,0);assert.equal(usage.remainingTokens,1000);assert.equal(f.ledger.sponsorUsage('alice',config()).committedTokens,900);
  assert.equal(reserve(f,month,'alice','late-sep').replayed,true);assert.equal(f.ledger.sponsorUsage('alice',month).reservedTokens,0);
 }finally{f.close()}
});
test('changing a monthly campaign revision or reopening cannot replenish the current month',()=>{
 const f=fixture(),month=config({budgetPeriod:'month'});
 try{reserve(f,month,'alice','actual-sep');settle(f,'alice','actual-sep',900);f.reopen();const changed=config({budgetPeriod:'month',name:'Updated branding'});assert.equal(f.ledger.sponsorUsage('alice',changed).remainingTokens,100);assert(reserve(f,changed,'alice','more',200).quotaExceeded);assert.equal(f.ledger.sponsorUsage('alice',changed).committedTokens,900);}finally{f.close()}
});
test('observe mode remains unlimited across a month transition while preserving prior exposure',()=>{
 const f=fixture(),month=config({budgetPeriod:'month',quotaMode:'observe'});
 try{reserve(f,month,'alice','sep-observed',100000);f.setTime('2026-10-01T00:00:00Z');reserve(f,month,'alice','oct-observed',100000);const usage=f.ledger.sponsorUsage('alice',month);assert.equal(usage.remainingTokens,null);assert.equal(usage.quotaEnforced,false);assert.equal(usage.priorReservedTokens,100000);assert.equal(usage.reservedTokens,100000);}finally{f.close()}
});
