// Actual native channel/vault/companion acceptance using the shipped Codex engine.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const output=resolve(process.argv[2]??'artifacts/ai-channels-integration-20261004');mkdirSync(output,{recursive:true});
const providerKey=process.env.GEOD_QA_DEEPSEEK_KEY,relayKey=process.env.GEOD_QA_LITELLM_KEY,relayBase=process.env.GEOD_QA_LITELLM_BASE;
for(const key of ['GEOD_QA_DEEPSEEK_KEY','DEEPSEEK_API_KEY','GEOD_QA_LITELLM_KEY','LITELLM_MASTER_KEY'])delete process.env[key];
if(!providerKey||!relayKey||!relayBase)throw new Error('Process-only test configuration required');
const target=(await(await fetch('http://127.0.0.1:9233/json/list')).json()).find(p=>p.type==='page'&&p.url.includes('127.0.0.1:1420'));
if(!target)throw new Error('Development desktop is not available');
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
let serial=0;const pending=new Map();
socket.addEventListener('message',e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(new Error(v.error.message)):p.resolve(v.result);}});
async function evaluate(fn,args={}){
  const response=await new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:`(${fn.toString()})(${JSON.stringify(args)})`,awaitPromise:true,returnByValue:true}}));});
  if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text);return response.result.value;
}
const invoke=async(command,args={})=>{const value=await evaluate(async p=>{try{return await window.__TAURI_INTERNALS__.invoke(p.command,p.args);}catch(e){return{nativeError:{code:e?.code,message:e?.message??String(e)}};}},{command,args});if(value?.nativeError)throw Object.assign(new Error(value.nativeError.message),{code:value.nativeError.code});return value;};
const model=(id)=>({id,name:id,contextWindow:128000,maxOutputTokens:4096,inputModalities:['text'],thinking:'enabled'});
const profiles=[],cases=[];let original,activeBefore;
function record(name,details){cases.push({name,passed:true,...details});writeFileSync(join(output,'native-summary.json'),JSON.stringify({passed:false,inProgress:true,cases},null,2));console.log(JSON.stringify({name,passed:true}));}
function unwrap(value){if(value?.error)throw new Error(value.error.code??value.error);return value;}
async function save(draft){const p=await invoke('ai_channel_save',{draft});if(!profiles.includes(p.id))profiles.push(p.id);assert(!('apiKey'in p));assert(!('credentialRef'in p));return p;}
async function select(conversationId,channelId,modelId){return invoke('ai_model_select',{conversationId,channelId,modelId});}
async function read(profile,id,modelId,{spawn=false,edit=null}={}){
  await select(id,profile.id,modelId);
  return evaluate(async p=>{
    const {api}=await import('/src/api.ts'),{runCodexTurn}=await import('/src/codex-client.ts');
    const runId=crypto.randomUUID(),generations=[],tools=[],stream=[],handoffs=[];
    const result=await runCodexTurn(runId,p.id,'只调用一次 sources_list。最终仅返回 JSON 对象：count 为实际图源数量，names 为全部实际名称数组。不要运行命令或改地图。',[],{
      onEvent:e=>{if(e.type==='event'&&e.method.includes('delta'))stream.push(e.method);},onModel:()=>{},
      onGeneration:g=>generations.push({generationId:g.generationId,model:g.model,selectedModel:g.selectedModel,channelId:g.channelId,channelRevision:g.channelRevision,billingScope:g.billingScope,state:g.state,inputTokens:g.inputTokens,outputTokens:g.outputTokens}),
      onRequest:async()=>({decision:'decline'}),execute:async call=>{
        if(call.function.name!=='sources_list')return{result:{error:'QA_EXACT_TOOL_ONLY'}};
        const sources=await api.sourcesList();tools.push({tool:'sources_list',count:sources.length,names:sources.map(s=>s.displayName)});
        if(p.edit){await window.__TAURI_INTERNALS__.invoke('ai_channel_save',{draft:p.edit});p.edit=null;}
        if(p.spawn){
          const child=await window.__TAURI_INTERNALS__.invoke('agent_tasks_spawn',{conversationId:p.id,idempotencyKey:crypto.randomUUID(),draft:{name:'渠道快照 · 文件实测',prompt:'读取 input.txt 的全部实际文本，使用 worker_file_write 原样保存为 result.txt。再读取 result.txt 核对，并简短报告已保存。只做这项任务。',inputFiles:['input.txt'],readOnly:false}});
          const schedule=await api.aiSchedulesCreate(p.id,'渠道快照 · 定时实测','只调用一次 sources_list，最终仅返回 JSON：count 为实际图源数量，names 为全部图源实际名称。不要运行命令或修改任何配置。',new Date(Date.now()+30000).toISOString(),null,crypto.randomUUID());
          handoffs.push({child,schedule});p.spawn=false;
        }
        return{result:{sources:sources.map(s=>({id:s.id,name:s.displayName,minZoom:s.minZoom,maxZoom:s.maxZoom}))}};
      }
    });
    const receipt=await window.__TAURI_INTERNALS__.invoke('billing_run_snapshot',{runId});
    return{result,generations,tools,streamingDeltas:stream.length,handoffs,receipt};
  },{id,spawn,edit});
}
function checkRead(value,expectedModel,revision){
  assert.equal(value.result.status,'completed');assert.equal(value.tools.length,1);assert(value.streamingDeltas>0);assert(value.generations.length>=2);
  assert(value.generations.every(g=>g.state==='settled'&&g.billingScope==='personal'&&g.selectedModel===expectedModel&&(!revision||g.channelRevision===revision)));
  const answer=JSON.parse(value.result.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));assert.equal(answer.count,value.tools[0].count);assert.deepEqual([...new Set(answer.names)].sort(),[...new Set(value.tools[0].names)].sort());
}
async function waitTask(id,taskId){
  const limit=Date.now()+180000;while(Date.now()<limit){const value=unwrap(await invoke('agent_tasks_get',{conversationId:id,taskId}));if(!['queued','running'].includes(value.task.status))return value;await new Promise(r=>setTimeout(r,1500));}throw new Error('Native child task timed out');
}
async function waitSchedule(id,scheduleId){
  const limit=Date.now()+180000;while(Date.now()<limit){const overview=unwrap(await invoke('ai_schedules_list',{conversationId:id}));const run=overview.runs.find(r=>r.scheduleId===scheduleId);if(run&&!['queued','running'].includes(run.state))return unwrap(await invoke('ai_schedules_run_events',{runId:run.runId}));await new Promise(r=>setTimeout(r,1500));}throw new Error('Native schedule timed out');
}
try{
  original=(await invoke('ai_channels_list')).default;
  activeBefore=await evaluate(()=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id'));
  const base={name:'接入验收 · DeepSeek',baseUrl:'https://api.deepseek.com/v1',protocol:'chatCompletions',enabled:true,models:[model('deepseek-flash'),model('deepseek-v4-pro')]};
  if(!process.argv.includes('--remaining-only')){
  const direct=await save({...base,apiKey:providerKey});
  const catalogue=await invoke('ai_channel_models',{channelId:direct.id});assert(catalogue.models.some(m=>m.id==='deepseek-flash'));record('native catalogue and secret-free metadata',{catalogue,profile:direct});
  const id=randomUUID(),workspace=join(output,'native-workspace');mkdirSync(workspace,{recursive:true});const nonce=`实际文件 ${randomUUID()}\n多渠道原生子任务\n`;writeFileSync(join(workspace,'input.txt'),nonce);
  await invoke('workspace_set',{conversationId:id,directory:workspace,permission:'fullAccess'});
  // Rotate the key and remove Flash from current config mid-turn. The parent,
  // child (in the companion) and schedule must retain their original snapshot.
  const parent=await read(direct,id,'deepseek-flash',{spawn:true,edit:{...base,id:direct.id,name:'接入验收 · 已编辑配置',apiKey:providerKey,models:[model('deepseek-v4-pro')]}});checkRead(parent,'deepseek-flash',direct.revision);record('parent route remains fixed through profile edits',{...parent});
  const handoff=parent.handoffs[0];assert(handoff?.child.id&&handoff?.schedule.scheduleId);
  await select(id,'hosted','hosted');await select('default','hosted','hosted');
  const child=await waitTask(id,handoff.child.id);assert.equal(child.task.status,'completed');
  const childFile=unwrap(await invoke('agent_tasks_read_file',{conversationId:id,taskId:child.task.id,path:'result.txt'}));assert.equal(childFile.text,nonce);
  assert.equal(child.task.modelRoute.model.id,'deepseek-flash');assert.equal(child.task.modelRoute.channel.revision,direct.revision);
  const childGenerations=child.events.filter(e=>e.type==='generationResult').map(e=>e.generation);assert(childGenerations.length>=3);assert(childGenerations.every(g=>g.selectedModel==='deepseek-flash'&&g.channelRevision===direct.revision));
  record('actual native companion child reads and writes with parent snapshot',{task:child.task,fileVerified:true,generations:childGenerations.map(g=>({generationId:g.generationId,selectedModel:g.selectedModel,channelRevision:g.channelRevision,inputTokens:g.inputTokens,outputTokens:g.outputTokens,billingScope:g.billingScope}))});
  const scheduled=await waitSchedule(id,handoff.schedule.scheduleId);assert.equal(scheduled.run.state,'succeeded');
  const scheduledGenerations=scheduled.events.filter(e=>e.type==='generationResult').map(e=>e.generation);assert(scheduledGenerations.length>=2);assert(scheduledGenerations.every(g=>g.selectedModel==='deepseek-flash'&&g.channelRevision===direct.revision));
  record('actual native schedule keeps original channel after conversation switch',{run:scheduled.run,generations:scheduledGenerations.map(g=>({generationId:g.generationId,selectedModel:g.selectedModel,channelRevision:g.channelRevision,billingScope:g.billingScope}))});
  const pro=await read(direct,id,'deepseek-v4-pro');checkRead(pro,'deepseek-v4-pro');record('native model switch to actual Pro model',pro);
  const responses=await save({name:'接入验收 · Responses 网关',baseUrl:relayBase,protocol:'responses',enabled:true,models:[model('deepseek-flash')],apiKey:relayKey});
  const rid=randomUUID();await invoke('workspace_get',{conversationId:rid});const responseRead=await read(responses,rid,'deepseek-flash');checkRead(responseRead,'deepseek-flash');record('native Responses passthrough with real tools',responseRead);
  const reopened=await read(responses,rid,'deepseek-flash');checkRead(reopened,'deepseek-flash');assert.equal(reopened.result.threadId,responseRead.result.threadId);record('Responses conversation thread resumes',reopened);
  await select(id,direct.id,'deepseek-v4-pro');
  const cancelled=await evaluate(async p=>{
    const {runCodexTurn}=await import('/src/codex-client.ts'),{api}=await import('/src/api.ts');const runId=crypto.randomUUID(),generations=[];let stopped=false,timer;
    const result=await runCodexTurn(runId,p.id,'请详细解释十种不同的地理数据库索引机制。',[],{onEvent:()=>{},onModel:()=>{if(!stopped){stopped=true;timer=setTimeout(()=>{void api.codexCommand(runId,{type:'interrupt'});},600);}},onGeneration:g=>generations.push(g),onRequest:async()=>({decision:'decline'}),execute:async()=>({result:{error:'QA_NO_TOOLS'}})}).catch(e=>({status:'interrupted',error:String(e?.message??e)}));clearTimeout(timer);await new Promise(r=>setTimeout(r,500));return{result,generations};
  },{id});assert.equal(cancelled.result.status,'interrupted');record('native cancellation aborts personal transport',cancelled);
  const recovery=await read(direct,id,'deepseek-v4-pro');checkRead(recovery,'deepseek-v4-pro');record('native personal route recovers after cancellation',recovery);
  }else{
    const responses=await save({name:'接入验收 · Responses 顺序修复',baseUrl:relayBase,protocol:'responses',enabled:true,models:[model('deepseek-flash')],apiKey:relayKey});
    const rid=randomUUID();await invoke('workspace_get',{conversationId:rid});
    const first=await read(responses,rid,'deepseek-flash');checkRead(first,'deepseek-flash');record('native Responses tool completion after durable settlement',first);
    const second=await read(responses,rid,'deepseek-flash');checkRead(second,'deepseek-flash');assert.equal(first.result.threadId,second.result.threadId);record('native Responses resumes after ordered settlement fix',second);
  }
  const bad=await save({...base,name:'接入验收 · 错误密钥',apiKey:'invalid-'+randomUUID()});
  let rejected=false;try{await invoke('ai_channel_models',{channelId:bad.id});}catch(e){rejected=e?.code==='AI_KEY_REJECTED'||String(e?.message??e).includes('拒绝认证');}assert(rejected);record('real invalid provider key rejected without raw secret echo',{});
  const secretAudit=await evaluate(async p=>{const {localStateEntries}=await import('/src/local-state.ts');return{browserStateContainsTestKey:p.keys.some(key=>JSON.stringify(localStateEntries()).includes(key)),metadataContainsTestKey:p.keys.some(key=>JSON.stringify(window.__TAURI_INTERNALS__.metadata).includes(key))};},{keys:[providerKey,relayKey]});assert.equal(secretAudit.browserStateContainsTestKey,false);record('browser state does not persist test credentials',secretAudit);
  const final=await invoke('ai_channels_list');assert(final.usage.some(u=>u.requests>2&&u.inputTokens>0));record('personal usage recorded separately from hosted quota',{usage:final.usage});
  assert.equal(await evaluate(()=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')),activeBefore);record('existing user conversation preserved',{});
  writeFileSync(join(output,'native-summary.json'),JSON.stringify({passed:true,inProgress:false,cases},null,2));
}catch(e){writeFileSync(join(output,'native-failure.json'),JSON.stringify({error:String(e.message),cases},null,2));console.error(String(e.message));process.exitCode=1;}
finally{
  if(original)await select('default',original.channelId,original.modelId).catch(()=>{});
  for(const id of profiles)await invoke('ai_channel_remove',{channelId:id}).catch(()=>{});
  await evaluate(()=>{window.dispatchEvent(new Event('geod:ai-channels-changed'));}).catch(()=>{});
  socket.close();
}
