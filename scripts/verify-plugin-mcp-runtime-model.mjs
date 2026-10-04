/** Actual model discovers and reads native configured MCP; then the window closes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-runtime'),saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')),file=path.join(root,'model-result.json'),report={passed:false,cases:[]};
assert(JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(condition,label,timeout=220000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,400));}throw new Error('Timeout '+label);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
let closed=false;
try{
 await page.locator('.conversation-account-trigger').waitFor();assert.equal((await state()).active,saved.modelConversationId??saved.conversationId);
 // Only the successful stdio fixture is relevant to this scoped model request.
 // The HTTP fixture is already closed and timing/error fixtures stay out of discovery.
 for(const [name,connector] of Object.entries(saved.connectors))await rpc('mcp_set_enabled',{id:connector.id,enabled:name==='stdio'});
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
 // Return to the active conversation through the production sidebar/navigation.
 if(!(await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).count())){
  const open=page.getByRole('button',{name:'展开会话列表',exact:true});if(await open.count())await open.click();
  await page.locator('[data-conversation-id="'+(saved.modelConversationId??saved.conversationId)+'"]').click();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
 }
 const active=(await state()).active;if(active!==saved.conversationId){saved.qaConversationIds=[...new Set([...saved.qaConversationIds,active])];saved.modelConversationId=active;const workspace=await rpc('workspace_get',{conversationId:active});await rpc('workspace_set',{conversationId:active,directory:workspace.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:active,channelId:'hosted',modelId:'hosted'});await page.reload();}else saved.modelConversationId=saved.conversationId;
 fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const prompt='图源插件运行验收：通过 extensions_list 查找“MCP runtime acceptance · stdio”工具服务，按返回的准确参数调用 read_context 一次。不要使用文件或命令行。简短报告实际返回的 marker、工作目录验证结果、继承变量和显式变量是否生效。';assert(!prompt.includes(saved.marker));
 let chat=(await state()).chats.find(chat=>chat.conversationId===saved.modelConversationId);
 if(!chat?.messages.at(-1)?.content.includes(saved.marker)){
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
  chat=await wait(async()=>{const current=(await state()).chats.find(chat=>chat.conversationId===saved.modelConversationId);return current&&!current.pendingId&&current.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?current:null;},'Actual model native MCP read');
 }
 fs.writeFileSync(path.join(root,'actual-model-chat.json'),JSON.stringify(chat,null,2));assert(chat.messages.at(-1).content.includes(saved.marker));assert(chat.codexContext?.inputTokens>0);
 const calls=chat.display.filter(item=>item.toolName==='mcp_call');assert(calls.some(item=>{const args=JSON.parse(item.details).arguments;return args.toolName==='read_context'&&args.connectorId===saved.connectors.stdio.id;}));assert(!chat.display.some(item=>item.toolStatus==='running'));assert(!chat.display.some(item=>item.toolName==='mcp_call'&&item.toolStatus==='attention'));
 await page.setViewportSize({width:1000,height:720});await page.screenshot({path:path.join(root,'actual-model-native-read-dark-1000.png')});
 pass('Actual Codex and DeepSeek discover configured plugin tools and report data not present in the prompt',{conversationId:saved.modelConversationId,actualAnswer:chat.messages.at(-1).content,inputTokens:chat.codexContext.inputTokens});
 const schedule=await rpc('ai_schedules_create',{conversationId:saved.modelConversationId,name:'Actual MCP runtime closed-window QA',prompt,nextRunAt:new Date(Date.now()+9000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const status=await rpc('background_status');assert.equal(status.activeAiTurns,0);await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();});closed=true;await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close();}).catch(error=>{if(!error.message.includes('closed'))throw error;});
 pass('Actual desktop closes before the owned one-time schedule is due',{scheduleId:saved.scheduleId});report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'model-failure.png')}).catch(()=>{});throw error;}
finally{if(!closed&&saved.scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false}).catch(()=>{});await browser.close().catch(()=>{});}
