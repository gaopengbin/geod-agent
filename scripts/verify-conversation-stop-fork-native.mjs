// Observe real UI actions; every native/model call is delegated unchanged.
// Preserve old failed receipts and fail overall if scoped cleanup fails.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const nonce=Date.now().toString(),owned=[randomUUID(),randomUUID()];
const output=path.resolve(process.argv[3]??`artifacts/conversation-stop-fork-20261005/fixture-${nonce}`);
assert(!fs.existsSync(output),'Use a fresh output directory');fs.mkdirSync(output,{recursive:true});
const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const semanticSha=value=>sha(canonical(value));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'geod-stop-fork-'));
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://127.0.0.1:1420/');assert(page);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let baseline,original,stage='baseline',runtimePassed=false,audit,stoppedAt,cleanup={passed:false};
const report={passed:false,startedAt:new Date().toISOString(),output,directory};
const checkpoint=()=>write('ownership.json',{nonce,directory,ownedConversationIds:owned});checkpoint();
const observedCommands=new Map();
function commands(){
  const r=spawnSync('python',['-X','utf8','scripts/conversation-stop-fork-processes.py'],{input:JSON.stringify({nonce,directory}),encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);const observation=JSON.parse(r.stdout);
  for(const q of observation.commands)observedCommands.set(`${q.pid}:${q.created}`,q);
  write('owned-command-observations.json',{observed:[...observedCommands.values()],last:observation});return observation;
}
async function state(){return page.evaluate(async()=>{
  const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts');
  const {accountChatStore,CHAT_LIST_KEY,PENDING_KEY}=await import('/src/pending-generations.ts');
  await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]');
  return {userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats,
    projection:chats.map(c=>({conversationId:c.conversationId,title:c.title??null,messages:c.messages,display:c.display,planId:c.planId??null,planIds:c.planIds??[]})),
    pending:JSON.parse(store.getItem(PENDING_KEY)??'{}'),language:localStorage.getItem('geod-agent-language-v1'),background:await api.backgroundStatus()};
});}
const receipt=s=>({userId:s.userId,active:s.active,count:s.chats.length,ids:s.chats.map(c=>c.conversationId),
  chatsSha256:sha(s.chats),semanticSha256:semanticSha(s.chats),projectionSha256:sha(s.projection),
  fields:s.chats.map(c=>({id:c.conversationId,hashes:Object.fromEntries(Object.entries(c).map(([k,v])=>[k,semanticSha(v)]))})),
  pendingIds:Object.keys(s.pending),language:s.language,background:s.background});
async function phase(name){stage=name;const value={stage,at:new Date().toISOString()};write('progress.json',value);console.log(JSON.stringify(value));}
async function select(id){await page.locator(`.conversation-sidebar [data-conversation-id="${id}"]`).click();
  await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,id);}
async function submit(text){await page.locator('textarea:not([disabled])').fill(text);
  await page.locator('button[aria-label="发送消息"]:not([disabled]),button[aria-label="Send message"]:not([disabled])').waitFor();await page.locator('textarea').press('Enter');}
async function waitCommand(index){await page.waitForFunction(index=>{
  const r=window.__stopFork.runs[index];return r?.finishedAt||r?.events.some(e=>e.method==='item/started'&&e.params?.item?.type==='commandExecution');
},index,{timeout:180000});assert(!(await page.evaluate(i=>window.__stopFork.runs[i],index)).finishedAt,'Required overlapping command did not start');}
try{
  await page.locator('textarea:not([disabled])').waitFor();baseline=await state();
  // Old recovery records may exist for inactive conversations. Preserve them
  // byte-for-byte; they are not evidence that a live turn is running.
  assert(!baseline.pending[baseline.active],'Do not reload the active recovery conversation');
  assert.equal(await page.locator('.conversation-running-dot').count(),0,'Do not reload live background conversation turns');
  assert.equal(await page.getByRole('button',{name:/停止回复|Stop reply/}).count(),0,'Do not interrupt an existing user turn');write('baseline.json',receipt(baseline));
  original={userId:baseline.userId,active:baseline.active,ids:baseline.chats.map(c=>c.conversationId)};
  await phase('create-owned-conversations');
  await page.evaluate(async({directory,nonce,owned,userId})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
    if((await api.authStatus()).userId!==userId)throw Error('Account changed');const store=accountChatStore(localStateStore,userId),prior=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]'),chats=[];
    for(const [i,id] of owned.entries()){const ws=await api.workspaceSet(id,directory,'fullAccess');chats.push({conversationId:id,title:`Stop ${i?'B':'A'} ${nonce}`,engine:'codex',workspaceDirectory:ws.directory,messages:[],display:[],updatedAt:new Date().toISOString()});}
    store.setItem(CHAT_LIST_KEY,JSON.stringify([...chats,...prior]));store.setItem('geod-agent-active-conversation-0.1',owned[0]);await flushLocalState();
  },{directory,nonce,owned,userId:original.userId});
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  await page.evaluate(async()=>{
    const src=await(await fetch('/src/agent-panel.tsx')).text(),specifier=[...src.matchAll(/from "([^"]+)"/g)].map(m=>m[1]).find(v=>v.includes('/src/api.ts'));if(!specifier)throw Error('Panel API module unavailable');
    const {api}=await import(specifier),turn=api.codexTurn,fork=api.codexFork;window.__stopFork={runs:[],forks:[],apiSpecifier:specifier};
    api.codexTurn=async(...args)=>{const r={runId:args[0],conversationId:args[1],events:[],startedAt:Date.now()};window.__stopFork.runs.push(r);const emit=args[4];args[4]=e=>{r.events.push({...e,observedAt:Date.now()});emit(e);};
      try{return r.result=await turn(...args);}catch(e){r.error={code:e.code,message:e.message};throw e;}finally{r.finishedAt=Date.now();}};
    api.codexFork=async(...args)=>{const r={source:args[0],target:args[1],startedAt:Date.now()};window.__stopFork.forks.push(r);
      try{return r.result=await fork(...args);}catch(e){r.error={code:e.code,message:e.message};throw e;}finally{r.finishedAt=Date.now();}};
  });
  await phase('start-A');await submit(`这是停止会话验收。只执行一次 PowerShell 等待 180 秒后输出 STOP_A_${nonce}，不读写文件、不下载。最终报告实际输出。`);await waitCommand(0);
  assert(commands().commands.some(q=>q.marker==='A'),'Observe the actual Windows command before stopping it');
  await phase('start-B-in-parallel');await select(owned[1]);await submit(`这是另一个并行会话。只执行一次 PowerShell 等待 15 秒后输出 STOP_B_${nonce}，不读写文件、不下载。最终只报告实际输出标记。`);await waitCommand(1);
  await phase('stop-only-A');await select(owned[0]);audit=await page.evaluate(()=>window.__stopFork);assert(!audit.runs[0].finishedAt&&!audit.runs[1].finishedAt,'Both turns must be active at stop');
  assert(commands().commands.some(q=>q.marker==='B'),'Observe the other actual Windows command');
  stoppedAt=Date.now();await page.getByRole('button',{name:/停止回复|Stop reply/}).click();
  await page.waitForFunction(()=>window.__stopFork.runs.length>=2&&window.__stopFork.runs.slice(0,2).every(r=>r.finishedAt),null,{timeout:90000});audit=await page.evaluate(()=>window.__stopFork);
  assert.equal(audit.runs[0].result?.status,'interrupted',JSON.stringify(audit.runs[0].error));assert.equal(audit.runs[1].result?.status,'completed',JSON.stringify(audit.runs[1].error));
  assert(audit.runs[0].finishedAt-stoppedAt>=0&&audit.runs[0].finishedAt-stoppedAt<10000);
  const command=audit.runs[1].events.find(e=>e.method==='item/completed'&&e.params?.item?.type==='commandExecution'&&e.params.item.exitCode===0&&e.params.item.aggregatedOutput?.includes(`STOP_B_${nonce}`));
  assert(command,'Require successful actual command output, not just model text');assert(audit.runs[1].result.text.includes(`STOP_B_${nonce}`));
  write('stop-one.json',{passed:true,stoppedAt,stopMs:audit.runs[0].finishedAt-stoppedAt,stoppedConversation:owned[0],otherConversation:owned[1],actualCommand:command,otherActualResult:audit.runs[1].result.text});
  await page.screenshot({path:path.join(output,'stop-a-keeps-b.png')});
  await phase('fork-completed-B');await select(owned[1]);await page.getByRole('button',{name:/创建会话分支|Fork conversation/}).click();
  await page.waitForFunction(()=>window.__stopFork.forks[0]?.finishedAt,null,{timeout:120000});audit=await page.evaluate(()=>window.__stopFork);const fork=audit.forks[0];owned.push(fork.target);checkpoint();
  assert(!fork.error,JSON.stringify(fork.error));assert.equal(fork.result.sourceThreadId,audit.runs[1].result.threadId);assert.notEqual(fork.result.threadId,audit.runs[1].result.threadId);
  await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,fork.target);
  await phase('read-inherited-history');await submit('分支验收：不用调用任何工具，只回复此分支继承的前一轮实际命令输出标记。');
  await page.waitForFunction(()=>window.__stopFork.runs.length===3&&window.__stopFork.runs[2].finishedAt,null,{timeout:180000});audit=await page.evaluate(()=>window.__stopFork);
  assert.equal(audit.runs[2].result?.status,'completed');assert(audit.runs[2].result.text.includes(`STOP_B_${nonce}`));assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'fork-inherits-real-history.png')});runtimePassed=true;
  Object.assign(report,{stopOnePreservesOther:true,stopMs:audit.runs[0].finishedAt-stoppedAt,independentNativeFork:true,forkRetainedActualHistory:true,
    runs:audit.runs.map(r=>({conversationId:r.conversationId,threadId:r.result?.threadId,status:r.result?.status,text:r.result?.text})),fork});
}catch(e){report.error={stage,message:e.message};console.error(JSON.stringify(report.error));}
finally{
  audit=await page.evaluate(()=>window.__stopFork).catch(()=>audit);for(const f of audit?.forks??[])if(f.source===owned[1]&&!owned.includes(f.target))owned.push(f.target);checkpoint();write('events.json',audit??null);
  try{if(original){await phase('cleanup-owned-conversations');
    await page.evaluate(async({owned,userId})=>{const {api}=await import('/src/api.ts');if((await api.authStatus()).userId!==userId)throw Error('Account changed; stop scoped cleanup');
      for(const r of window.__stopFork?.runs??[])if(owned.includes(r.conversationId)&&!r.finishedAt)await api.codexCommand(r.runId,{type:'interrupt'});
    },{owned,userId:original.userId});
    await page.waitForFunction(()=>!window.__stopFork||window.__stopFork.runs.every(r=>r.finishedAt),null,{timeout:30000});
    await page.evaluate(async({original,owned})=>{
      const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts');
      if((await api.authStatus()).userId!==original.userId)throw Error('Account changed');const store=accountChatStore(localStateStore,original.userId);
      for(const id of owned){if(original.ids.includes(id))throw Error('Refuse original conversation deletion');deleteStoredConversation(store,id);}
      const active=store.getItem('geod-agent-active-conversation-0.1');if(original.active&&(owned.includes(active)||active===original.active))store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();
    },{original,owned});
    await page.reload();await page.locator('textarea:not([disabled])').waitFor();const after=await state();write('after.json',receipt(after));
    cleanup={passed:false,ownedConversationIds:owned,originalCount:baseline.chats.length,afterCount:after.chats.length,
      historyUnchanged:semanticSha(baseline.chats)===semanticSha(after.chats),serializedOrderUnchanged:sha(baseline.chats)===sha(after.chats),projectionUnchanged:sha(baseline.projection)===sha(after.projection),
      activeRestored:baseline.active===after.active,languageUnchanged:baseline.language===after.language,
      originalPendingUnchanged:sha(baseline.pending)===sha(after.pending),ownedRowsAbsent:after.chats.every(c=>!owned.includes(c.conversationId)),backgroundUnchanged:sha(baseline.background)===sha(after.background)};
    assert(Object.entries(cleanup).filter(([k])=>k!=='serializedOrderUnchanged'&&(k.endsWith('Unchanged')||k.endsWith('Restored')||k.endsWith('Absent'))).every(([,v])=>v),JSON.stringify(cleanup));
    // turn/interrupt stops generation; Codex background terminals deliberately
    // survive it. Our wait-only fixture expires naturally; observe no residue.
    await phase('wait-for-owned-background-shells');const until=Date.now()+200000;let observation=commands();
    while(observation.commands.length&&Date.now()<until){await new Promise(r=>setTimeout(r,5000));observation=commands();}
    assert.equal(observation.commands.length,0,'Owned background commands must finish before cleanup passes');
    cleanup.ownedCommandsObserved=observedCommands.size;cleanup.ownedCommandsRemaining=0;cleanup.passed=true;
  }}catch(e){cleanup.error=e.message;console.error(JSON.stringify({cleanupError:e.message}));}
  write('cleanup.json',cleanup);Object.assign(report,{runtimePassed,cleanup,pageErrors:errors,passed:runtimePassed&&cleanup.passed&&errors.length===0,completedAt:new Date().toISOString()});
  write('result.json',report);await browser.close();
}
console.log(JSON.stringify({passed:report.passed,runtimePassed,cleanupPassed:cleanup.passed,output,error:report.error}));if(!report.passed)process.exitCode=1;
