import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('textarea:not([disabled])').waitFor();
const output=path.resolve('artifacts/product-gaps-20261004/concurrency');fs.mkdirSync(output,{recursive:true});
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'geod-stop-fork-')),nonce=Date.now().toString();
const errors=[];page.on('pageerror',error=>errors.push(error.message));let original,forkId;
const select=async id=>{await page.locator(`.conversation-sidebar [data-conversation-id="${id}"]`).click();await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,id);};
async function submit(text){await page.locator('textarea').fill(text);await page.locator('button[aria-label="发送消息"]:not([disabled]),button[aria-label="Send message"]:not([disabled])').waitFor();await page.locator('textarea').press('Enter');}
try{
  original=await page.evaluate(async({directory,nonce})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts');
    const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
    const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),prior=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]');
    const original={ids:prior.map(chat=>chat.conversationId),active:store.getItem('geod-agent-active-conversation-0.1'),language:localStorage.getItem('geod-agent-language-v1')},chats=[];
    for(const label of ['A','B']){const id=crypto.randomUUID(),workspace=await api.workspaceSet(id,directory,'fullAccess');chats.push({conversationId:id,title:`Stop ${label} ${nonce}`,engine:'codex',workspaceDirectory:workspace.directory,messages:[],display:[],updatedAt:new Date().toISOString()});}
    store.setItem(CHAT_LIST_KEY,JSON.stringify([...chats,...prior]));store.setItem('geod-agent-active-conversation-0.1',chats[0].conversationId);await flushLocalState();
    return{...original,created:chats.map(chat=>chat.conversationId),a:chats[0].conversationId,b:chats[1].conversationId};
  },{directory,nonce});
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  await page.evaluate(async()=>{
    const source=await(await fetch('/src/agent-panel.tsx')).text();const specifier=[...source.matchAll(/from "([^"]+)"/g)].map(match=>match[1]).find(value=>value.includes('/src/api.ts'));
    const {api}=await import(specifier),turn=api.codexTurn,fork=api.codexFork;window.__stopFork={runs:[],forks:[]};
    api.codexTurn=async(...args)=>{const record={conversationId:args[1],events:[],startedAt:Date.now()};window.__stopFork.runs.push(record);const emit=args[4];args[4]=event=>{record.events.push(event);emit(event);};try{return record.result=await turn(...args);}catch(error){record.error={code:error.code,message:error.message};throw error;}finally{record.finishedAt=Date.now();}};
    api.codexFork=async(...args)=>{const record={source:args[0],target:args[1],startedAt:Date.now()};window.__stopFork.forks.push(record);try{return record.result=await fork(...args);}catch(error){record.error={code:error.code,message:error.message};throw error;}finally{record.finishedAt=Date.now();}};
  });
  await submit(`这是停止会话验收。只执行一次 PowerShell 等待 120 秒后输出 STOP_A_${nonce}，不读写文件、不下载。最终报告实际输出。`);
  await page.waitForFunction(()=>window.__stopFork.runs[0]?.events.some(event=>event.method==='item/started'&&event.params?.item?.type==='commandExecution'),null,{timeout:120000});
  await select(original.b);await submit(`这是另一个并行会话。只执行一次 PowerShell 等待 15 秒后输出 STOP_B_${nonce}，不读写文件、不下载。最终只报告实际输出标记。`);
  await page.waitForFunction(()=>window.__stopFork.runs[1]?.events.some(event=>event.method==='item/started'&&event.params?.item?.type==='commandExecution'),null,{timeout:120000});
  await select(original.a);const stoppedAt=Date.now();await page.getByRole('button',{name:/停止回复|Stop reply/,exact:false}).click();
  await page.waitForFunction(()=>window.__stopFork.runs.length>=2&&window.__stopFork.runs.slice(0,2).every(run=>run.finishedAt),null,{timeout:90000});
  let audit=await page.evaluate(()=>window.__stopFork);assert.equal(audit.runs[0].result?.status,'interrupted',JSON.stringify(audit.runs[0].error));assert.equal(audit.runs[1].result?.status,'completed');
  assert(audit.runs[0].finishedAt-stoppedAt<10000);assert(audit.runs[1].result.text.includes(`STOP_B_${nonce}`));
  fs.writeFileSync(path.join(output,'stop-one.json'),JSON.stringify({passed:true,stopMs:audit.runs[0].finishedAt-stoppedAt,stoppedConversation:audit.runs[0].conversationId,otherConversation:audit.runs[1].conversationId,otherStatus:audit.runs[1].result.status,otherActualResult:audit.runs[1].result.text},null,2));
  await page.screenshot({path:path.join(output,'stop-a-keeps-b.png')});
  await select(original.b);await page.getByRole('button',{name:/创建会话分支|Fork conversation/}).click();
  await page.waitForFunction(()=>window.__stopFork.forks[0]?.finishedAt,null,{timeout:120000});
  audit=await page.evaluate(()=>window.__stopFork);forkId=audit.forks[0].target;
  assert.equal(audit.forks[0].result.sourceThreadId,audit.runs[1].result.threadId);assert.notEqual(audit.forks[0].result.threadId,audit.runs[1].result.threadId);
  await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,forkId);
  await page.locator('textarea:not([disabled])').waitFor();await submit('分支验收：不用调用任何工具，只回复此分支继承的前一轮实际命令输出标记。');
  await page.waitForFunction(()=>window.__stopFork.runs.length===3&&window.__stopFork.runs[2].finishedAt,null,{timeout:180000});audit=await page.evaluate(()=>window.__stopFork);
  assert.equal(audit.runs[2].result?.status,'completed');assert(audit.runs[2].result.text.includes(`STOP_B_${nonce}`));assert.deepEqual(errors,[]);
  const report={passed:true,model:'deepseek-flash',stopOnePreservesOther:true,stopMs:audit.runs[0].finishedAt-stoppedAt,independentNativeFork:true,forkRetainedActualHistory:true,pageErrors:errors,runs:audit.runs.map(run=>({conversationId:run.conversationId,threadId:run.result.threadId,status:run.result.status,text:run.result.text})),fork:audit.forks[0]};
  fs.writeFileSync(path.join(output,'stop-fork.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
  const diagnostics=await page.evaluate(()=>window.__stopFork).catch(()=>null);
  fs.writeFileSync(path.join(output,'stop-fork-attempt.json'),JSON.stringify({error:error.message,audit:diagnostics},null,2));throw error;
}finally{
  if(original){await page.evaluate(async({original,forkId})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts');
    const status=await api.authStatus(),store=accountChatStore(localStateStore,status.userId);for(const id of [...original.created,...(forkId?[forkId]:[])])deleteStoredConversation(store,id);
    if(original.active)store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();
  },{original,forkId}).catch(()=>{});await page.reload().catch(()=>{});}await browser.close();
}
