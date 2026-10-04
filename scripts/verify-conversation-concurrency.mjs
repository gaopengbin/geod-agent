import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let attempt=0;attempt<150&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}
assert(page,'Development desktop did not open its page');
await page.locator('textarea:not([disabled])').waitFor({timeout:30000});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'geod-conversation-qa-'));
const output=path.resolve('artifacts/product-gaps-20261004/concurrency');fs.mkdirSync(output,{recursive:true});
const nonce=Date.now().toString(),markerA=`PARALLEL_A_${nonce}`,markerB=`PARALLEL_B_${nonce}`,errors=[];
page.on('pageerror',error=>{errors.push(error.message);fs.writeFileSync(path.join(output,'page-error.txt'),error.stack??error.message);});
let original,ids=[];
async function saved(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts');const {localStateStore}=await import('/src/local-state.ts');const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus();return JSON.parse(accountChatStore(localStateStore,auth.userId).getItem(CHAT_LIST_KEY)??'[]');});}
async function select(id){await page.locator(`.conversation-sidebar [data-conversation-id="${id}"]`).click();await page.locator('textarea').waitFor();}
async function submit(text){await page.locator('textarea').fill(text);await page.locator('textarea').press('Enter');}
try{
  original=await page.evaluate(async({root,nonce})=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts');
    const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
    const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),prior=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]');
    const original={ids:prior.map(chat=>chat.conversationId),active:store.getItem('geod-agent-active-conversation-0.1'),language:localStorage.getItem('geod-agent-language-v1')};
    const chats=[];
    for(const label of ['A','B']){const id=crypto.randomUUID(),workspace=await api.workspaceSet(id,root,'fullAccess');chats.push({conversationId:id,title:`Parallel ${label} ${nonce}`,engine:'codex',workspaceDirectory:workspace.directory,messages:[],display:[],updatedAt:new Date().toISOString()});}
    // A real IndexedDB reload at >30 rows verifies that the old save cap is gone.
    const history=Array.from({length:36},(_,index)=>({conversationId:crypto.randomUUID(),title:`History ${nonce} ${index}`,engine:'codex',workspaceDirectory:root,messages:[],display:[{id:crypto.randomUUID(),role:'user',content:`Retention ${index}`}],updatedAt:new Date(Date.now()-index*1000).toISOString()}));
    store.setItem(CHAT_LIST_KEY,JSON.stringify([...chats,...history,...prior]));store.setItem('geod-agent-active-conversation-0.1',chats[0].conversationId);await flushLocalState();
    return {...original,idsCreated:[...chats,...history].map(chat=>chat.conversationId),a:chats[0].conversationId,b:chats[1].conversationId};
  },{root,nonce});ids=original.idsCreated;
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  const retention=(await saved()).filter(chat=>ids.includes(chat.conversationId));assert.equal(retention.length,38);
  assert(await page.locator('.conversation-load-more').first().isVisible());
  await page.evaluate(async()=>{
    const source=await(await fetch('/src/agent-panel.tsx')).text();
    const specifier=[...source.matchAll(/from "([^"]+)"/g)].map(match=>match[1]).find(value=>value.includes('/src/api.ts'));
    const {api}=await import(specifier);const original=api.codexTurn;
    window.__concurrencyAudit={runs:[]};api.codexTurn=async(...args)=>{
      const record={runId:args[0],conversationId:args[1],startedAt:Date.now(),events:[]};window.__concurrencyAudit.runs.push(record);
      const emit=args[4];args[4]=event=>{record.events.push(event);emit(event);};
      try{record.result=await original(...args);return record.result;}catch(error){record.error={code:error.code,message:error.message??String(error)};throw error;}finally{record.finishedAt=Date.now();}
    };
  });
  await submit(`这是并行功能验收。先调用 workspace_status，再用 PowerShell 命令等待 8 秒并输出 ${markerA}。不要读写文件、不要下载。最后只报告该命令实际输出的标记。`);
  await page.waitForFunction(()=>window.__concurrencyAudit.runs.some(run=>run.events.some(event=>event.type==='event'&&event.method==='item/started'&&event.params?.item?.type==='commandExecution')),null,{timeout:120000});
  await submit('排队验收：无需任何工具，只回复本对话前一轮实际命令的并行验收标记。');
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({replyLanguage:'en'});});
  await select(original.b);await page.locator('textarea:not([disabled])').waitFor();
  await submit(`这是第二个并行会话。调用 workspace_status 检查当前工作区，不要读写文件或运行命令。最终用一句英文报告检查结果并包含 ${markerB}。`);
  await page.waitForFunction(()=>window.__concurrencyAudit.runs.length>=2&&window.__concurrencyAudit.runs.slice(0,2).every(run=>run.events.some(event=>event.type==='event'&&event.method==='turn/started')),null,{timeout:120000});
  await page.screenshot({path:path.join(output,'parallel-running.png')});
  await page.waitForFunction(()=>window.__concurrencyAudit.runs.length>=3&&window.__concurrencyAudit.runs.every(run=>run.finishedAt),null,{timeout:180000});
  const audit=await page.evaluate(()=>window.__concurrencyAudit);
  const diagnostics=audit.runs.map(run=>({conversationId:run.conversationId,result:run.result,error:run.error,startedAt:run.startedAt,finishedAt:run.finishedAt,events:run.events.slice(-20).map(event=>({type:event.type,method:event.method,message:event.message,item:event.params?.item?.type}))}));
  fs.writeFileSync(path.join(output,'latest-attempt.json'),JSON.stringify(diagnostics,null,2));
  assert(audit.runs.every(run=>run.result?.status==='completed'),JSON.stringify(diagnostics));
  const a=audit.runs.filter(run=>run.conversationId===original.a),b=audit.runs.filter(run=>run.conversationId===original.b);
  assert.equal(a.length,2);assert.equal(b.length,1);assert(b[0].startedAt<a[0].finishedAt,'The second conversation did not overlap the first');
  const chats=await saved(),chatA=chats.find(chat=>chat.conversationId===original.a),chatB=chats.find(chat=>chat.conversationId===original.b);
  assert(chatA.display.some(message=>message.role==='assistant'&&message.phase!=='progress'&&message.content.includes(markerA)));
  assert(chatB.display.some(message=>message.role==='assistant'&&message.phase!=='progress'&&message.content.includes(markerB)));
  assert(!chatA.display.some(message=>message.content.includes(markerB)));assert(!chatB.display.some(message=>message.content.includes(markerA)));
  const commands=a[0].events.filter(event=>event.type==='event'&&event.method==='item/completed'&&event.params?.item?.type==='commandExecution').map(event=>event.params.item);
  assert(commands.some(command=>command.exitCode===0&&command.aggregatedOutput?.includes(markerA)));
  await select(original.a);await page.screenshot({path:path.join(output,'parallel-a-completed.png')});
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  const after=await saved();assert.equal(after.filter(chat=>ids.includes(chat.conversationId)).length,38);
  assert(after.find(chat=>chat.conversationId===original.a).display.some(message=>message.content.includes(markerA)));
  assert.deepEqual(errors,[]);
  const report={passed:true,model:'deepseek-flash',conversations:2,overlapMs:a[0].finishedAt-b[0].startedAt,backgroundQueueContinued:true,historyRowsRetained:38,existingRowsPreserved:original.ids.length,pageErrors:errors,runs:audit.runs.map(run=>({runId:run.runId,conversationId:run.conversationId,status:run.result.status,startedAt:run.startedAt,finishedAt:run.finishedAt,text:run.result.text})),commands};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  if(original){await page.evaluate(async original=>{
    const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts');
    const {accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');
    const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);
    for(const id of original.idsCreated)deleteStoredConversation(store,id);
    if(original.active)store.setItem('geod-agent-active-conversation-0.1',original.active);
    setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});await flushLocalState();
  },original).catch(()=>{});await page.reload().catch(()=>{});}
  await browser.close();
}
