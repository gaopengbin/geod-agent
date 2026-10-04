import test from 'node:test';
import assert from 'node:assert/strict';
import { startPlanJob } from '../src/job-start.ts';

function fixture(state = 'downloading', active = false) {
  let job = {jobId:'job',planId:'plan',state,version:40};
  let running = active;
  const calls = [];
  const api = {
    workspaceGet: async()=>({permission:'fullAccess'}),
    jobsForPlan: async()=>job,
    jobsActive: async()=>running ? [job.jobId] : [],
    jobsStartAuto: async()=>{calls.push('start');job={...job,state:'queued'};running=true;return job;},
    jobsResume: async(id)=>{assert.equal(id,'job');calls.push('resume');running=true;return job;},
    jobsGet: async()=>job,
    jobsEvents: async()=>[{completedTiles:448,totalTiles:600}],
    plansGet: async()=>({plan:{totalTiles:600}}),
  };
  return {api,calls};
}

test('continuing an interrupted job actually starts its worker and retains its progress',async()=>{
  const {api,calls}=fixture();
  const {result}=await startPlanJob(api,'plan','chat','call');
  assert.deepEqual(calls,['resume']);
  assert.equal(result.operation,'resumed');assert.equal(result.workerActive,true);
  assert.equal(result.state,'downloading');assert.equal(result.completedTiles,448);assert.equal(result.percent,75);
});
test('already running and completed jobs do not start duplicate workers',async()=>{
  for(const [state,active,operation] of [['downloading',true,'already-running'],['completed',false,'already-finished']]){
    const {api,calls}=fixture(state,active);
    const {result}=await startPlanJob(api,'plan','chat','call');
    assert.deepEqual(calls,[]);assert.equal(result.operation,operation);
  }
});
test('a stopped worker is reported as interrupted even if the resume command returned downloading',async()=>{
  const {api}=fixture();api.jobsResume=async()=>api.jobsGet('job');
  const {result}=await startPlanJob(api,'plan','chat','call');
  assert.equal(result.workerActive,false);assert.equal(result.state,'interrupted');
});
test('confirmation mode cannot be bypassed by an existing job, and a new job is actually submitted',async()=>{
  const {api,calls}=fixture();api.workspaceGet=async()=>({permission:'confirmEach'});
  assert.deepEqual(await startPlanJob(api,'plan','chat','call'),{error:'APPROVAL_REQUIRED'});
  assert.deepEqual(calls,[]);
  api.workspaceGet=async()=>({permission:'fullAccess'});api.jobsForPlan=async()=>null;
  const {result}=await startPlanJob(api,'plan','chat','call');
  assert.deepEqual(calls,['start']);assert.equal(result.reused,false);assert.equal(result.workerActive,true);
});
