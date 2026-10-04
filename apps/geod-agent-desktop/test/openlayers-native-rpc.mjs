// Local integration-test adapter. No UI input, credentials, or external access.
// Proxies only the commands below to the running desktop's native IPC.
import {createServer} from 'node:http';
import {createReadStream,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
let page;
const readyDeadline=Date.now()+20000;
while(!page&&Date.now()<readyDeadline){
 try{const pages=await(await fetch('http://127.0.0.1:9233/json/list')).json();page=pages.find(item=>item.title==='GeoD Agent');}catch{/* Native desktop may still be starting. */}
 if(!page)await new Promise(resolve=>setTimeout(resolve,250));
}
if (!page) throw new Error('Start the desktop with WebView2 debug port 9233');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true}); });
let serial = 0;
const pending = new Map();
socket.addEventListener('message',event => {
 const value = JSON.parse(event.data);const request = pending.get(value.id);if (!request) return;
 pending.delete(value.id);clearTimeout(request.timer);
 value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result);
});
function evaluate(expression) { return new Promise((resolve,reject) => {
 const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native IPC timeout'));},150000);
 pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
}); }
const allowed = new Set(['auth_status','sources_list','sources_get','map_preview_tile','osm_basemap_tile','extensions_list','agent_generate','agent_usage','artifact_raster','jobs_list','jobs_get','artifacts_inspect','codex_command','mcp_tools','skill_read','workspace_get','data_input_read','data_connections_list','data_connection_save','data_connection_remove']);
const rasterFiles=new Map();
for (const command of ["tiles3d_connections_list","tiles3d_connection_prepare","tiles3d_connection_save","tiles3d_connection_remove","tiles3d_connection_test"]) allowed.add(command);
for (const command of ["cache_inventory","cache_maintenance_start","cache_maintenance_status","cache_maintenance_cancel","cache_relocation_preflight","cache_relocation_start"]) allowed.add(command);
for (const command of ['data_schedules_create','data_schedules_list','data_schedules_set_enabled','data_schedules_runs','data_schedules_cancel_run','imagery_plans_claim','imagery_recovery_plan']) allowed.add(command);
for (const command of ['network_get','network_set','data_asset_unregister']) allowed.add(command);
for (const command of ['data_download_plan','data_download_list','data_download_get','data_download_start','data_download_start_auto','data_download_cancel','data_download_discard','data_download_inspect','data_download_preview']) allowed.add(command);
for (const command of ['plans_create','plans_get','output_directory_suggest','workspace_set','data_connection_connect','data_layer_inspect']) allowed.add(command);
for (const command of ['boundaries_save','boundaries_list','boundaries_get','boundaries_combine','source_creator_call','source_creator_tools','plans_for_tool_execution','jobs_for_plan','jobs_start_auto','jobs_active','jobs_events','jobs_pause','jobs_cancel','jobs_resume']) allowed.add(command);
for (const command of ['schedules_create','schedules_list','schedules_runs','schedules_set_enabled','schedules_cancel_run','sources_save','workspace_gis_files_list','workspace_boundaries_list','approvals_grant','jobs_start']) allowed.add(command);
const server=createServer(async(req,res)=>{
 const origin=req.headers.origin;
 if(origin && origin!=='http://127.0.0.1:1420'){res.writeHead(403).end();return;}
 res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:1420');res.setHeader('Access-Control-Allow-Headers','content-type');
 res.setHeader('Access-Control-Expose-Headers','content-range,content-length,accept-ranges');
 if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
 if(req.url?.startsWith('/raster/') && req.method==='GET') {
  const path=rasterFiles.get(req.url.slice(8));if(!path){res.writeHead(404).end();return;}
  const size=statSync(path).size,match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
  const start=match?Number(match[1]):0,end=match?Math.min(Number(match[2]||size-1),size-1):size-1;
  if(start>=size || end<start){res.writeHead(416).end();return;}
  res.setHeader('Content-Type','image/tiff');res.setHeader('Accept-Ranges','bytes');
  if(match){res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);res.statusCode=206;}
  res.setHeader('Content-Length',end-start+1);createReadStream(path,{start,end}).pipe(res);return;
 }
 if(req.url!=='/rpc' || req.method!=='POST'){res.writeHead(404).end();return;}
 try{
  let body='';for await(const data of req)body+=data;
  if(body.length>48000000)throw new Error('Request too large');
  const {command,args}=JSON.parse(body);
  if(command==='test_boundary_tool') {
   const expression=`(async()=>{try{const {api}=await import('/src/api.ts');const {attachBoundaryLookup}=await import('/src/boundary-tools.ts');const raw=await api.sourceCreatorCall(${JSON.stringify(args.tool)},${JSON.stringify(args.arguments)});return await attachBoundaryLookup(${JSON.stringify(args.conversationId)},${JSON.stringify(args.tool)},raw,()=>{})}catch(error){throw new Error(error instanceof Error?error.message:JSON.stringify(error))}})()`;
   const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:result.result.value}));return;
  }
  if(command==='test_imagery_plan') {
   const expression=`(async()=>{const {planImagery}=await import('/src/imagery-planning.ts');return planImagery(${JSON.stringify(args.arguments)},${JSON.stringify(args.conversationId)},${JSON.stringify(args.executionId)},null,${!!args.batch})})()`;
   const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:result.result.value}));return;
  }
  if(command==='test_data_tool') {
   const expression=`(async()=>{const {executeDataInputTool}=await import('/src/data-input-tools.ts');let boundary=null;const result=await executeDataInputTool(${JSON.stringify(args.conversationId)},${JSON.stringify(args.tool)},${JSON.stringify(args.arguments)},{attach:value=>boundary=value});return {result,boundary}})()`;
   const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:result.result.value}));return;
  }
  if(command==='test_domain_tool') {
   const expression=`(async()=>{const name=${JSON.stringify(args.tool)},args=${JSON.stringify(args.arguments??{})},conversationId=${JSON.stringify(args.conversationId)},executionId=${JSON.stringify(args.executionId)};try {
    if(name.startsWith('tiles3d_connection')) {const {executeTiles3dConnectionTool}=await import('/src/data-connection-tools.ts');return {value:await executeTiles3dConnectionTool(name,args)}}
    if(name.startsWith('data_download_')) {const {executeDataDownloadTool}=await import('/src/data-download-tools.ts');return {value:await executeDataDownloadTool(conversationId,name,args,executionId)}}
    if(name.startsWith('data_schedules_')) {const {executeDataScheduleTool}=await import('/src/maintenance-tools.ts');return {value:await executeDataScheduleTool(conversationId,name,args,executionId)}}
    if(name.startsWith('cache_')) {const {executeCacheTool}=await import('/src/maintenance-tools.ts');return {value:await executeCacheTool(name,args)}}
    if(name==='imagery_recovery_plan') {const {planImageryRecovery}=await import('/src/imagery-recovery.tsx');return {value:await planImageryRecovery(conversationId,args.jobId,args.mode,executionId)}}
    throw new Error('Unknown production domain tool');
   }catch(error){return {error:error instanceof Error?{message:error.message}:error}}})()`;
   const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result.result.value));return;
  }
  if(command==='test_codex_start') {
   const expression=`(async()=>{const {api}=await import('/src/api.ts');const key=${JSON.stringify(args.runId)};window.__olTestTurns??={};const state={events:[],done:false};window.__olTestTurns[key]=state;api.codexTurn(key,${JSON.stringify(args.conversationId)},${JSON.stringify(args.input)},[],event=>state.events.push(event)).then(value=>{state.value=value;state.done=true},error=>{state.error=error instanceof Error?{message:error.message}:error;state.done=true});return true})()`;
   const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:true}));return;
  }
  if(command==='test_source_configure') {
   const expression=`(async()=>{const {sourceRegistrationDraft}=await import('/src/agent-workflow.ts');const {configureSource}=await import('/src/source-configuration.ts');const draft=sourceRegistrationDraft(${JSON.stringify(args)});return draft?configureSource(draft):{error:'INVALID_SOURCE_CONFIGURATION'}})()`;
   const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:result.result.value}));return;
  }
  if(command==='test_codex_poll') {
   const result=await evaluate(`(()=>{const state=window.__olTestTurns?.[${JSON.stringify(args.runId)}];if(!state)return {error:'No test turn'};return {events:state.events.splice(0),done:state.done,value:state.value,error:state.error}})()`);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:result.result.value}));return;
  }
  if(command==='test_native_raster') {
   const result=await evaluate(`(async()=>{const {checkRaster}=await import('/test/native-raster-check.ts');return checkRaster(${JSON.stringify(args.jobId)})})()`);
   if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:result.result.value}));return;
  }
  if(!allowed.has(command))throw new Error('Command not allowed');
  const expression=`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args??{})}).then(value=>({value}),error=>({error}))`;
  const result=await evaluate(expression);if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
  const value=result.result.value;
  if(command==='artifact_raster' && value.value){const token=randomUUID();rasterFiles.set(token,value.value.path);value.value.path=token;value.value.resourceId=token;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
 }catch(error){res.writeHead(500).end(JSON.stringify({error:String(error)}));}
});
server.listen(1421,'127.0.0.1',()=>console.log('Native MCP integration adapter ready on localhost:1421'));
socket.addEventListener('close',()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Native desktop closed'));}pending.clear();server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{server.close();socket.close();});
