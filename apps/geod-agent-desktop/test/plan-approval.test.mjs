import test from 'node:test';import assert from 'node:assert/strict';
import {waitForPlanApproval} from '../src/plan-approval.ts';
test('approval wait continues once from native receipt and cancellation prevents execution',async()=>{
 let checks=0;await waitForPlanApproval(async()=>++checks===3,()=>false,1);assert.equal(checks,3);
 let cancelled=true;checks=0;await assert.rejects(waitForPlanApproval(async()=>{checks++;return true;},()=>cancelled,1),{code:'USER_STOPPED'});assert.equal(checks,0);
 await assert.rejects(waitForPlanApproval(async()=>{throw Error('计划已变化');},()=>false,1),/计划已变化/);
});

test('stopping after the native receipt was pending remains a user stop',async()=>{
 let stopped=false;let checks=0;
 await assert.rejects(waitForPlanApproval(async()=>{checks++;stopped=true;return false;},()=>stopped,1),{code:'USER_STOPPED'});
 assert.equal(checks,1);
});
