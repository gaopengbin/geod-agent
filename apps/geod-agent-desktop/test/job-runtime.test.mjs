import test from 'node:test';
import assert from 'node:assert/strict';
import {jobExecutionState,jobStatusFacts} from '../src/job-runtime.ts';
test('a persisted downloading state with no worker is interrupted, not downloading',()=>{
 const job={jobId:'a',planId:'plan',state:'downloading',version:40};
 const facts=jobStatusFacts(job,false,[{completedTiles:448,totalTiles:600,occurredAt:'2026-10-01T00:00:00Z'}],600);
 assert.equal(facts.state,'interrupted');assert.equal(facts.workerActive,false);
 assert.equal(facts.completedTiles,448);assert.equal(facts.totalTiles,600);assert.equal(facts.percent,75);
 assert.equal(jobExecutionState(job,true),'downloading');
});
test('unknown progress is not invented and a completed artifact stays completed',()=>{
 assert.equal(jobStatusFacts({jobId:'a',planId:'p',state:'downloading',version:1},true,[],600).completedTiles,null);
 assert.equal(jobExecutionState({state:'completed'},false),'completed');
});
test('resume cache validation is separate from already recorded download progress',()=>{
 const job={jobId:'a',planId:'p',state:'downloading',version:41};
 const facts=jobStatusFacts(job,true,[{completedTiles:448,totalTiles:600},{completedTiles:16,totalTiles:600}],600);
 assert.equal(facts.completedTiles,448);assert.equal(facts.percent,75);
 assert.equal(facts.checkingCache,true);assert.equal(facts.checkedTiles,16);
 const next=jobStatusFacts(job,true,[{completedTiles:448,totalTiles:600},{completedTiles:464,totalTiles:600}],600);
 assert.equal(next.checkingCache,false);assert.equal(next.completedTiles,464);
});
