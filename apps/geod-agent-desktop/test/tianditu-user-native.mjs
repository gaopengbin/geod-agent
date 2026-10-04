// Real user-authorized Tianditu sample, secrets resolved only by native vault.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const r=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(r.error)throw r.error;return r.value;};
const conversationId=`tianditu-user-${crypto.randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);
mkdirSync(workspace,{recursive:true});await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const evidence={conversationId,workspace,checkedAt:new Date().toISOString(),previews:[]};
try{
 for(const sourceId of ['tianditu-img-w','tianditu-cia-w']){
  const image=await rpc('map_preview_tile',{sourceId,z:15,x:26977,y:12417});
  const bytes=Buffer.from(image,'base64');assert(bytes.length>100);
  const path=resolve(workspace,sourceId+'.png');writeFileSync(path,bytes);evidence.previews.push({sourceId,path,bytes:bytes.length});console.log(sourceId,'preview OK',bytes.length);
 }
 const planned=await rpc('test_imagery_plan',{conversationId,executionId:crypto.randomUUID(),batch:false,arguments:{sourceId:'tianditu-img-w',bounds:[116.39,39.90,116.40,39.91],zoom:15,outputFormats:['geotiff'],overlaySourceIds:['tianditu-cia-w']}});
 assert.equal(planned.errors.length,0,JSON.stringify(planned.errors));const stored=planned.plans[0].stored;evidence.plan=stored;
 const job=await rpc('jobs_start_auto',{conversationId,planId:stored.planId,idempotencyKey:crypto.randomUUID()});evidence.jobId=job.jobId;
 console.log('download started',job.jobId,stored.plan.totalTiles);
 let current;for(let n=0;n<180;n++){current=await rpc('jobs_get',{jobId:job.jobId});if(['completed','partial','failed','cancelled'].includes(current.state))break;await new Promise(r=>setTimeout(r,1000));}
 evidence.job=current;assert.equal(current.state,'completed',JSON.stringify(current));
 evidence.manifest=await rpc('artifacts_inspect',{jobId:job.jobId});assert.equal(evidence.manifest.quality.missingTiles,0);
 evidence.raster=await rpc('test_native_raster',{jobId:job.jobId});evidence.pass=true;
 console.log(JSON.stringify({pass:true,jobId:job.jobId,tiles:stored.plan.totalTiles,files:evidence.manifest.assets.length,quality:evidence.manifest.quality}));
}catch(error){evidence.pass=false;evidence.error=typeof error==='object'?{code:error.code,message:error.message}:String(error);console.log(JSON.stringify({pass:false,error:evidence.error}));process.exitCode=1;}
finally{writeFileSync('../../docs/implementation/evidence/tianditu-user-native-2026-10-02.json',JSON.stringify(evidence,null,2));}
