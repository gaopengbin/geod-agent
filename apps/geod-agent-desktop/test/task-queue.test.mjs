import test from 'node:test';
import assert from 'node:assert/strict';
import { discardedPlans, setPlanDiscarded, assertPlanAvailable, buildTaskQueue, canTaskAction, taskEnded, withPlanTaskLock, runTaskBatch } from '../src/task-queue.ts';

const plan = id => ({planId:id,plan:{sourceName:id,totalTiles:600,planHash:`hash-${id}`}});
const memory = () => { const data = new Map(); return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}; };
const job = (id,state,version=1) => ({jobId:`job-${id}`,planId:id,state,version});
function fixture() {
  const jobs = new Map(), calls=[];
  const api = {
    jobsForPlan:async id=>jobs.get(id)??null,
    approvalsGrant:async(id,hash)=>{calls.push(['approval',id,hash]);return {approvalId:`approval-${id}`};},
    jobsStart:async(id,hash,approvalId)=>{calls.push(['start',id,hash,approvalId]);if(id==='fails')throw new Error('DISK_INSUFFICIENT');const item=job(id,'queued');jobs.set(id,item);return item;},
    jobsStartAuto:async(id,conversation)=>{calls.push(['auto',id,conversation]);const item=job(id,'queued');jobs.set(id,item);return item;},
    jobsCancel:async id=>{calls.push(['cancel',id]);return {...[...jobs.values()].find(item=>item.jobId===id),state:'cancelled'};},
  };
  return {api,jobs,calls};
}

test('discard survives reread, is isolated by account/conversation, and can be restored',()=>{
  const store=memory();
  setPlanDiscarded(store,'alice','chat-1','a',true);
  assert.deepEqual(discardedPlans(store,'alice','chat-1'),['a']);
  assert.deepEqual(discardedPlans(store,'alice','chat-2'),[]);
  assert.deepEqual(discardedPlans(store,'bob','chat-1'),[]);
  assert.throws(()=>assertPlanAvailable(store,'alice','chat-1','a'),/PLAN_DISCARDED/);
  setPlanDiscarded(store,'alice','chat-1','a',false);
  assert.doesNotThrow(()=>assertPlanAvailable(store,'alice','chat-1','a'));
});
test('queue includes unstarted plans, interrupted workers and terminal history with truthful progress',()=>{
  const tasks=buildTaskQueue(['a','b','c','d'].map(plan),[job('b','downloading'),job('c','completed')],[],['a'],{'job-b':{job:job('b','downloading',2),workerActive:false,completedTiles:448}});
  assert.equal(tasks.length,4);
  assert.equal(tasks.find(item=>item.stored.planId==='d').state,'pending');
  const b=tasks.find(item=>item.stored.planId==='b');assert.equal(b.state,'interrupted');assert.equal(b.completedTiles,448);
  assert.equal(canTaskAction(b,'start'),false);assert.equal(canTaskAction(b,'cancel'),true);
  assert.deepEqual(tasks.filter(taskEnded).map(item=>item.state),['completed','discarded']);
  assert.equal(tasks.find(item=>item.stored.planId==='c').completedTiles,600);
  // An old background snapshot cannot regress a newly cancelled job.
  assert.equal(buildTaskQueue([plan('b')],[job('b','cancelled',3)],[],[],{'job-b':{job:job('b','downloading',2)}})[0].state,'cancelled');
  assert.equal(buildTaskQueue([plan('b')],[job('b','downloading',2),job('b','cancelled',3)],[],[])[0].state,'cancelled');
});
test('batch start grants each exact plan and reports partial failure without skipping later plans',async()=>{
  const {api,calls}=fixture();const store=memory();
  const result=await runTaskBatch(api,store,'alice','chat',['a','fails','b'].map(plan),'start');
  assert.deepEqual(result.succeeded.map(item=>item.planId),['a','b']);
  assert.deepEqual(result.failed,[{planId:'fails',message:'DISK_INSUFFICIENT'}]);
  assert.deepEqual(calls.filter(item=>item[0]==='start').map(item=>item.slice(1)),[['a','hash-a','approval-a'],['fails','hash-fails','approval-fails'],['b','hash-b','approval-b']]);
});
test('full access uses native workspace permission checks; stale selections cannot discard or double-start a job',async()=>{
  const {api,calls}=fixture();const store=memory();
  await runTaskBatch(api,store,'alice','chat',[plan('a')],'start',true);
  assert.deepEqual(calls,[['auto','a','chat']]);
  for(const action of ['discard','start']) {
    const result=await runTaskBatch(api,store,'alice','chat',[plan('a')],action);
    assert.equal(result.succeeded.length,0);assert.equal(result.failed.length,1);
  }
  assert.deepEqual(discardedPlans(store,'alice','chat'),[]);
});

test('batch approval failures preserve native reasons instead of object coercion',async()=>{
  const {api,calls}=fixture();
  api.approvalsGrant=async id=>{if(id==='stale') throw {code:'PLAN_STALE',message:'The plan changed or expired; review it again'}; return {approvalId:`approval-${id}`};};
  const result=await runTaskBatch(api,memory(),'alice','chat',[plan('stale'),plan('ok')],'start');
  assert.deepEqual(result.failed,[{planId:'stale',message:'计划已过期或图源配置已变化，请重新生成计划。'}]);
  assert.deepEqual(result.succeeded.map(item=>item.planId),['ok']);
  assert.deepEqual(calls.filter(item=>item[0]==='start').map(item=>item[1]),['ok']);
});
test('batch cancel only addresses selected jobs in cancellable stages',async()=>{
  const {api,calls,jobs}=fixture();jobs.set('a',job('a','downloading'));jobs.set('b',job('b','processing'));jobs.set('other',job('other','downloading'));
  const result=await runTaskBatch(api,memory(),'alice','chat',[plan('a'),plan('b')],'cancel');
  assert.deepEqual(calls,[['cancel','job-a']]);assert.equal(result.failed.length,1);
});
test('a pending discard wins over a queued model start, while an earlier start prevents discard',async()=>{
  const {api,jobs}=fixture();const store=memory();let unlock;
  const blocker=withPlanTaskLock('alice','chat','a',()=>new Promise(resolve=>{unlock=resolve;}));
  await Promise.resolve();
  const discard=runTaskBatch(api,store,'alice','chat',[plan('a')],'discard');
  const model=withPlanTaskLock('alice','chat','a',async()=>{assertPlanAvailable(store,'alice','chat','a');return api.jobsStartAuto('a','chat');});
  await Promise.resolve();unlock();await blocker;await discard;
  await assert.rejects(model,/PLAN_DISCARDED/);assert.equal(jobs.has('a'),false);
  const start=runTaskBatch(api,store,'alice','chat',[plan('b')],'start');
  const laterDiscard=runTaskBatch(api,store,'alice','chat',[plan('b')],'discard');
  assert.equal((await start).succeeded.length,1);assert.equal((await laterDiscard).failed.length,1);
});
