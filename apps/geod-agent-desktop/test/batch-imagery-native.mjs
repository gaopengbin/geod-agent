// Real native IPC, bundled administrative geometry and Esri network downloads.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const rpc = async(command,args={}) => {
  const response=await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});
  const result=await response.json(); if(result.error) throw result.error; return result.value;
};
const conversationId=randomUUID(),workspace=join(tmpdir(),`geod-batch-${conversationId}`);
mkdirSync(workspace,{recursive:true});
await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const source=(await rpc('sources_list')).find(source=>source.id==='esri-world-imagery');assert(source,'Registered Esri imagery required');
const neighbors=await rpc('source_creator_call',{toolName:'lookup_neighbors',arguments:{query:'驻马店市'}});
assert.deepEqual(neighbors.neighbors.map(item=>item.name).sort(),['阜阳市','平顶山市','漯河市','南阳市','信阳市','周口市'].sort());
const inputs=await rpc('test_boundary_tool',{conversationId,tool:'lookup_boundaries',arguments:{queries:['驻马店市',...neighbors.neighbors.map(item=>item.adcode)]}});
assert.equal(inputs.foundCount,7);assert.equal(inputs.items.length,7);assert(inputs.items.every(item=>item.boundaryId&&!item.geometry&&!item.boundary));
const ids=inputs.items.map(item=>item.boundaryId);
assert.equal((await rpc('boundaries_list',{conversationId})).length,7);
const executionId=`batch-test:${randomUUID()}`,args={sourceId:source.id,boundaryIds:ids,zoom:8,outputFormats:['geotiff']};
const split=await rpc('test_imagery_plan',{conversationId,executionId:executionId+':split',arguments:{...args,mode:'split'},batch:true});
assert.equal(split.errors.length,0);assert.equal(split.plans.length,7);
const replay=await rpc('test_imagery_plan',{conversationId,executionId:executionId+':split',arguments:{...args,mode:'split'},batch:true});
assert.deepEqual(replay.plans.map(item=>item.stored.planId),split.plans.map(item=>item.stored.planId));
assert.deepEqual(replay.plans.map(item=>item.stored.plan.spec.outputDirectory),split.plans.map(item=>item.stored.plan.spec.outputDirectory));
assert.equal(new Set(split.plans.map(item=>item.stored.plan.spec.outputDirectory)).size,7);
const merge=await rpc('test_imagery_plan',{conversationId,executionId:executionId+':merge',arguments:{...args,mode:'merge',name:'驻马店及周边六市'},batch:true});
assert.equal(merge.errors.length,0);assert.equal(merge.plans.length,1);assert.equal(merge.plans[0].rangeName,'驻马店及周边六市');
const geometry=merge.plans[0].stored.plan.spec.boundary;
assert.equal(geometry.polygons.length,13);assert.equal(geometry.polygons.flat().reduce((n,ring)=>n+ring.length,0),35147);
const other=randomUUID();assert.equal((await rpc('boundaries_list',{conversationId:other})).length,0);
await assert.rejects(async()=>rpc('boundaries_get',{conversationId:other,boundaryId:ids[0]}));
await assert.rejects(async()=>rpc('test_imagery_plan',{conversationId,executionId:executionId+':invalid',arguments:{...args,boundaryIds:[ids[0],'missing'],mode:'split'},batch:true}));
const jobs=[];const started=Date.now();
for (const {stored,rangeName} of [...split.plans,...merge.plans]) {
  const job=await rpc('jobs_start_auto',{planId:stored.planId,conversationId,idempotencyKey:`${executionId}:${stored.planId}`});
  jobs.push({name:rangeName,planId:stored.planId,jobId:job.jobId,totalTiles:stored.plan.totalTiles});
}
const deadline=Date.now()+180000;
while(Date.now()<deadline) {
  const states=await Promise.all(jobs.map(job=>rpc('jobs_get',{jobId:job.jobId})));
  if(states.some(job=>['failed','cancelled','partial'].includes(job.state))) throw new Error(JSON.stringify(states.map(job=>({jobId:job.jobId,state:job.state}))));
  if(states.every(job=>job.state==='completed'))break;
  await new Promise(resolve=>setTimeout(resolve,500));
}
for (const job of jobs) {
  assert.equal((await rpc('jobs_get',{jobId:job.jobId})).state,'completed',job.name);
  const manifest=await rpc('artifacts_inspect',{jobId:job.jobId});assert.equal(manifest.quality.status,'complete');assert.equal(manifest.quality.missingTiles,0);
  const raster=await rpc('test_native_raster',{jobId:job.jobId});assert(raster.width>0&&raster.height>0);assert.equal(raster.dataTile.bandCount,5,'RGBA + OpenLayers generated validity mask');assert(raster.dataTile.nonzeroValues>0);
  Object.assign(job,{assets:manifest.assets.map(({id,kind,bytes,sha256})=>({id,kind,bytes,sha256})),raster});
}
const report={verifiedAt:new Date().toISOString(),conversationId,workspace,zoom:8,sourceId:source.id,neighbors,inputs:inputs.items,mergedPolygons:13,mergedVertices:35147,downloadMs:Date.now()-started,jobs};
const reportPath='../../docs/implementation/evidence/batch-imagery-native-2026-10-02.json';writeFileSync(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify({pass:true,conversationId,workspace,regions:7,jobs:jobs.length,totalTiles:jobs.reduce((n,j)=>n+j.totalTiles,0),downloadMs:report.downloadMs,reportPath}));
