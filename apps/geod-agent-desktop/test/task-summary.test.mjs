import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTasks, taskGroupTarget } from '../src/task-summary.ts';
const task = (id,state='pending') => ({stored:{planId:id},state,job:null});
test('Scheduled templates are distinguished from confirmation and finished work',()=>{const summary=summarizeTasks([task('timer','scheduled')]);assert.equal(summary.status,'已设定时');assert.equal(summary.kind,'scheduled');assert.equal(summary.counts.pending,0);assert.equal(summary.counts.ended,0);});

test('pending status follows current confirmation mode; interruption and cancellation remain distinct',()=>{
  assert.equal(summarizeTasks([task('p')],'confirmEach').status,'待确认');
  assert.equal(summarizeTasks([task('p')],'fullAccess').status,'待执行');
  assert.equal(summarizeTasks([task('p','interrupted')]).status,'已中断');
  assert.equal(summarizeTasks([task('p','cancelled')]).status,'已取消');
  assert.equal(summarizeTasks([{...task('p','downloading'),connectionError:'offline'}]).status,'状态同步中断');
});
test('batch summaries count mixed native states and prioritize work requiring attention',()=>{
  const summary=summarizeTasks([task('p'),task('r','downloading'),task('q','queued'),task('i','interrupted'),task('c','completed'),task('d','discarded')],'confirmEach');
  assert.deepEqual(summary.counts,{pending:1,running:2,attention:1,ended:2});
  assert.equal(summary.kind,'attention');
  assert.equal(summary.status,'需处理 1 · 待确认 1 · 进行中 2 · 已结束 2');
  assert.equal(summarizeTasks(Array.from({length:32},(_,i)=>task(String(i))),'confirmEach').status,'待确认 32');
});
test('opening a batch chooses an unfinished member and never selects a different batch',()=>{
  const tasks=[task('old'),task('one','completed'),task('two'),task('three','downloading')];
  assert.equal(taskGroupTarget(tasks,['one','two','three'],'one').stored.planId,'two');
  assert.equal(taskGroupTarget(tasks,['one','two','three'],'three').stored.planId,'three');
  assert.equal(taskGroupTarget(tasks,['two','two','unknown'],'old').stored.planId,'two');
  assert.equal(taskGroupTarget(tasks,['unknown'],'old'),undefined);
});
test('completed-only batches can still open their existing selection and historical detail',()=>{
  const tasks=[task('one','discarded'),task('two','completed')];
  assert.equal(taskGroupTarget(tasks,['one','two'],'two').stored.planId,'two');
  assert.equal(taskGroupTarget(tasks,['one','two']).stored.planId,'one');
});
