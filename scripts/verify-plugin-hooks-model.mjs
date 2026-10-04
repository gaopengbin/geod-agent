/** Real model context and native tool lifecycle; the marker is never in the prompt. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-hooks'),file=path.join(root,'model-result.json'),saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')),report={passed:false,cases:[]};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(condition,label,timeout=220000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,400));}throw new Error('Timeout '+label);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const events=()=>fs.existsSync(path.join(saved.dataRoot,'events.jsonl'))?fs.readFileSync(path.join(saved.dataRoot,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
let original,uiId,closed=false;
try{
 await page.locator('.conversation-account-trigger').waitFor();original=await state();assert.equal((await rpc('plugins_list')).plugins.find(p=>p.id===saved.installedId)?.enabledHooks,5);
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});
 await page.locator('.sidebar-new-chat').click();uiId=await wait(async()=>{const current=await state();return current.chats.find(c=>!original.chats.some(old=>old.conversationId===c.conversationId))?.conversationId;},'Owned QA conversation');
 saved.qaConversationIds=[...new Set([...(saved.qaConversationIds??[]),uiId])];fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const workspace=await rpc('workspace_get',{conversationId:uiId});await rpc('workspace_set',{conversationId:uiId,directory:workspace.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:uiId,channelId:'hosted',modelId:'hosted'});
 await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
 const prompt='插件实测：只调用 workspace_status 一次读取工作区，接着简短报告本轮 SessionStart 附加上下文中的本地插件验证标记，以及当前工作区权限。不要读取项目文件，不修改数据。';assert(!prompt.includes(saved.marker));
 await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const chat=await wait(async()=>{const current=(await state()).chats.find(c=>c.conversationId===uiId);return current&&!current.pendingId&&current.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?current:null;},'Actual hook model response');
 fs.writeFileSync(path.join(root,'actual-model-chat.json'),JSON.stringify(chat,null,2));const answer=chat.messages.at(-1).content;assert(answer.includes(saved.marker),'The actual model did not receive native SessionStart context');assert(chat.codexContext?.inputTokens>0);
 await wait(async()=>events().some(record=>record.event.hook_event_name==='Stop'),'Actual async stop collector',20000);
 const actual=events(),kinds=[...new Set(actual.map(record=>record.event.hook_event_name))];assert(['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop'].every(event=>kinds.includes(event)));assert(actual.every(record=>record.bridgeVisible===false&&record.root===saved.installedRoot&&record.data===saved.dataRoot));
 fs.writeFileSync(path.join(root,'actual-foreground-hook-records.json'),JSON.stringify(actual,null,2));
 const trace=chat.display.filter(item=>item.itemType==='hook');assert(trace.some(item=>item.toolStatus==='success'&&item.content.includes('SessionStart')));assert(!trace.some(item=>item.toolStatus==='running'));assert(!trace.some(item=>item.toolStatus==='attention'));
 await page.setViewportSize({width:1000,height:720});await page.screenshot({path:path.join(root,'actual-model-collapsed-dark-1000.png')});
 pass('Actual Codex and DeepSeek receive real SessionStart output and execute native prompt/tool/async-stop hooks',{conversationId:uiId,actualAnswer:answer,inputTokens:chat.codexContext.inputTokens,events:kinds,trace:trace.map(item=>({content:item.content,status:item.toolStatus}))});
 saved.modelConversationId=uiId;saved.modelPrompt=prompt;fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const schedule=await rpc('ai_schedules_create',{conversationId:uiId,name:'Actual plugin hook closed-window QA',prompt,nextRunAt:new Date(Date.now()+9000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const background=await rpc('background_status');assert.equal(background.activeAiTurns,0);assert.equal(await page.locator('.conversation-running-dot').count(),0);await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();});
 closed=true;await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close();}).catch(error=>{if(!error.message.includes('closed'))throw error;});
 pass('Owned scheduled model is queued and the real desktop window closes before its due time',{scheduleId:closed?saved.scheduleId:null});report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
 }catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'model-failure.png')}).catch(()=>{});throw error;}
finally{if(!closed&&saved.scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false}).catch(()=>{});await browser.close().catch(()=>{});}
