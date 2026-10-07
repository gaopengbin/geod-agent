// Verify the running desktop's actual IPC contract; never start a download.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

const output=resolve('../../artifacts/export-runtime-20261007'), directory=join(output,'workspace');
mkdirSync(directory,{recursive:true});
let target;
for(let i=0;i<80&&!target;i++){
  try{target=(await(await fetch('http://127.0.0.1:9233/json/list')).json()).find(p=>p.type==='page'&&p.url.includes(':1420'));}catch{}
  if(!target)await new Promise(r=>setTimeout(r,200));
}
assert(target,'Development desktop must actually be running');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
let serial=0;const pending=new Map();
socket.addEventListener('message',e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(new Error(v.error.message)):p.resolve(v.result);}});
async function evaluate(fn,args){
  const reply=await new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:`(${fn})(${JSON.stringify(args)})`,awaitPromise:true,returnByValue:true}}));});
  if(reply.exceptionDetails)throw new Error(reply.exceptionDetails.exception?.description??reply.exceptionDetails.text);
  return reply.result.value;
}
try{
  const result=await evaluate(async directory=>{
    const invoke=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
    const capabilities=await invoke('desktop_runtime_capabilities');
    const background=await invoke('background_status');
    const auth=await invoke('auth_status');
    if(auth.state!=='connected')throw new Error('Native account must be signed in');
    const sources=await invoke('sources_list');
    const source=sources.find(s=>s.displayName==='Esri World Imagery')??sources.find(s=>s.displayName?.includes('World Imagery'));
    if(!source)throw new Error('Existing imagery source is required');
    const conversationId=crypto.randomUUID();
    await invoke('workspace_set',{conversationId,directory,permission:'confirmEach'});
    const spec={schemaVersion:'0.1',kind:'imagery',sourceId:source.id,bounds:[116.37,39.97,116.42,40.01],zoomLevels:[18],outputFormats:['geotiff'],outputDirectory:directory+'/runtime-plan',limits:{maxTiles:10000,maxDecodedRgbaBytes:2147483648}};
    let missing;
    try{await invoke('plans_create',{spec,toolExecutionId:'native-crs-missing-'+crypto.randomUUID(),conversationId});}catch(e){missing=e?.code;}
    if(missing!=='OUTPUT_CRS_REQUIRED')throw new Error('Missing CRS was not rejected correctly: '+missing);
    await invoke('workspace_set_output_crs',{conversationId,crs:'EPSG:3857'});
    const inherited=await invoke('plans_create',{spec,toolExecutionId:'native-crs-default-'+crypto.randomUUID(),conversationId});
    await invoke('workspace_set_output_crs',{conversationId,crs:'EPSG:4326'});
    const explicit=await invoke('plans_create',{spec:{...spec,exportOptions:{targetCrs:'EPSG:3857',resampling:'nearest',compression:'none'}},toolExecutionId:'native-crs-explicit-'+crypto.randomUUID(),conversationId});
    const restored=await invoke('workspace_get',{conversationId});
    const jobs=await invoke('jobs_for_plan',{planId:explicit.planId});
    return {capabilities,background:{running:background.running,pid:background.pid,fingerprint:background.fingerprint},missingCrsError:missing,inheritedCrs:inherited.plan.spec.exportOptions.targetCrs,explicitCrs:explicit.plan.spec.exportOptions.targetCrs,defaultAfterOverride:restored.outputCrs,totalTiles:explicit.plan.totalTiles,downloadStarted:!!jobs,plans:[inherited.planId,explicit.planId],conversationId};
  },directory);
  assert.equal(result.capabilities.exportCrs,true);
  assert.deepEqual(result.capabilities.exportOptions,['targetCrs','resampling']);
  assert.equal(result.inheritedCrs,'EPSG:3857');
  assert.equal(result.explicitCrs,'EPSG:3857');
  assert.equal(result.defaultAfterOverride,'EPSG:4326');
  assert.equal(result.downloadStarted,false);
  const report={passed:true,actualNativeIpc:true,modelCalls:0,...result};
  writeFileSync(join(output,'native-acceptance.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{socket.close();}
