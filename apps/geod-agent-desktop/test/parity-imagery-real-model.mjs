// Actual bundled Codex/model, production planning, native downloads and file readback.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const r=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(r.error)throw r.error;return r.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const conversationId=`imagery-model-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);
mkdirSync(workspace,{recursive:true});await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const plans=[],jobs=[],calls=[],results=[];
const compact=stored=>({planId:stored.planId,planHash:stored.plan.planHash,sourceId:stored.plan.spec.sourceId,zoomLevels:stored.plan.spec.zoomLevels,outputFormats:stored.plan.spec.outputFormats,totalTiles:stored.plan.totalTiles,permission:'fullAccess',canStartWithoutPlanConfirmation:true});
async function execute(name,args,executionId) {
 if(name==='sources_list')return {sources:await rpc('sources_list')};
 if(name==='workspace_status')return {...await rpc('workspace_get',{conversationId}),permission:'fullAccess'};
 if(name==='extensions_list')return {...await rpc('extensions_list'),builtin:[await rpc('source_creator_tools')]};
 if(name==='skill_read')return rpc('skill_read',{name:args.name});
 if(name==='boundaries_list')return {boundaries:await rpc('boundaries_list',{conversationId})};
 if(name==='mcp_call') {
   assert.equal(args.connectorId,'builtin-source-creator');
   return {connectorId:args.connectorId,toolName:args.toolName,result:await rpc('source_creator_call',{toolName:args.toolName,arguments:args.arguments})};
 }
 if(name==='source_configure')return rpc('test_source_configure',args);
 if(name==='plan_imagery'||name==='plan_imagery_batch'){
   const result=await rpc('test_imagery_plan',{conversationId,executionId,arguments:args,batch:name.endsWith('_batch')});
   plans.push(...result.plans.map(p=>p.stored));
   return name.endsWith('_batch')?{plans:result.plans.map(p=>compact(p.stored)),errors:result.errors}:result.plans[0]?compact(result.plans[0].stored):{error:result.errors};
 }
 if(name==='plans_get'){assert(plans.some(p=>p.planId===args.planId));return compact(await rpc('plans_get',args));}
 if(name==='jobs_start'){
   assert(plans.some(p=>p.planId===args.planId));const job=await rpc('jobs_start_auto',{conversationId,planId:args.planId,idempotencyKey:executionId});jobs.push(job);return {...job,background:true};
 }
 if(name==='jobs_list')return {jobs:await Promise.all(jobs.map(j=>rpc('jobs_get',{jobId:j.jobId})))};
 if(name==='jobs_get'){assert(jobs.some(j=>j.jobId===args.jobId));return rpc('jobs_get',args);}
 if(name==='jobs_events')return {events:await rpc('jobs_events',args)};
 if(name==='artifacts_inspect')return rpc('artifacts_inspect',args);
 if(name.startsWith('cache_')||name==='imagery_recovery_plan')return rpc('test_domain_tool',{conversationId,tool:name,arguments:args,executionId});
 throw new Error(`Unexpected tool ${name}`);
}
async function turn(input){
 const runId=randomUUID(),started=Date.now();await rpc('test_codex_start',{runId,conversationId,input});
 try {
  while(Date.now()-started<240000){
   const state=await rpc('test_codex_poll',{runId});
   for(const event of state.events??[]){
    if(event.type==='request')throw new Error(`Unexpected native request ${event.method}`);
    if(event.type!=='tool')continue;
    let result;try{result=await execute(event.tool,event.arguments,`${runId}:${event.requestId}`);}catch(e){result={error:typeof e==='object'?e:String(e)};}
    calls.push({tool:event.tool,arguments:event.arguments,result});console.log(`TOOL ${event.tool}${result.error?' ERROR':''}`);
    await rpc('codex_command',{runId,command:{type:'response',requestId:event.requestId,value:{result}}});
   }
   if(state.done){assert(!state.error,JSON.stringify(state.error));assert.equal(state.value.status,'completed');results.push({input,answer:state.value.text,durationMs:Date.now()-started});return;}
   await sleep(200);
  }
  throw new Error('Real model timeout');
 }catch(e){await rpc('codex_command',{runId,command:{type:'interrupt'}}).catch(()=>{});throw e;}
}
await turn('请实际下载两个独立的小成果到当前完全访问工作区，范围都用 [116.38,39.89,116.40,39.91]。第一项用已登记的 Esri World Imagery，Z10–11 两个级别，合成已登记的 Esri 影像注记，输出 GeoTIFF、MBTiles、PNG、JPEG、GeoPackage、原始瓦片，开启 deflate、金字塔、辅助坐标文件，JPEG质量90。第二项用已登记的 Terrarium DEM，Z10，输出以米为值的单波段 Float32 GeoTIFF。先检查图源，再生成并启动这两项任务；启动后交给后台，简短报告。不要运行脚本代替工具，不要反复轮询。');
assert.equal(jobs.length,2,JSON.stringify(calls));
const records=[];
for(const job of jobs){
 const until=Date.now()+150000;let current;
 do{current=await rpc('jobs_get',{jobId:job.jobId});if(['completed','partial','failed','cancelled'].includes(current.state))break;await sleep(300);}while(Date.now()<until);
 assert.equal(current.state,'completed',JSON.stringify(current));
 const manifest=await rpc('artifacts_inspect',{jobId:job.jobId});assert.equal(manifest.quality.status,'complete');
 const plan=plans.find(p=>p.planId===job.planId);records.push({job:current,plan,manifest,raster:await rpc('test_native_raster',{jobId:job.jobId})});
}
const imagery=records.find(r=>r.plan.plan.spec.outputFormats.length===6),dem=records.find(r=>r.plan.plan.spec.exportOptions?.elevationEncoding==='terrarium');
assert(imagery&&dem);assert.deepEqual(imagery.plan.plan.spec.zoomLevels,[10,11]);assert.equal(imagery.plan.plan.spec.exportOptions.overlaySources.length,1);assert.equal(dem.raster.dataTile.bandCount,2);
await turn(`刚才的两项后台任务已经结束，请通过工具核验这两个实际作业的成果，并简短说明完成情况和DEM数值单位。作业ID：${jobs.map(j=>j.jobId).join('、')}。`);
assert(calls.filter(c=>c.tool==='artifacts_inspect').length>=2);
writeFileSync('../../docs/implementation/evidence/imagery-real-model-2026-10-02.json',JSON.stringify({pass:true,conversationId,workspace,model:'deepseek-flash',results,calls,records},null,2));
console.log(JSON.stringify({pass:true,jobs:records.map(r=>({id:r.job.jobId,files:r.manifest.assets.length})),tools:calls.map(c=>c.tool),answers:results.map(r=>r.answer)}));
