/** Actual foreground model, followed by an owned closed-window schedule. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-node-launchers'),saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')),file=path.join(root,'model-result.json'),report={passed:false,cases:[]};assert(JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let tries=0;tries<100&&!page;tries++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();return JSON.parse(accountChatStore(localStateStore,window.__qaUserId).getItem(CHAT_LIST_KEY)||'[]');});
const wait=async(condition,label,timeout=200000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,400));}throw new Error('Timeout '+label);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const prompt='插件真实运行验收：通过 extensions_list 找到“Node launcher acceptance · npx”，按发现的准确接口调用 read_context 一次。不要使用文件或命令行。简短报告实际返回的 marker、Node 版本，以及工具进程和它的子进程是否使用同一个 Node。';assert(!prompt.includes(saved.fixture.marker));let closed=false;
try{
 await page.locator('.conversation-account-trigger').waitFor();await page.evaluate(userId=>{window.__qaUserId=userId;},saved.userId);
 const open=page.getByRole('button',{name:'展开会话列表',exact:true});if(await open.count())await open.click();await page.locator('[data-conversation-id="'+saved.conversationId+'"]').click();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
 const original=(await state()).find(chat=>chat.conversationId===saved.conversationId);assert(original);assert.equal((original.messages??[]).length,0);
 await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const chat=await wait(async()=>{const chat=(await state()).find(chat=>chat.conversationId===saved.conversationId);return chat&&!chat.pendingId&&chat.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?chat:null;},'Actual AI reads npx MCP');
 fs.writeFileSync(path.join(root,'actual-model-chat.json'),JSON.stringify(chat,null,2));assert(chat.messages.at(-1).content.includes(saved.fixture.marker));assert(chat.codexContext?.inputTokens>0);
 assert(chat.display.some(item=>item.toolName==='mcp_call'&&JSON.parse(item.details).arguments.connectorId===saved.connectors.npx.id&&JSON.parse(item.details).arguments.toolName==='read_context'));assert(!chat.display.some(item=>item.toolStatus==='running'||(item.toolName==='mcp_call'&&item.toolStatus==='attention')));
 await page.screenshot({path:path.join(root,'actual-model-npx-read-1000.png')});pass('Actual Codex and DeepSeek discover and read the offline npx service under scoped PATH isolation',{conversationId:saved.conversationId,inputTokens:chat.codexContext.inputTokens,actualAnswer:chat.messages.at(-1).content});
 const schedule=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Actual isolated npx closed-window QA',prompt,nextRunAt:new Date(Date.now()+9000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;saved.marker=saved.fixture.marker;fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 assert.equal((await rpc('background_status')).activeAiTurns,0);await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();});closed=true;
 await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close();}).catch(error=>{if(!error.message.includes('closed'))throw error;});
 pass('Actual desktop closes before the one-time npx schedule is due',{scheduleId:saved.scheduleId});report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'model-failure.png')}).catch(()=>{});throw error;}
finally{if(!closed&&saved.scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false}).catch(()=>{});await browser.close().catch(()=>{});}
