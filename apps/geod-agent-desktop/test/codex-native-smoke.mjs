// Runs against the development desktop without keyboard, mouse or focus changes.
import {writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const page=(await (await fetch('http://127.0.0.1:9233/json/list')).json()).find(p=>p.title==='GeoD Agent');
if(!page)throw new Error('Start scripts/start-codex-dev.py first');
const socket=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
let serial=0;const pending=new Map();
socket.addEventListener('message',event=>{const value=JSON.parse(event.data);const request=pending.get(value.id);if(!request)return;pending.delete(value.id);value.error?request.reject(new Error(value.error.message)):request.resolve(value.result);});
socket.addEventListener('close',()=>{for(const request of pending.values())request.reject(new Error('Desktop debug connection closed'));pending.clear();});
function command(method,params){return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
try {
 if(process.argv.includes('--job-facts')){
  const result=await evaluate(`(async()=>{const {api}=await import('/src/api.ts');const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const status=await api.authStatus(),chat=JSON.parse(accountChatStore(localStorage,status.userId).getItem(CHAT_LIST_KEY))[0];const jobs=(await api.jobsList()).filter(j=>chat.planIds?.includes(j.planId));return {conversationId:chat.conversationId,active:await api.jobsActive(),jobs:await Promise.all(jobs.map(async j=>({...j,events:(await api.jobsEvents(j.jobId,0)).slice(-3)}))),tools:chat.messages.filter(m=>m.role==='tool').slice(-3).map(m=>({id:m.tool_call_id,result:JSON.parse(m.content)}))};})()`);
  if(process.argv.includes('--evidence'))writeFileSync(process.argv[process.argv.indexOf('--evidence')+1],JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));socket.close();process.exit(0);
 }
 if(process.argv.includes('--clean-ui-probes')){
  console.log(JSON.stringify(await evaluate(`(async()=>{const {api}=await import('/src/api.ts');const {accountChatStore,CHAT_LIST_KEY,persistCompletedChat}=await import('/src/pending-generations.ts');const status=await api.authStatus(),store=accountChatStore(localStorage,status.userId),chat=JSON.parse(store.getItem(CHAT_LIST_KEY))[0];const marker='进度如何？只检查一次，不恢复或启动下载。',index=chat.display.findIndex(m=>m.role==='user'&&m.content===marker);if(index<0)return {removed:0};const before=chat.display.length;chat.display=chat.display.slice(0,index);chat.display.push({id:crypto.randomUUID(),role:'assistant',phase:'final',content:'当前任务状态已更新到上方后台卡片，可以继续聊天。'});persistCompletedChat(store,chat);return {removed:before-index};})()`)));
  await command('Page.reload',{});socket.close();process.exit(0);
 }
 if(process.argv.includes('--reload')){await command('Page.reload',{});socket.close();process.exit(0);}
 if(process.argv.includes('--ui-progress') || process.argv.includes('--ui-continue')){
  const continuing=process.argv.includes('--ui-continue');
  const prompt=continuing ? '继续' : '进度如何？只检查一次，不恢复或启动下载。';
  await evaluate(`(async()=>{const {api}=await import('/src/api.ts');window.__modelReplyEvidence=[];window.__restoreModelAudit=api.agentGenerateStream;api.agentGenerateStream=async(...args)=>{const result=await window.__restoreModelAudit(...args);window.__modelReplyEvidence.push({generationId:result.generationId,state:result.state,content:result.result?.content,tools:result.result?.toolCalls?.map(t=>t.function.name)});return result;};})()`);
  if(continuing)await evaluate(`(async()=>{const {api}=await import('/src/api.ts');window.__resumeEvidence=[];window.__restoreResumeAudit=api.jobsResume;api.jobsResume=async(id)=>{const result=await window.__restoreResumeAudit(id);window.__resumeEvidence.push({jobId:id,returned:result,active:await api.jobsActive()});return result;};})()`);
  if(process.argv.includes('--usage-stall'))await evaluate(`(async()=>{const {api}=await import('/src/api.ts');window.__restoreGeodUsage=api.agentUsage;api.agentUsage=()=>new Promise(()=>{});})()`);
  await evaluate(`(async()=>{for(let i=0;i<100;i++){const textarea=document.querySelector('textarea');if(textarea&&!textarea.disabled)return;await new Promise(r=>setTimeout(r,100));}throw new Error('Composer did not become ready');})()`);
  await evaluate(`(async()=>{const textarea=document.querySelector('textarea');if(!textarea||textarea.disabled)throw new Error('Composer is busy');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(prompt)});textarea.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,40));textarea.closest('form').requestSubmit();})()`);
  for(let i=0;i<65;i++){
   await new Promise(r=>setTimeout(r,1000));
   const state=await evaluate(`({disabled:document.querySelector('textarea')?.disabled,text:document.body.innerText.slice(-1500)})`);
   if(!state.disabled){await new Promise(r=>setTimeout(r,1000));const result=await evaluate(`({disabled:document.querySelector('textarea')?.disabled,text:document.body.innerText.slice(-1500),modelReplies:window.__modelReplyEvidence,resume:window.__resumeEvidence})`);console.log(JSON.stringify(result,null,2));writeFileSync(continuing?'../../docs/implementation/evidence/codex-resume-2026-10-01.json':'../../docs/implementation/evidence/codex-model-reply-2026-10-01.json',JSON.stringify(result,null,2));await evaluate(`(async()=>{const {api}=await import('/src/api.ts');api.agentGenerateStream=window.__restoreModelAudit;delete window.__restoreModelAudit;if(window.__restoreResumeAudit){api.jobsResume=window.__restoreResumeAudit;delete window.__restoreResumeAudit;}if(window.__restoreGeodUsage){api.agentUsage=window.__restoreGeodUsage;delete window.__restoreGeodUsage;}})()`);socket.close();process.exit(0);}
  }
  throw new Error('UI turn did not finish within 65 seconds');
 }
 if(process.argv.includes('--replay')){
  const result=await evaluate(`(async()=>{
   const {api}=await import('/src/api.ts');const {runCodexTurn}=await import('/src/codex-client.ts');const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
   const status=await api.authStatus(),chat=JSON.parse(accountChatStore(localStorage,status.userId).getItem(CHAT_LIST_KEY))[0];
   const calls=[],events=[];const runId=crypto.randomUUID();window.__geodCodexReplay={runId,calls,events};
   const result=await runCodexTurn(runId,chat.conversationId,'进度如何？只查询一次当前任务状态，不要恢复、取消或启动任务。',chat.messages,{onEvent:e=>{events.push({type:e.type,method:e.method});},onModel:()=>{},onGeneration:()=>{},execute:async(call,executionId)=>{
    calls.push(call.function.name);const args=JSON.parse(call.function.arguments);
    if(call.function.name==='workspace_status')return {result:await api.workspaceGet(chat.conversationId)};
    if(call.function.name==='jobs_list')return {result:await api.jobsList()};
    if(call.function.name==='jobs_get')return {result:await api.jobsGet(args.jobId)};
    if(call.function.name==='jobs_events')return {result:await api.jobsEvents(args.jobId,args.afterVersion??null)};
    return {result:{error:'PROGRESS_REPLAY_READ_ONLY'}};
   }});return {result,calls,events};
  })()`);console.log(JSON.stringify(result,null,2));socket.close();process.exit(0);
 }
 if(process.argv.includes('--chat-inventory')){console.log(JSON.stringify(await evaluate(`(async()=>{const {api}=await import('/src/api.ts');const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const status=await api.authStatus();const chats=JSON.parse(accountChatStore(localStorage,status.userId).getItem(CHAT_LIST_KEY));return {chats:chats.map(c=>({id:c.conversationId,engine:c.engine,historyChars:JSON.stringify(c.messages).length,lastRequest:c.messages.filter(m=>m.role==='user').at(-1)?.content.slice(-200),recent:c.messages.slice(-6).map(m=>({role:m.role,callIds:m.tool_calls?.map(t=>t.id),tool_call_id:m.tool_call_id,chars:m.content?.length}))})),text:document.body.innerText.slice(-700)}})()`),null,2));socket.close();process.exit(0);}
 if(process.argv.includes('--snapshot')){
  const path=process.argv[process.argv.indexOf('--snapshot')+1];
  const result=await command('Page.captureScreenshot',{format:'png'});writeFileSync(path,Buffer.from(result.data,'base64'));
  console.log(JSON.stringify(await evaluate(`({selector:[...document.querySelectorAll('button')].filter(b=>b.innerText.includes('Codex')).map(b=>({text:b.innerText,font:getComputedStyle(b).fontSize})),errors:[...document.querySelectorAll('[role="alert"]')].map(e=>e.innerText)})`)));socket.close();process.exit(0);
 }
 if(process.argv.includes('--status')){console.log(JSON.stringify(await evaluate('window.__geodCodexSmoke'),null,2));socket.close();process.exit(0);}
 if(process.argv.includes('--close')){await command('Runtime.evaluate',{expression:`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`});socket.close();process.exit(0);}
 const overview=await evaluate(`(async()=>{const {api}=await import('/src/api.ts');const [auth,available,extensions]=await Promise.all([api.authStatus(),api.codexAvailable(),api.extensionsList()]);return {auth:{state:auth.state},available,connectors:extensions.connectors.map(c=>({id:c.id,name:c.name,enabled:c.enabled}))}})()`);
 console.log(JSON.stringify({...overview,text:undefined},null,2));
 if(process.argv.includes('--inventory'))process.exitCode=0;
 else {
  const directory=mkdtempSync(join(tmpdir(),'geod-codex-native-'));
  const sample=join(directory,'points.geojson');
  writeFileSync(sample,JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'native-probe'},geometry:{type:'Point',coordinates:[116.4,39.9]}}]}));
  const result=await evaluate(`(async()=>{
   const {api}=await import('/src/api.ts'); const {runCodexTurn}=await import('/src/codex-client.ts');
   const conversationId='codex-native-'+crypto.randomUUID(),directory=${JSON.stringify(directory)};
   await api.workspaceSet(conversationId,directory,'fullAccess');
   const overview=await api.extensionsList(); const connector=overview.connectors.find(c=>c.name.includes('GDAL')&&c.enabled);
   if(!connector)throw new Error('Enable the existing GDAL connector first');
   const tools=await api.mcpTools(connector.id,conversationId);
   const events=[],calls=[],generations=[];
   const hooks={onEvent:e=>{if(e.type==='event'&&['item/agentMessage/delta','thread/tokenUsage/updated'].includes(e.method))events.push({method:e.method,params:e.params})},onModel:id=>{window.__geodCodexSmoke={conversationId,generationId:id,calls:JSON.parse(JSON.stringify(calls))}},onGeneration:g=>generations.push({state:g.state,errorCode:g.errorCode,inputTokens:g.inputTokens}),execute:async(call,executionId)=>{
     const args=JSON.parse(call.function.arguments);calls.push({name:call.function.name,args});
     if(call.function.name==='workspace_status')return {result:await api.workspaceGet(conversationId)};
     if(call.function.name==='sources_list')return {result:await api.sourcesList()};
     if(call.function.name==='extensions_list')return {result:{connectors:[{id:connector.id,name:connector.name,enabled:true,tools:tools.tools}]}};
     if(call.function.name==='mcp_call'&&args.connectorId===connector.id&&['vector_info','vector_convert'].includes(args.toolName))return {result:await api.mcpCall(args.connectorId,args.toolName,args.arguments,executionId+':'+call.id,conversationId)};
     return {result:{error:'TEST_SCOPE_READONLY_EXCEPT_SAMPLE_CONVERSION'}};
   }};
   const prompt='这是 Codex 接入验证。请必须调用 workspace_status，再调用 sources_list；之后用 GDAL 连接器 '+connector.id+' 的 vector_convert 把当前工作区 points.geojson 转成 points.gpkg，再调用 vector_info 检查 points.gpkg。工具 schema 为 '+JSON.stringify(tools.tools)+ '。只处理此测试工作区，不注册图源、不启动下载。完成后用中文简短报告实际结果。';
   let first;try{first=await runCodexTurn(crypto.randomUUID(),conversationId,prompt,[],hooks);}catch(error){return {conversationId,directory,error:String(error),calls,generations};}
   const second=await runCodexTurn(crypto.randomUUID(),conversationId,'请依据本会话的实际工具结果，用一句中文说出刚才转换的输出格式，不要重复调用工具。',[],hooks);
   return {conversationId,directory,first,second,calls,generations,streamDeltas:events.filter(e=>e.method==='item/agentMessage/delta').length,usage:events.filter(e=>e.method==='thread/tokenUsage/updated').at(-1)?.params.tokenUsage};
  })()`);
  const report=join(directory,'codex-native-report.json');writeFileSync(report,JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,report},null,2));
  if(result.error||result.first.status!=='completed'||result.second.threadId!==result.first.threadId||!result.streamDeltas||!result.calls.some(c=>c.name==='mcp_call'&&c.args.toolName==='vector_convert'))throw new Error('Native Codex integration did not pass');
 }
} finally {socket.close();}
