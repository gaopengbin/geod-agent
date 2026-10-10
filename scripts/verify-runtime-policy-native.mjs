// Exercises the actual development WebView, Rust bridge and bundled Codex.
// The model supplier is a loopback fixture; hosted credit is never requested.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';

const output=resolve('artifacts/runtime-policy-native-20261010');mkdirSync(output,{recursive:true});
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
 assert.deepEqual(current.jobs,before.jobs);assert.deepEqual(current.channels,before.channels);assert.equal(current.balance,before.balance);
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
  async function run(name,conversation,steps,{answers={},failures={}}={}){
   const scenario={steps,requests:[]};scenarios.set(name,scenario);activeScenario=name;
   const result=await evaluate(async p=>{
    const {runCodexTurn}=await import('/src/codex-client.ts'),{api}=await import('/src/api.ts');const events=[],tools=[],runId=crypto.randomUUID();
    let result;try{result=await runCodexTurn(runId,p.id,'运行层本地验收：'+p.name,[],{
     onEvent:e=>events.push(e),onModel:()=>{},onGeneration:g=>events.push({type:'qa-generation',billingScope:g.billingScope,state:g.state}),
     onRequest:async()=>({decision:'decline'}),execute:async c=>{
      const name=c.function.name,args=JSON.parse(c.function.arguments||'{}');tools.push({name,args});
      if(name==='ask_user')return{result:{answers:p.answers,answeredBy:'user'}};
      if(p.failures[name])return{result:p.failures[name]};
      if(name==='sources_list')return{result:{sources:await api.sourcesList()}};
      if(name==='workspace_status')return{result:{workspace:await api.workspaceGet(p.id),milestone:tools.length}};
      return{result:{error:'QA_EXECUTOR_TOOL_NOT_ALLOWED'}};
     },
    });}catch(error){return{qaError:{code:error?.code,message:error?.message??String(error),stack:error?.stack},tools,events};}return{result,tools,events};
   },{id:conversation.id,name,answers,failures});
   if(result.qaError)throw Object.assign(new Error(JSON.stringify(result.qaError)),{events:result.events,code:result.qaError.code});assert.equal(result.result.status,'completed',JSON.stringify(result.result));assert(result.events.filter(e=>e.type==='qa-generation').every(e=>e.billingScope==='personal'));return{...result,requests:scenario.requests};
  }
  const c1=await prepare();
  const schema=await run('schema',c1,[{message:call('jobs_start',{planId:123})},{message:call('sources_list',{})},{message:{content:'本地参数门禁验收完成。'}}]);
  assert.equal(schema.tools.length,1);assert.equal(schema.tools[0].name,'sources_list');assert(JSON.stringify(schema.requests[1]).includes('TOOL_ARGUMENT_INVALID'));assert(JSON.stringify(schema.requests[2]).includes('[GeoD execution checkpoint]'));
  record('Actual Rust/host bridge rejects invalid arguments before executor, reads real sources and refreshes checkpoint',{modelRequests:schema.requests.length,executorCalls:schema.tools.length});
  const c2=await prepare(),questions=[{id:'resolution',header:'分辨率',question:'验收使用哪个层级？',options:[{label:'z14',description:'快速'},{label:'z18',description:'详细'}]}];
  const questionSteps=[{message:call('ask_user',{questions})},{message:call('ask_user',{questions})},{message:{content:'复用已确认的 z14。'}}];
  const first=await run('answers-first',c2,questionSteps,{answers:{resolution:{answers:['z14']}}});assert.equal(first.tools.filter(t=>t.name==='ask_user').length,1);assert(JSON.stringify(first.requests[2]).includes('reusedPreviousAnswer'));
  const continued=await run('answers-continue',c2,[{message:call('ask_user',{questions})},{message:{content:'继续使用之前确认的 z14。'}}]);assert.equal(continued.tools.length,0);assert.equal(first.result.threadId,continued.result.threadId);
  record('Actual conversation continuation inherits confirmed answers without opening another question',{threadPreserved:true,questionsShown:1});
  const blockedConversation=await prepare();
  const repeated=await run('unchanged-recovery-condition',blockedConversation,[{message:call('sources_list',{})},{message:call('sources_list',{})},{message:{content:'已知条件未改变，停止重复调用。'}}],{failures:{sources_list:{error:'AUTH_REQUIRED',message:'Controlled test prerequisite is missing'}}});
  assert.equal(repeated.tools.length,1);assert(JSON.stringify(repeated.requests[2]).includes('RECOVERY_CONDITION_UNCHANGED'));
  record('Actual host prevents repeated dispatch when a controlled recovery prerequisite is unchanged',{attemptedCalls:2,executorCalls:1});
  const c3=await prepare(),steps=Array.from({length:15},()=>({message:call('workspace_status',{})}));steps.push({message:{content:'十五个阶段已完成。'}});
  const long=await run('long-progress',c3,steps);assert.equal(long.requests.length,16);assert.equal(long.tools.length,15);assert(!long.events.some(e=>e.type==='safetyReview'));
  record('Actual native task progresses past twelve model requests without a fixed step stop',{modelRequests:long.requests.length,stages:long.tools.length});
  const c4=await prepare(),marker=join(c4.directory,'permission-must-not-write.txt');
  const cmd=`node -e "require('fs').writeFileSync('${marker.replaceAll('\\','/')}','unexpected')"`;
  const denied=await run('changed-native-permission',c4,[{before:()=>rpc('workspace_set',{conversationId:c4.id,directory:c4.directory,permission:'confirmEach'}),message:call('exec_command',{cmd,yield_time_ms:1000,max_output_tokens:100})},{message:{content:'旧执行权限已失效，没有写入文件。'}}]);
  assert.equal(existsSync(marker),false);assert(JSON.stringify(denied.requests[1]).includes('WORKSPACE_PERMISSION_CHANGED'));
  record('Actual Codex command hook sees changed native permission and denies filesystem effect',{markerAbsent:true});
  await rpc('ai_channel_remove',{channelId});channelId=null;
  const final=await state();idle(final);preserved(final,before);
  record('User conversations, jobs, default channel and hosted credits remain unchanged',{balance:final.balance,records:final.records.length});
  report.passed=true;writeFileSync(join(output,'acceptance.json'),JSON.stringify(report,null,2));
 }else throw new Error('Unknown QA mode');
}catch(error){report.error={message:error.message,stack:error.stack,code:error.code};writeFileSync(join(output,'acceptance.json'),JSON.stringify(report,null,2));throw error;}
finally{if(originalDefault)await rpc('ai_model_select',{conversationId:'default',...originalDefault}).catch(()=>{});if(channelId)await rpc('ai_channel_remove',{channelId}).catch(()=>{});if(server)await new Promise(r=>server.close(r));socket.close();}
