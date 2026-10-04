/** A real model consumes a nested installed skill and inline MCP, then runs with no window. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-manifest'),savedFile=path.join(root,'restart-state.json'),saved=JSON.parse(fs.readFileSync(savedFile,'utf8')),file=path.join(root,'model-result.json'),report={passed:false,cases:[]};
assert(JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(check,label)=>{const deadline=Date.now()+230000;while(Date.now()<deadline){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,400));}throw new Error('Timeout '+label);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};let closed=false;
try{
 await page.locator('.conversation-account-trigger').waitFor();await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
 const expand=page.getByRole('button',{name:'展开会话列表',exact:true});if(await expand.count())await expand.click();await page.locator('[data-conversation-id="'+saved.conversationId+'"]').click();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();assert.equal((await state()).active,saved.conversationId);
 const prompt='插件兼容性验收：先通过 extensions_list 发现“Inline manifest acceptance”的已启用 Skill 和 stdio 工具服务。读取 geod-inline-manifest-qa-read-inline 技能，再通过原生 MCP 调用 read_context 一次。不要使用命令或项目文件。简短报告技能正文中的资源标记和工具实际返回的 marker。';assert(!prompt.includes(saved.marker)&&!prompt.includes(saved.skillMarker));
 let chat=(await state()).chats.find(c=>c.conversationId===saved.conversationId);
 if(!chat?.messages.at(-1)?.content.includes(saved.marker)){
  assert(!process.argv.includes('--verify-existing'),'No saved actual model answer exists');await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
  chat=await wait(async()=>{const current=(await state()).chats.find(c=>c.conversationId===saved.conversationId);return current&&!current.pendingId&&current.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?current:null;},'Actual nested Skill and inline MCP response');
 }
 fs.writeFileSync(path.join(root,'actual-model-chat.json'),JSON.stringify(chat,null,2));assert(chat.messages.at(-1).content.includes(saved.marker));assert(chat.messages.at(-1).content.includes(saved.skillMarker));assert(chat.codexContext?.inputTokens>0);assert(chat.display.some(item=>item.toolName==='skill_read'));assert(chat.display.some(item=>item.toolName==='mcp_call'&&item.toolStatus!=='attention'));assert(!chat.display.some(item=>item.toolStatus==='running'));
 await page.setViewportSize({width:1000,height:720});await page.screenshot({path:path.join(root,'actual-nested-skill-model-dark-1000.png')});
 pass('Actual Codex and DeepSeek read the nested installed Skill and inline native MCP; both markers were absent from the prompt',{conversationId:saved.conversationId,actualAnswer:chat.messages.at(-1).content,inputTokens:chat.codexContext.inputTokens});
 if(!saved.scheduleId){const schedule=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Actual nested Skill and inline MCP closed-window QA',prompt,nextRunAt:new Date(Date.now()+9000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;fs.writeFileSync(savedFile,JSON.stringify(saved,null,2));}
 assert.equal((await rpc('background_status')).activeAiTurns,0);await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState()});closed=true;await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close()}).catch(error=>{if(!error.message.includes('closed'))throw error});
 pass('The real desktop closes before its owned inline-plugin schedule is due',{scheduleId:saved.scheduleId});report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'model-failure.png')}).catch(()=>{});throw error;}
finally{await browser.close().catch(()=>{});if(!closed&&saved.scheduleId)console.log(JSON.stringify({retainedSchedule:saved.scheduleId}));}
