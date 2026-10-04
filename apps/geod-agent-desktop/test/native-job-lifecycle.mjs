import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const rpc=async(command,args={})=>{const value=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(value.error)throw value.error;return value.value;};
const path='../../docs/implementation/evidence/native-job-lifecycle-2026-10-02.json';
async function wait(jobId,state){const deadline=Date.now()+120000;while(Date.now()<deadline){const job=await rpc('jobs_get',{jobId}),active=await rpc('jobs_active');if(job.state===state&&!active.includes(jobId))return job;assert(!['failed','partial'].includes(job.state),JSON.stringify(job));await new Promise(r=>setTimeout(r,100));}throw new Error('Timeout waiting for '+state);}
if(process.argv.includes('--prepare')){
 const fixture=JSON.parse(readFileSync('test/batch-imagery-fixture.json','utf8')),conversationId=fixture.conversationId,range=(await rpc('boundaries_list',{conversationId})).find(item=>item.inputIds.length===7);assert(range);
 const records=[];
 for(const action of ['cancel','pause']){
  const plan=await rpc('test_imagery_plan',{conversationId,executionId:`lifecycle:${randomUUID()}`,batch:false,arguments:{sourceId:'esri-world-imagery',boundaryId:range.boundaryId,zoom:10,outputFormats:['geotiff']}});
  const stored=plan.plans[0].stored,job=await rpc('jobs_start_auto',{conversationId,planId:stored.planId,idempotencyKey:`lifecycle:${randomUUID()}`});
  const deadline=Date.now()+10000;let events=[];
  while(Date.now()<deadline){events=await rpc('jobs_events',{jobId:job.jobId,afterSeq:0});if(events.some(e=>(e.completedTiles??0)>0))break;await new Promise(r=>setTimeout(r,40));}
  assert(events.some(e=>(e.completedTiles??0)>0),'Actual tiles downloaded before '+action);
  await rpc(action==='cancel'?'jobs_cancel':'jobs_pause',{jobId:job.jobId});
  const stopped=await wait(job.jobId,action==='cancel'?'cancelled':'paused');
  events=await rpc('jobs_events',{jobId:job.jobId,afterSeq:0});const completedTiles=Math.max(...events.map(e=>e.completedTiles??0));
  records.push({action,jobId:job.jobId,planId:stored.planId,totalTiles:stored.plan.totalTiles,completedTiles,state:stopped.state,outputDirectory:stored.plan.spec.outputDirectory});
 }
 writeFileSync(path,JSON.stringify({preparedAt:new Date().toISOString(),conversationId,records},null,2));console.log(JSON.stringify(records));
}else{
 const report=JSON.parse(readFileSync(path,'utf8')),paused=report.records.find(r=>r.action==='pause'),cancelled=report.records.find(r=>r.action==='cancel');
 assert.equal((await rpc('jobs_get',{jobId:cancelled.jobId})).state,'cancelled');
 assert.equal((await rpc('jobs_get',{jobId:paused.jobId})).state,'paused');assert(!(await rpc('jobs_active')).includes(paused.jobId));
 const resumed=await rpc('jobs_resume',{jobId:paused.jobId});assert.equal(resumed.jobId,paused.jobId);await wait(paused.jobId,'completed');
 const manifest=await rpc('artifacts_inspect',{jobId:paused.jobId}),raster=await rpc('test_native_raster',{jobId:paused.jobId});assert.equal(manifest.quality.status,'complete');assert.equal(manifest.quality.missingTiles,0);assert(raster.dataTile.nonzeroValues>0);
 const events=await rpc('jobs_events',{jobId:paused.jobId,afterSeq:0});assert(events.some(e=>e.state==='queued'&&e.seq>1));
 Object.assign(report,{recoveredAt:new Date().toISOString(),pass:true,resumedSameJob:true,retainedDownloadedTiles:paused.completedTiles,quality:manifest.quality,raster});writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify({pass:true,retainedDownloadedTiles:paused.completedTiles,totalTiles:paused.totalTiles}));
}
