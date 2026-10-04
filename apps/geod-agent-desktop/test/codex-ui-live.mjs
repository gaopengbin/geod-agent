// Real model + actual React UI. CDP DOM calls do not move the mouse or focus a window.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const page=(await(await fetch('http://127.0.0.1:9233/json')).json()).find(p=>p.type==='page'&&p.url.includes('127.0.0.1:1420'));
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let serial=0;const pending=new Map();
socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const callback=pending.get(value.id);pending.delete(value.id);value.error?callback?.reject(new Error(value.error.message)):callback?.resolve(value.result);}});
function command(method,params){return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
async function wait(expression,timeout=90000){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const value=await evaluate(expression);if(value)return value;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('UI state timed out: '+expression);}
async function submit(text){await evaluate(`(async()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,30));input.closest('form').requestSubmit();})()`);}
async function snapshot(name){const value=await command('Page.captureScreenshot',{format:'png'});writeFileSync('../../docs/implementation/evidence/'+name,Buffer.from(value.data,'base64'));}
const root=mkdtempSync(join(tmpdir(),'geod-codex-ui-'));let backup;
try{
 backup=await evaluate(`(async()=>{const {api}=await import('/src/api.ts');const {accountChatStore,CHAT_LIST_KEY,PENDING_KEY}=await import('/src/pending-generations.ts');const status=await api.authStatus(),store=accountChatStore(localStorage,status.userId),id=crypto.randomUUID();const backup={userId:status.userId,chats:store.getItem(CHAT_LIST_KEY),pending:store.getItem(PENDING_KEY),conversationId:id};await api.workspaceSet(id,${JSON.stringify(root)},'fullAccess');store.setItem(CHAT_LIST_KEY,JSON.stringify([{conversationId:id,engine:'codex',workspaceDirectory:${JSON.stringify(root)},messages:[],display:[],updatedAt:new Date().toISOString()},...JSON.parse(backup.chats??'[]')]));return backup;})()`);
 await command('Page.reload',{});await wait(`document.querySelector('textarea')&&!document.querySelector('textarea').disabled`);
 await evaluate(`(async()=>{const source=await(await fetch('/src/agent-panel.tsx')).text();const specifier=source.match(/from "([^\"]*\\/src\\/api.ts[^\"]*)"/)[1];const {api}=await import(specifier);window.__uiCodexAudit={events:[],results:[]};const original=api.codexTurn;api.codexTurn=async(...args)=>{const onEvent=args[4];args[4]=event=>{window.__uiCodexAudit.events.push(event);onEvent(event)};const result=await original(...args);window.__uiCodexAudit.results.push(result);return result;};})()`);
 await submit('这是界面验收：先调用 workspace_status，然后用原生命令等待 3 秒并输出 UI_NATIVE_OK。不下载、不修改图源。最后用一句中文报告实际结果。');
 await wait(`window.__uiCodexAudit?.events.some(e=>e.type==='event'&&e.method==='turn/started')`);
 const running=await evaluate(`({editable:!document.querySelector('textarea').disabled,stop:!!document.querySelector('button[aria-label="停止回复"]'),steer:!!document.querySelector('button[aria-label="补充指令"]')})`);
 assert.deepEqual(running,{editable:true,stop:true,steer:true});
 await submit('补充：最后回复保留 UI_NATIVE_OK 这个实际命令输出标记。');
 await wait(`window.__uiCodexAudit?.events.some(e=>e.type==='steered')`);
 await snapshot('codex-ui-running-2026-10-01.png');
 await wait(`window.__uiCodexAudit?.results.length&&!document.querySelector('button[aria-label="停止回复"]')`);
 const result=await evaluate(`({results:window.__uiCodexAudit.results,items:window.__uiCodexAudit.events.filter(e=>e.type==='event'&&e.method==='item/completed').map(e=>e.params.item),deltas:window.__uiCodexAudit.events.filter(e=>e.type==='event'&&e.method==='item/agentMessage/delta').length,steered:window.__uiCodexAudit.events.some(e=>e.type==='steered'),groups:[...document.querySelectorAll('.agent-work-records-trigger')].map(e=>({text:e.innerText,expanded:e.getAttribute('aria-expanded')})),final:[...document.querySelectorAll('.agent-work-entry.final')].map(e=>e.innerText),fonts:[...document.querySelectorAll('.agent-panel p,.agent-panel button,.agent-panel summary,.agent-panel textarea')].filter(e=>e.getClientRects().length).map(e=>Number.parseFloat(getComputedStyle(e).fontSize)),nativeTips:document.querySelectorAll('.agent-panel [title]').length,scroll:(()=>{const v=document.querySelector('.agent-messages-viewport');return {top:v.scrollTop,height:v.scrollHeight,client:v.clientHeight}})()})`);
 assert.equal(result.results[0].status,'completed');assert.ok(result.deltas>0);assert.ok(result.groups.length>0);assert.ok(result.groups.every(group=>group.expanded==='false'));
 assert.ok(result.final.some(text=>text.includes('UI_NATIVE_OK')));assert.ok(result.items.some(item=>item.type==='commandExecution'&&item.exitCode===0&&item.aggregatedOutput?.includes('UI_NATIVE_OK')));
 assert.ok(result.fonts.every(size=>size>=14));assert.equal(result.nativeTips,0);
 const savedHistory=await evaluate(`(async()=>{const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');return JSON.parse(accountChatStore(localStorage,${JSON.stringify(backup.userId)}).getItem(CHAT_LIST_KEY)).find(c=>c.conversationId===${JSON.stringify(backup.conversationId)}).messages;})()`);
 assert.ok(savedHistory.some(message=>message.role==='user'&&message.content.startsWith('补充：')),'Acknowledged steering must remain in the saved conversation');
 await snapshot('codex-ui-complete-2026-10-01.png');
 await evaluate(`document.querySelector('.agent-work-records-trigger').click()`);await wait(`document.querySelector('.agent-work-records-trigger').getAttribute('aria-expanded')==='true'`);
 assert.ok(await evaluate(`document.querySelectorAll('.agent-work-record').length>0`));
 await snapshot('codex-ui-records-2026-10-01.png');
 // A long restored Codex conversation must survive the React autosave effect intact.
 await evaluate(`(async()=>{const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStorage,${JSON.stringify(backup.userId)}),chats=JSON.parse(store.getItem(CHAT_LIST_KEY));const chat=chats.find(c=>c.conversationId===${JSON.stringify(backup.conversationId)});chat.messages=Array.from({length:72},(_,i)=>({role:i%2?'assistant':'user',content:'保存验证 '+i}));chat.display=Array.from({length:124},(_,i)=>({id:'retained-'+i,role:i%2?'assistant':'user',content:'保存验证 '+i,phase:'final'}));store.setItem(CHAT_LIST_KEY,JSON.stringify([chat,...chats.filter(c=>c!==chat)]));})()`);
 await command('Page.reload',{});await wait(`document.querySelector('textarea')&&!document.querySelector('textarea').disabled`);await new Promise(resolve=>setTimeout(resolve,500));
 const restored=await evaluate(`(async()=>{const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const chat=JSON.parse(accountChatStore(localStorage,${JSON.stringify(backup.userId)}).getItem(CHAT_LIST_KEY))[0];return {messages:chat.messages.length,display:chat.display.length};})()`);
 assert.deepEqual(restored,{messages:72,display:124});
 const evidence={root,running,restored,...result};writeFileSync('../../docs/implementation/evidence/codex-ui-live-2026-10-01.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({running,restored,deltas:result.deltas,groups:result.groups,final:result.final,scroll:result.scroll},null,2));
}finally{
 if(backup){await evaluate(`(async()=>{const {accountChatStore,CHAT_LIST_KEY,PENDING_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStorage,${JSON.stringify(backup.userId)});store.setItem(CHAT_LIST_KEY,${JSON.stringify(backup.chats??'[]')});store.setItem(PENDING_KEY,${JSON.stringify(backup.pending??'{}')});})()`).catch(()=>{});await command('Page.reload',{}).catch(()=>{});}
 socket.close();
}
