import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const conversationId=`connection-download-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);mkdirSync(workspace,{recursive:true});
let connection;
try{
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  connection=await rpc('tiles3d_connection_prepare',{draft:{name:'公开三维连接下载验收',kind:'direct',tilesetUrl:'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithRequestVolume/tileset.json',requiredHeaders:['Referer']}});
  connection=await rpc('tiles3d_connection_save',{connectionId:connection.id,headers:{Referer:'https://github.com/CesiumGS/3d-tiles-samples'}});
  const plan=await rpc('data_download_plan',{conversationId,title:'三维保存连接下载验收',idempotencyKey:randomUUID(),request:{kind:'tiles3d',spec:{connectionId:connection.id}}});
  await rpc('data_download_start_auto',{conversationId,taskId:plan.id,planHash:plan.planHash});
  let task;const deadline=Date.now()+180000;
  do{task=await rpc('data_download_get',{conversationId,taskId:plan.id});if(['completed','failed','cancelled'].includes(task.status))break;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
  assert.equal(task.status,'completed',task.error??'download deadline');
  const inspected=await rpc('data_download_inspect',{conversationId,taskId:plan.id});
  assert.equal(inspected.manifest.sourceFingerprint,createHash('sha256').update(`tiles3d:${connection.id}:${connection.revision}`).digest('hex'));
  assert(inspected.manifest.resources.length>1);assert(inspected.manifest.totalBytes>0);
  await rpc('tiles3d_connection_remove',{connectionId:connection.id});connection=null;
  const afterRemoval=await rpc('data_download_inspect',{conversationId,taskId:plan.id});assert.equal(afterRemoval.manifest.totalBytes,inspected.manifest.totalBytes);
  const evidence={pass:true,checkedAt:new Date().toISOString(),conversationId,taskId:plan.id,workspace,checks:['saved credential reference native worker path','real public 3D download with Referer connection','source fingerprint matches approved connection revision','verified offline bundle','artifact inspection remains available after credential connection removal'],manifest:inspected.manifest};
  writeFileSync(resolve('../../docs/implementation/evidence/tiles3d-connection-download-2026-10-02.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({pass:true,resources:inspected.manifest.resources.length,bytes:inspected.manifest.totalBytes,taskId:plan.id}));
}finally{if(connection)await rpc('tiles3d_connection_remove',{connectionId:connection.id}).catch(()=>{});}
