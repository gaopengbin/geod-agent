import test from 'node:test';import assert from 'node:assert/strict';
import {recoverPlanReferences,planRecoveryNotice,isPlanRecoveryNotice,planRecoveryProblem,recoveryFailure,loadHistoryWorkspace} from '../src/plan-reference-recovery.ts';
const missing=id=>({planId:id,code:'PLAN_NOT_FOUND',message:'计划不存在'});
test('missing historical references leave the active list without erasing their recovery index',()=>{
 const report={bound:[],rejected:Array.from({length:6},(_,i)=>missing('old-'+i))};
 const current={planId:'old-5',planIds:report.rejected.map(r=>r.planId)};
 const next=recoverPlanReferences(current,report);assert.deepEqual(next.planIds,[]);assert.equal(next.planId,undefined);assert.equal(next.unavailablePlanIds.length,6);assert.equal(planRecoveryNotice(report),'6 项历史任务需要检查，可打开恢复入口处理。');
 assert.deepEqual(recoverPlanReferences(next,report),next);assert.equal(current.planIds.length,6);
});
test('available and newly created tasks survive, and restored records become usable again',()=>{
 const next=recoverPlanReferences({planId:'missing',planIds:['existing','missing','new'],unavailablePlanIds:['restored']},{bound:['existing','restored','unrequested'],rejected:[missing('missing'),missing('foreign')]});
 assert.deepEqual(next.planIds,['existing','new','restored']);assert.equal(next.planId,'restored');assert.deepEqual(next.unavailablePlanIds,['missing']);
});
test('a storage failure never removes references and yields only one actionable notice',()=>{
 const report={bound:[],rejected:['a','b'].map(planId=>({planId,code:'STORAGE_ERROR',message:'internal SQLite stack'}))};
 assert.deepEqual(recoverPlanReferences({planId:'b',planIds:['a','b']},report).planIds,['a','b']);assert.equal(planRecoveryNotice(report),'2 项历史任务需要检查，可打开恢复入口处理。');
 assert(isPlanRecoveryNotice('部分旧任务未能关联到当前工作区：计划不存在；计划不存在'));assert(!isPlanRecoveryNotice('模型连接中断'));
});
test('a missing workspace never returns the fallback folder for persistence',async()=>{
 const current={workspaceDirectory:'G:/original',messages:['retained'],planIds:['old']};
 await assert.rejects(async()=>{const result=await loadHistoryWorkspace(async()=>({directory:'C:/fallback'}),async()=>{throw {code:'WORKSPACE_NOT_BOUND'};},current.planIds,current.workspaceDirectory);current.workspaceDirectory=result.workspace.directory;},e=>e.code==='WORKSPACE_NOT_BOUND');
 assert.equal(current.workspaceDirectory,'G:/original');assert.deepEqual(current.messages,['retained']);
 await assert.rejects(loadHistoryWorkspace(async()=>({directory:'C:/fallback'}),async()=>{assert.fail('No plans to claim');},[],current.workspaceDirectory),e=>e.code==='WORKSPACE_NOT_BOUND');
});
test('new chats stay quiet and canonical Windows paths retain their original workspace',async()=>{
 const empty=await loadHistoryWorkspace(async()=>({directory:'C:/default'}),async()=>assert.fail('No historical plans'),[]);assert.deepEqual(empty.claim,{bound:[],rejected:[]});assert.equal(planRecoveryProblem(empty.claim),null);
 const known=await loadHistoryWorkspace(async()=>({directory:'\\\\?\\G:\\Original\\'}),async()=>assert.fail('No historical plans'),[],'g:/original');assert.equal(known.workspace.directory,'\\\\?\\G:\\Original\\');
 assert.deepEqual(recoveryFailure({code:'WORKSPACE_NOT_BOUND'},6),{count:6,codes:['WORKSPACE_NOT_BOUND']});
});
test('legacy snake-case reports are compatible and ownership failures never activate a task',()=>{
 const next=recoverPlanReferences({planIds:['x','y']},{bound:[],rejected:[{plan_id:'x',code:'PLAN_NOT_FOUND',message:'missing'},{planId:'y',code:'PLAN_NOT_OWNED',message:'owner'}]});assert.deepEqual(next.planIds,[]);assert.deepEqual(next.unavailablePlanIds,['x','y']);
});
