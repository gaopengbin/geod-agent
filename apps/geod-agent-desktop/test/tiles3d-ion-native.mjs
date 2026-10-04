// Real Cesium Ion acceptance using an existing native connection reference only.
// This script never accepts, reads, prints, exports, or deletes user credentials.
// Usage: rtk proxy node test/tiles3d-ion-native.mjs CONNECTION_ID [west,south,east,north]
// Native resource limits remain unchanged. The monitoring limits below cancel
// after observing excess; concurrent in-flight requests can exceed those limits.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const connectionId=process.argv[2];
if(!connectionId||! /^[0-9a-f-]{36}$/i.test(connectionId))throw Error('Provide a saved native connection ID; never supply a token');
const bounds=(process.argv[3]??'116.456,39.910,116.461,39.915').split(',').map(Number);
assert(bounds.length===4&&bounds.every(Number.isFinite)&&bounds[0]<bounds[2]&&bounds[1]<bounds[3],'Invalid WGS84 bounds');
assert(bounds[2]-bounds[0]<=0.02&&bounds[3]-bounds[1]<=0.02,'Acceptance area must be a small local extent (at most 0.02 degrees per axis)');
const timeoutMs=180000,maxObservedBytes=128*1024*1024,maxObservedResources=512;
const rpc=async(command,args={})=>{const response=await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args}),signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error(`Native adapter returned HTTP ${response.status}`);const result=await response.json();if(result.error)throw result.error;return result.value;};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const conversationId=`ion-buildings-${randomUUID()}`,workspace=resolve(root,'artifacts/desktop-parity',conversationId);
const evidencePath=resolve(root,'docs/implementation/evidence',`tiles3d-ion-native-${new Date().toISOString().slice(0,10)}.json`);
const checks=[],started=Date.now();let taskId,task,connection;
const evidence={pass:false,checkedAt:new Date().toISOString(),conversationId,connectionId,bounds,workspace,limits:{native:{concurrency:8,maxResources:100000,maxAssetBytes:256*1024*1024,maxTotalBytes:100*1024**3},monitoring:{timeoutMs,maxObservedBytes,maxObservedResources,mode:'cancel after observation; not a hard transfer cap'}},checks};
const hashFile=async(path)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
try{
  connection=(await rpc('tiles3d_connections_list')).find(connection=>connection.id===connectionId);
  assert(connection,'Connection does not exist for the signed-in native account');
  assert.equal(connection.kind,'cesiumIon','Use an existing Cesium Ion connection');assert.equal(connection.assetId,96188,'This acceptance targets Cesium OSM Buildings asset 96188');assert(connection.credentialReady,'Fill the connection credential in the native app first');
  evidence.assetId=connection.assetId;evidence.connectionRevision=connection.revision;
  await mkdir(workspace,{recursive:true});
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const plan=await rpc('data_download_plan',{conversationId,title:'北京 CBD · Cesium OSM Buildings 实测',idempotencyKey:randomUUID(),request:{kind:'tiles3d',spec:{connectionId,bounds}}});
  taskId=plan.id;evidence.taskId=taskId;
  assert.equal(plan.request.spec.connectionRevision,connection.revision);assert.deepEqual(plan.request.spec.bounds,bounds);checks.push('approved native plan binds existing connection revision and small Beijing range');
  await rpc('data_download_start_auto',{conversationId,taskId,planHash:plan.planHash});
  const deadline=Date.now()+timeoutMs;let lastLog=0;
  for(;;){
    task=await rpc('data_download_get',{conversationId,taskId});
    if(['completed','partial','failed','cancelled','discarded','interrupted'].includes(task.status))break;
    if(Date.now()>deadline||(task.progress?.bytes??0)>maxObservedBytes||(task.progress?.total??0)>maxObservedResources){
      evidence.monitorTriggered=true;await rpc('data_download_cancel',{conversationId,taskId});throw Error('Acceptance monitoring budget reached; cancellation requested');
    }
    if(Date.now()-lastLog>10000){console.log(JSON.stringify({state:task.status,completed:task.progress?.completed,total:task.progress?.total,bytes:task.progress?.bytes,elapsedSeconds:Math.round((Date.now()-started)/1000)}));lastLog=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(task.status,'completed',task.error??'Native download did not complete');
  const inspected=await rpc('data_download_inspect',{conversationId,taskId});const manifest=inspected.manifest;
  assert.equal(manifest.sourceFingerprint,createHash('sha256').update(`tiles3d:${connection.id}:${connection.revision}`).digest('hex'));assert.deepEqual(manifest.bounds,bounds);
  assert(manifest.resources.some(asset=>['gltf','glb','b3dm','pnts','i3dm','cmpt'].includes(asset.kind)),'No actual 3D content downloaded');
  assert(manifest.totalBytes>0);assert(manifest.resources.length<=maxObservedResources&&manifest.totalBytes<=maxObservedBytes,'Completed bundle exceeded this small acceptance budget');
  checks.push('real Ion native worker completed','offline manifest matches approved connection and extent','contains actual 3D content');
  const output=await realpath(inspected.outputDir);let bytes=0;
  for(const asset of manifest.resources){
    const path=await realpath(resolve(output,asset.path));const rel=relative(output,path);assert(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../'),'Bundle path escapes output');
    assert.equal((await stat(path)).size,asset.bytes);assert.equal(await hashFile(path),asset.sha256);bytes+=asset.bytes;
  }
  assert.equal(bytes,manifest.totalBytes);checks.push('independent file sizes and SHA256 match every manifest resource');
  evidence.pass=true;evidence.outputDirectory=inspected.outputDir;evidence.manifest=manifest;
  evidence.visualPreview='not evaluated by this script; inspect actual rendered Beijing buildings separately';
}catch(error){
  // Native errors are sanitized. Avoid raw objects/URLs in case a service error changes.
  const message=String(error?.message??error?.code??'Acceptance failed').replace(/https?:\/\/\S+/g,'[URL redacted]').slice(0,800);
  evidence.error={code:typeof error?.code==='string'?error.code:'ACCEPTANCE_FAILED',message};
  if(taskId){
    try{task=await rpc('data_download_get',{conversationId,taskId});if(['queued','downloading','verifying','cancelling'].includes(task.status)){await rpc('data_download_cancel',{conversationId,taskId});const deadline=Date.now()+35000;do{await new Promise(resolve=>setTimeout(resolve,500));task=await rpc('data_download_get',{conversationId,taskId});}while(['queued','downloading','verifying','cancelling'].includes(task.status)&&Date.now()<deadline);}}catch{}
  }
  evidence.finalState=task?.status;process.exitCode=1;
}finally{
  evidence.durationMs=Date.now()-started;await mkdir(dirname(evidencePath),{recursive:true});await writeFile(evidencePath,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({pass:evidence.pass,taskId,resources:evidence.manifest?.resources?.length,bytes:evidence.manifest?.totalBytes,error:evidence.error,finalState:evidence.finalState,evidencePath}));
}
