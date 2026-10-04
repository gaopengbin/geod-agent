import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const output=path.resolve('artifacts/product-gaps-20261004/concurrency');
const actual=JSON.parse(fs.readFileSync(path.join(output,'stop-fork-attempt.json'),'utf8')).audit.runs[1];
assert.equal(actual.result.status,'completed');
const sourceId=actual.conversationId,expected=/STOP_B_\d+/.exec(actual.result.text)?.[0];assert(expected);
const {chromium}=await import(pathToFileURL(process.argv[2]).href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let attempt=0;attempt<30&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,500));}assert(page);
await page.locator('textarea:not([disabled])').waitFor();
const errors=[];page.on('pageerror',error=>errors.push(error.message));let original,forkId;
try{
  original=await page.evaluate(async({sourceId,text})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts');
    const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
    const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),prior=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]');
    const original={active:store.getItem('geod-agent-active-conversation-0.1'),ids:prior.map(chat=>chat.conversationId)};
    // Restore only this acceptance fixture's UI index. The source is its actual
    // completed native Codex rollout; no model responses are generated locally.
    const workspace=await api.workspaceGet(sourceId);
    const chat={conversationId:sourceId,title:'原生分支验收',engine:'codex',workspaceDirectory:workspace.directory,messages:[],display:[{id:crypto.randomUUID(),role:'assistant',phase:'final_answer',content:text}],updatedAt:new Date().toISOString()};
    store.setItem('geod-agent-deleted-conversations-1',JSON.stringify(JSON.parse(store.getItem('geod-agent-deleted-conversations-1')??'[]').filter(id=>id!==sourceId)));
    store.setItem(CHAT_LIST_KEY,JSON.stringify([chat,...prior]));store.setItem('geod-agent-active-conversation-0.1',sourceId);await flushLocalState();return original;
  },{sourceId,text:actual.result.text});
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  await page.evaluate(async()=>{
    const source=await(await fetch('/src/agent-panel.tsx')).text(),specifier=[...source.matchAll(/from "([^"]+)"/g)].map(match=>match[1]).find(value=>value.includes('/src/api.ts'));
    const {api}=await import(specifier),fork=api.codexFork,turn=api.codexTurn;window.__forkAudit={forks:[],runs:[]};
    api.codexFork=async(...args)=>{const record={source:args[0],target:args[1],startedAt:Date.now()};window.__forkAudit.forks.push(record);try{return record.result=await fork(...args);}catch(error){record.error={code:error.code,message:error.message};throw error;}finally{record.finishedAt=Date.now();}};
    api.codexTurn=async(...args)=>{const record={conversationId:args[1],startedAt:Date.now(),events:[]};window.__forkAudit.runs.push(record);const emit=args[4];args[4]=event=>{record.events.push(event);emit(event);};try{return record.result=await turn(...args);}catch(error){record.error={code:error.code,message:error.message};throw error;}finally{record.finishedAt=Date.now();}};
  });
  await page.getByRole('button',{name:/创建会话分支|Fork conversation/}).click();
  await page.waitForFunction(()=>window.__forkAudit.forks[0]?.finishedAt,null,{timeout:120000});
  let audit=await page.evaluate(()=>window.__forkAudit);fs.writeFileSync(path.join(output,'fork-first-result.json'),JSON.stringify(audit,null,2));
  assert(!audit.forks[0].error,JSON.stringify(audit.forks[0].error));forkId=audit.forks[0].target;
  assert.equal(audit.forks[0].result.sourceThreadId,actual.result.threadId);assert.notEqual(audit.forks[0].result.threadId,actual.result.threadId);
  await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,forkId);
  await page.locator('textarea:not([disabled])').fill('分支验收：不要调用工具，只回复此分支前一轮实际 PowerShell 输出的标记。');
  await page.locator('button[aria-label="发送消息"]:not([disabled]),button[aria-label="Send message"]:not([disabled])').waitFor();await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>window.__forkAudit.runs[0]?.finishedAt,null,{timeout:180000});audit=await page.evaluate(()=>window.__forkAudit);
  assert.equal(audit.runs[0].result?.status,'completed',JSON.stringify(audit.runs[0].error));assert(audit.runs[0].result.text.includes(expected));assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'native-fork-real-history.png')});
  const report={passed:true,sourceThread:actual.result.threadId,fork:audit.forks[0],retainedActualCommandOutput:true,result:audit.runs[0].result,pageErrors:errors};fs.writeFileSync(path.join(output,'native-fork.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){const audit=await page.evaluate(()=>window.__forkAudit).catch(()=>null);fs.writeFileSync(path.join(output,'fork-attempt.json'),JSON.stringify({error:error.message,audit},null,2));throw error;}
finally{
  if(original){await page.evaluate(async({original,sourceId,forkId})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts');
    const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),ids=[sourceId,...(forkId?[forkId]:[])];for(const id of ids)deleteStoredConversation(store,id);
    if(original.active)store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();
  },{original,sourceId,forkId}).catch(()=>{});await page.reload().catch(()=>{});}await browser.close();
}
