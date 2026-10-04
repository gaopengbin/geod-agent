/** Cancel a real native MCP Hook before any model request, through the desktop UI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-hooks'),saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')),file=path.join(root,'cancel-result.json');
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let n=0;n<100&&!page;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const audit=()=>fs.readFileSync(saved.auditFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),state=()=>page.evaluate(async userId=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const store=accountChatStore(localStateStore,userId);return{active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};},saved.original.userId);
const wait=async(condition,label)=>{const until=Date.now()+20000;while(Date.now()<until){const result=await condition();if(result)return result;await new Promise(resolve=>setTimeout(resolve,60));}throw new Error('Timeout '+label);};
const report={passed:false};
try{
 await page.locator('.conversation-account-trigger').waitFor();for(const scheduleId of [saved.scheduleId,saved.requiredInputScheduleId])await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false});assert.equal((await rpc('background_status')).activeAiTurns,0);
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});await page.reload();await page.locator('.conversation-account-trigger').waitFor();const before=await state();assert.equal(before.active,saved.modelConversationId);assert(saved.qaConversationIds.includes(before.active)&&!saved.original.chatIds.includes(before.active));
 fs.writeFileSync(saved.controlFile,JSON.stringify({marker:saved.marker,mode:'slow'}));const offset=audit().length;
 const prompt='本机 MCP 自动化取消验收：请只调用 workspace_status 一次，不读取或改写文件，不运行命令。';await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const call=await wait(async()=>audit().slice(offset).find(r=>r.type==='called'&&r.arguments.event==='UserPromptSubmit'),'Real native MCP invocation');const stoppedAt=Date.now();await page.getByRole('button',{name:'停止回复',exact:true}).click();
 const chat=await wait(async()=>{const current=(await state()).chats.find(c=>c.conversationId===saved.modelConversationId);return current&&!current.pendingId&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?current:null;},'Actual stopped turn');
 await new Promise(resolve=>setTimeout(resolve,600));const later=audit().slice(offset);assert(!later.some(r=>r.type==='completed'&&r.event==='UserPromptSubmit'),'Cancelled call completed after stop');assert(!later.some(r=>r.type==='called'&&['PreToolUse','PostToolUse'].includes(r.arguments.event)),'A model tool ran after stop');fs.writeFileSync(path.join(root,'actual-cancelled-chat.json'),JSON.stringify(chat,null,2));
 report.passed=true;report.cases=[{name:'Actual Stop button cancels the native MCP lifecycle call before the model/tool step',passed:true,callPid:call.pid,elapsedMs:Date.now()-stoppedAt,audit:later}];fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,elapsedMs:Date.now()-stoppedAt}));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));throw error;}
finally{fs.writeFileSync(saved.controlFile,JSON.stringify({marker:saved.marker,mode:'normal'}));await browser.close();}
