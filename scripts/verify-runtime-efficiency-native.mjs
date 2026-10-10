// Exercises the actual development WebView, Rust bridge and bundled Codex.
// The model supplier is a loopback fixture; hosted credit is never requested.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {PRODUCT_IDENTITY} from '../apps/geod-agent-desktop/src-tauri/model-input-context.mjs';

const output=resolve(process.argv[4]??'artifacts/runtime-efficiency-20261010/native-download');mkdirSync(output,{recursive:true});
const mode=process.argv[2]??'status',port=Number(process.argv[3]??9257);
const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const candidates=pages.filter(p=>p.type==='page'&&p.url==='http://127.0.0.1:1420/');assert.equal(candidates.length,1);
const socket=new WebSocket(candidates[0].webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
let serial=0;const pending=new Map();
socket.addEventListener('message',e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){clearTimeout(p.timer);pending.delete(v.id);v.error?p.reject(new Error(v.error.message)):p.resolve(v.result);}});
socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Development WebView closed'));}pending.clear();});
async function evaluate(fn,args={}){const result=await new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native QA evaluation timed out'));},120000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:`(${fn.toString()})(${JSON.stringify(args)})`,awaitPromise:true,returnByValue:true}}));});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
async function rpc(command,args={}){const result=await evaluate(async p=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(p.command,p.args)};}catch(error){return{error};}},{command,args});if(result.error)throw Object.assign(new Error(result.error.message??JSON.stringify(result.error)),result.error);return result.value;}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function state(){const raw=await evaluate(async()=>{
 const {api}=await import('/src/api.ts'),{localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
 const auth=await api.authStatus(),background=await api.backgroundStatus(),jobs=await api.jobsList();
 const active=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')??null;
 const execution=active?await api.codexConversationStatus(active):null;
 const wallet=(await api.agentPaymentSnapshot()).wallet;
 const channels=await window.__TAURI_INTERNALS__.invoke('ai_channels_list');
 return{accountId:auth.userId,background,active,execution,stopVisible:!!document.querySelector('button[aria-label="停止回复"]'),records:localStateEntries().filter(([key])=>key.startsWith('geod-agent-chat-0.1')||key.startsWith('geod-agent-conversations-0.1')||key.startsWith('geod-map-session-1:')),jobs:jobs.map(j=>({jobId:j.jobId,state:j.state})),balance:wallet?.balanceNanoCny,channels:{default:channels.default,ids:channels.channels.map(c=>c.id).sort()}};
 });return{...raw,accountId:hash(raw.accountId),mapCommands:raw.records.filter(([key])=>key.startsWith('geod-map-session-1:')).map(([key,value])=>[key,hash(JSON.parse(value).commands)]).sort(([a],[b])=>a.localeCompare(b)),records:raw.records.map(([key,value])=>[key,hash(value)]).sort(([a],[b])=>a.localeCompare(b)),checkedAt:new Date().toISOString()};}
function preserved(current,before){
 assert.equal(current.accountId,before.accountId);assert.equal(current.active,before.active);
 const chats=s=>s.records.filter(([key])=>!key.startsWith('geod-map-session-1:'));
 assert.deepEqual(chats(current),chats(before));assert.deepEqual(current.records.map(([key])=>key),before.records.map(([key])=>key));
 if(before.mapCommands)assert.deepEqual(current.mapCommands,before.mapCommands);
 assert.deepEqual(current.jobs.filter(job=>!report.testJobs?.includes(job.jobId)),before.jobs);assert.deepEqual(current.channels,before.channels);assert.equal(current.balance,before.balance);
}
function idle(s){assert(!s.stopVisible&&!s.execution?.busy&&!s.background.activeAiTurns&&!s.background.activeCommands&&!s.background.activeDownloads&&!s.background.maintenanceActive,'Existing user work must be idle');}
const report={passed:false,cases:[]};
function record(name,details={}){report.cases.push({name,passed:true,...details});writeFileSync(join(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true,...details}));}
let server,channelId,originalDefault;const conversations=[];
try{
 const readyBy=Date.now()+15000;
 while(!await evaluate(()=>location.origin==='http://127.0.0.1:1420'&&document.readyState!=='loading'&&!!window.__TAURI_INTERNALS__&&!!document.getElementById('root')?.childElementCount)){
  if(Date.now()>readyBy)throw new Error('Development WebView did not finish loading');
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 if(mode==='before'){
  const current=await state();idle(current);writeFileSync(join(output,'before.json'),JSON.stringify(current,null,2));console.log(JSON.stringify({idle:true,background:current.background,active:current.active,records:current.records.length,balance:current.balance}));
 }else if(mode==='status'){
  const current=await state();idle(current);const before=JSON.parse(readFileSync(join(output,'before.json'),'utf8'));
  preserved(current,before);
  writeFileSync(join(output,'after-restart.json'),JSON.stringify(current,null,2));console.log(JSON.stringify({restored:true,background:current.background,records:current.records.length,balance:current.balance}));
 }else if(mode==='test'){
  const before=await state();idle(before);originalDefault=before.channels.default;const scenarios=new Map();let activeScenario;
  server=createServer(async(req,res)=>{
   try{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);const scenario=scenarios.get(activeScenario);assert(scenario);scenario.requests.push(body);const step=scenario.steps[scenario.requests.length-1];assert(step,'Unexpected extra model request');
    if(step.before)await step.before();const message=typeof step.message==='function'?step.message(body):step.message;
    const id='native-qa-'+randomUUID();
    const chunk=(delta,finish_reason=null,usage)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'runtime-policy-fixture',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
    const delta={role:'assistant',...message};
    if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((call,index)=>{const matches=(body.tools??[]).filter(t=>t.function?.name===call.function.name||t.function?.name.endsWith('__'+call.function.name));assert.equal(matches.length,1,'Fixture call must use the current native callable name: '+call.function.name);return{...call,index,function:{...call.function,name:matches[0].function.name}};});
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
    chunk(delta);chunk({},message.tool_calls?.length?'tool_calls':'stop',{prompt_tokens:10,completion_tokens:5,total_tokens:15});res.end('data: [DONE]\n\n');
   }catch(error){report.providerError=String(error.stack??error);res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:{message:String(error.message)}}));}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const profile=await rpc('ai_channel_save',{draft:{name:'运行规则本地验收（临时）',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'chatCompletions',enabled:true,apiKey:'local-unpaid-fixture',models:[{id:'runtime-policy-fixture',name:'Local deterministic fixture',contextWindow:128000,maxOutputTokens:4096,inputModalities:['text'],thinking:'disabled'}]}});channelId=profile.id;
  async function prepare(){const id=randomUUID();conversations.push(id);const directory=join(output,'workspace-'+id);mkdirSync(directory);await rpc('workspace_set',{conversationId:id,directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:id,channelId,modelId:'runtime-policy-fixture'});await rpc('ai_model_select',{conversationId:'default',...originalDefault});return{id,directory};}
  const call=(name,args,id=randomUUID())=>({content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  async function run(name,conversation,steps,{answers={},failures={},input='请列出当前可用入口。'}={}){
   const scenario={steps,requests:[]};scenarios.set(name,scenario);activeScenario=name;
   const result=await evaluate(async p=>{
    const {runCodexTurn}=await import('/src/codex-client.ts'),{api}=await import('/src/api.ts');const events=[],tools=[],runId=crypto.randomUUID();
    let result;try{result=await runCodexTurn(runId,p.id,p.input,[],{
     onEvent:e=>events.push(e),onModel:()=>{},onGeneration:g=>events.push({type:'qa-generation',billingScope:g.billingScope,state:g.state}),
     onRequest:async()=>({decision:'decline'}),execute:async c=>{
      const name=c.function.name,args=JSON.parse(c.function.arguments||'{}');tools.push({name,args});
      if(name==='ask_user')return{result:{answers:p.answers,answeredBy:'user'}};
      if(p.failures[name])return{result:p.failures[name]};
      if(name==='sources_list')return{result:{sources:await api.sourcesList()}};
      if(name==='workspace_status')return{result:{workspace:await api.workspaceGet(p.id),milestone:tools.length}};
      if(name==='jobs_start'){const {startPlanJob}=await import('/src/job-start.ts');const started=await startPlanJob(api,args.planId,p.id,c.id);return{result:started.result};}
      if(name==='jobs_get')return{result:await api.jobsGet(args.jobId)};
      return{result:{error:'QA_EXECUTOR_TOOL_NOT_ALLOWED'}};
     },
    });}catch(error){return{qaError:{code:error?.code,message:error?.message??String(error),stack:error?.stack},tools,events};}return{result,tools,events};
   },{id:conversation.id,name,answers,failures,input});
   if(result.qaError)throw Object.assign(new Error(JSON.stringify(result.qaError)),{events:result.events,code:result.qaError.code});assert.equal(result.result.status,'completed',JSON.stringify(result.result));assert(result.events.filter(e=>e.type==='qa-generation').every(e=>e.billingScope==='personal'));return{...result,requests:scenario.requests};
  }

   const conversation=await prepare();
   const planned=await evaluate(async p=>{try{const {api}=await import('/src/api.ts');const sources=await api.sourcesList();const source=sources.find(s=>s.id==='wayback-63116');if(!source)throw new Error('Existing registered Wayback source is required');const stored=await api.plansCreate({schemaVersion:'0.1',kind:'imagery',sourceId:source.id,bounds:[116.381,39.911,116.392,39.918],zoomLevels:[16],outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326'},outputDirectory:p.directory+'\\native-export',limits:{maxTiles:100,maxDecodedRgbaBytes:100000000}},crypto.randomUUID(),p.id);return{planId:stored.planId,totalTiles:stored.plan.totalTiles};}catch(error){return{error};}},conversation);assert(!planned.error,JSON.stringify(planned));
   const nativeTool=(body,name)=>(body.tools??[]).find(t=>t.function?.name===name||t.function?.name.endsWith('__'+name));
   const verifiedReceipt=value=>{if(typeof value==='string'){try{return verifiedReceipt(JSON.parse(value));}catch{return null;}}if(!value||typeof value!=='object')return null;if(value.backgroundResult?.verified===true)return value.backgroundResult;for(const child of Object.values(value)){const found=verifiedReceipt(child);if(found)return found;}return null;};
   const normal=await run('native-download',conversation,[
    {message:body=>{assert(nativeTool(body,'jobs_start'));return call('jobs_start',{planId:planned.planId});}},
    {message:body=>{const receipt=verifiedReceipt(body);assert(receipt,'Next model round must receive an actual verified native receipt');assert.equal(receipt.state,'completed');const wire=JSON.stringify(body);assert(wire.includes('submitted-native-resources'));report.nativeReceipt=receipt;return{content:'本机已完成下载和成果核验，GeoTIFF 的坐标系为 EPSG:4326。'};}},
   ],{input:'下载已经确认的 Wayback 影像计划，Z16、GeoTIFF、EPSG:4326。其他参数不变。'});
   assert(normal.requests.every(body=>JSON.stringify(body).includes(PRODUCT_IDENTITY)));
   assert.equal(normal.tools.length,1);assert.equal(normal.tools[0].name,'jobs_start');assert.equal(normal.requests.length,2);
   const finished=await evaluate(async p=>{const {api}=await import('/src/api.ts');const job=await api.jobsForPlan(p.planId);return{job,manifest:await api.artifactsInspect(job.jobId)};},planned);
   report.testJobs=[finished.job.jobId];assert.equal(finished.job.state,'completed');assert.equal(finished.manifest.quality.status,'complete');assert.equal(finished.manifest.quality.missingTiles,0);
   assert(finished.manifest.assets.some(a=>a.kind==='raster'&&a.crs==='EPSG:4326'));assert(finished.manifest.assets.every(a=>a.bytes>0&&/^[a-f0-9]{64}$/i.test(a.sha256)));
   writeFileSync(join(output,'download-proof.json'),JSON.stringify({conversationId:conversation.id,plan:planned,...finished,events:normal.events},null,2));
   record('Actual Rust waiter completes a real GeoTIFF download with two model requests, no model polling and no bookkeeping call',{modelRequests:2,executorCalls:1,totalTiles:planned.totalTiles,jobId:finished.job.jobId,crs:'EPSG:4326',toolCounts:normal.requests.map(b=>b.tools?.length??0),supplierRequestBytes:normal.requests.map(b=>Buffer.byteLength(JSON.stringify(b))),paid:false});
   await rpc('workspace_set',{conversationId:conversation.id,directory:conversation.directory,permission:'confirmEach'});
   const resumed=await run('existing-approved-job',conversation,[
    {message:()=>call('jobs_get',{jobId:finished.job.jobId})},
    {message:body=>{const receipt=verifiedReceipt(body);assert.equal(receipt?.jobId,finished.job.jobId);assert.equal(receipt?.verified,true);return{content:'已有下载成果仍已完成，沿用 EPSG:4326，无需重复确认或重新下载。'};}}
   ],{input:'继续查看已确认任务的完成结果，保留原坐标系。'});
   assert.equal(resumed.requests.length,2);assert.equal(resumed.tools.length,1);assert.equal(resumed.tools[0].name,'jobs_get');assert.equal(resumed.result.threadId,normal.result.threadId);
   record('Confirm-each mode resumes the same real Core thread and reads a completed native task without resubmission or parameter re-confirmation',{modelRequests:2,executorCalls:1,threadPreserved:true,paid:false});
   await rpc('ai_channel_remove',{channelId});channelId=null;
   const final=await state();idle(final);preserved(final,before);
   record('Existing conversations, tasks, model selection and wallet survive restart and local verification',{records:final.records.length,balance:final.balance,paid:false});
   report.passed=true;writeFileSync(join(output,'acceptance.json'),JSON.stringify(report,null,2));
 }else throw new Error('Unknown QA mode');
}catch(error){report.error={message:error.message,stack:error.stack,code:error.code};writeFileSync(join(output,'acceptance.json'),JSON.stringify(report,null,2));throw error;}
finally{if(originalDefault)await rpc('ai_model_select',{conversationId:'default',...originalDefault}).catch(()=>{});if(channelId)await rpc('ai_channel_remove',{channelId}).catch(()=>{});if(server)await new Promise(r=>server.close(r));socket.close();}
