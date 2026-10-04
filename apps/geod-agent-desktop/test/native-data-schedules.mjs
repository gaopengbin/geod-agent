// Native clock, SQLite scheduler and real public MVT download; no mocked timer.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const response=await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});const result=await response.json();if(result.error)throw result.error;return result.value;};
const conversationId=`data-schedule-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);mkdirSync(workspace,{recursive:true});
const records=[],checks=[];
await rpc('workspace_set',{conversationId,directory:workspace,permission:'confirmEach'});
const request={kind:'vector',spec:{source:{type:'mvt',id:'maplibre-demo-countries',name:'MapLibre 国家矢量',urlTemplate:'https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf',scheme:'xyz',layers:[]},bounds:[13.404,52.52,13.406,52.522],zoomLevels:[2],outputs:['geojson','gpkg']}};
const template=await rpc('data_download_plan',{conversationId,title:'柏林矢量定时模板',idempotencyKey:randomUUID(),request});
const waitRun=async(scheduleId,predicate,timeout=90000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const runs=await rpc('data_schedules_runs',{conversationId}),run=runs.find(r=>r.scheduleId===scheduleId);if(run&&predicate(run)){return run;}await new Promise(r=>setTimeout(r,400));}throw Error(`Schedule timeout: ${scheduleId}`);};
const create=async(name,delay=2)=>rpc('data_schedules_create',{conversationId,taskId:template.id,name,nextRunAt:new Date(Date.now()+delay*1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});
try {
  const once=await create('逐次确认定时测试');
  const waiting=await waitRun(once.id,r=>r.state==='waiting_confirmation');
  const pending=await rpc('data_download_get',{conversationId,taskId:waiting.taskId});
  assert.equal(pending.status,'pending');assert.notEqual(pending.outputDir,template.outputDir);checks.push('real timer creates separate pending task under confirmEach');
  const denied=async(command,args,code)=>assert.rejects(()=>rpc(command,args),e=>e.code===code);
  await denied('data_download_start_auto',{conversationId,taskId:pending.id,planHash:pending.planHash},'APPROVAL_REQUIRED');
  await rpc('data_schedules_cancel_run',{runId:waiting.id});
  assert.equal((await rpc('data_download_get',{conversationId,taskId:pending.id})).status,'cancelled');checks.push('cancels waiting occurrence and its task');
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const full=await create('完全访问实际定时下载');
  const succeeded=await waitRun(full.id,r=>r.state==='succeeded');
  const result=await rpc('data_download_inspect',{conversationId,taskId:succeeded.taskId});
  assert.equal(result.manifest.featureCount,1);assert.notEqual(result.outputDir,pending.outputDir);records.push({schedule:full,run:succeeded,task:result});checks.push('real timer starts public download with full access');
  const paused=await create('暂停触发测试',2);await rpc('data_schedules_set_enabled',{scheduleId:paused.id,enabled:false});
  await new Promise(r=>setTimeout(r,5000));assert(!(await rpc('data_schedules_runs',{conversationId})).some(r=>r.scheduleId===paused.id));checks.push('disabled schedule never fires');
  const revoked=await create('动态权限降级测试',3);await rpc('workspace_set',{conversationId,directory:workspace,permission:'confirmEach'});
  const blocked=await waitRun(revoked.id,r=>r.state==='waiting_confirmation');assert.equal((await rpc('data_download_get',{conversationId,taskId:blocked.taskId})).status,'pending');await rpc('data_schedules_cancel_run',{runId:blocked.id});checks.push('permission re-read at occurrence dispatch');
  const bound=(await rpc('workspace_get',{conversationId})).directory;
  const changed=await create('工作区变更测试',3),another=resolve(workspace,'different');mkdirSync(another);
  await denied('workspace_set',{conversationId,directory:another,permission:'fullAccess'},'WORKSPACE_IMMUTABLE');
  const refused=await waitRun(changed.id,r=>r.state==='waiting_confirmation');assert.equal((await rpc('workspace_get',{conversationId})).directory,bound);await rpc('data_schedules_cancel_run',{runId:refused.id});checks.push('immutable workspace rejects relocation before scheduled write');
  records.push({schedule:once,run:waiting},{schedule:revoked,run:blocked},{schedule:changed,run:refused});
  const evidence={pass:true,conversationId,workspace,checks,records};writeFileSync(resolve('../../docs/implementation/evidence/data-schedules-native-2026-10-02.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({pass:true,checks,download:result.id,featureCount:result.manifest.featureCount}));
} finally {
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'confirmEach'});
  const schedules=await rpc('data_schedules_list',{conversationId});for(const schedule of schedules){await rpc('data_schedules_set_enabled',{scheduleId:schedule.id,enabled:false}).catch(()=>{});}
  for(const run of await rpc('data_schedules_runs',{conversationId})){if(['queued','waiting_confirmation','running','cancelling'].includes(run.state))await rpc('data_schedules_cancel_run',{runId:run.id}).catch(()=>{});}
}
