import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const output=path.resolve('artifacts/product-gaps-20261004/concurrency');
const prior=JSON.parse(fs.readFileSync(path.join(output,'native-fork.json'),'utf8'));
const sourceId=prior.fork.target,expected=/STOP_B_\d+/.exec(prior.result.text)?.[0];assert(expected);
const {chromium}=await import(pathToFileURL(process.argv[2]).href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let attempt=0;attempt<30&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,500));}assert(page);
await page.locator('textarea:not([disabled])').waitFor();let original;
try{
  original=await page.evaluate(async({sourceId,text})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
    const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),prior=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]'),workspace=await api.workspaceGet(sourceId);
    const original={active:store.getItem('geod-agent-active-conversation-0.1'),ids:prior.map(chat=>chat.conversationId)};
    store.setItem('geod-agent-deleted-conversations-1',JSON.stringify(JSON.parse(store.getItem('geod-agent-deleted-conversations-1')??'[]').filter(id=>id!==sourceId)));
    store.setItem(CHAT_LIST_KEY,JSON.stringify([{conversationId:sourceId,title:'重启后原生恢复验收',engine:'codex',workspaceDirectory:workspace.directory,messages:[],display:[{id:crypto.randomUUID(),role:'assistant',phase:'final_answer',content:text}],updatedAt:new Date().toISOString()},...prior]));
    store.setItem('geod-agent-active-conversation-0.1',sourceId);await flushLocalState();return original;
  },{sourceId,text:prior.result.text});
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  await page.evaluate(async()=>{
    const source=await(await fetch('/src/agent-panel.tsx')).text(),specifier=[...source.matchAll(/from "([^"]+)"/g)].map(match=>match[1]).find(value=>value.includes('/src/api.ts'));
    const {api}=await import(specifier),turn=api.codexTurn;window.__resumeAudit={};api.codexTurn=async(...args)=>{try{return window.__resumeAudit.result=await turn(...args);}catch(error){window.__resumeAudit.error={code:error.code,message:error.message};throw error;}finally{window.__resumeAudit.finished=true;}};
  });
  await page.locator('textarea').fill('重启后验收：不要调用工具，只回复这个原生分支之前实际 PowerShell 输出的标记。');
  await page.locator('button[aria-label="发送消息"]:not([disabled]),button[aria-label="Send message"]:not([disabled])').waitFor();await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>window.__resumeAudit.finished,null,{timeout:180000});const audit=await page.evaluate(()=>window.__resumeAudit);
  assert.equal(audit.result?.status,'completed',JSON.stringify(audit.error));assert.equal(audit.result.threadId,prior.fork.result.threadId);assert(audit.result.text.includes(expected));
  fs.writeFileSync(path.join(output,'native-restart-resume.json'),JSON.stringify({passed:true,priorThreadId:prior.fork.result.threadId,result:audit.result},null,2));console.log(JSON.stringify({passed:true,retainedSameNativeThread:true,retainedActualHistory:true}));
}finally{
  if(original){await page.evaluate(async({original,sourceId})=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);deleteStoredConversation(store,sourceId);if(original.active)store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();},{original,sourceId}).catch(()=>{});await page.reload().catch(()=>{});}await browser.close();
}
