/** Actual MCP-required-input error path through the closed-window scheduler. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-hooks'),stateFile=path.join(root,'restart-state.json'),saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let n=0;n<100&&!page;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
try{
 await page.locator('.conversation-account-trigger').waitFor();assert.equal((await rpc('background_status')).activeAiTurns,0);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});fs.writeFileSync(saved.controlFile,JSON.stringify({marker:saved.marker,mode:'require-user'}));
 const schedule=await rpc('ai_schedules_create',{conversationId:saved.modelConversationId,name:'Actual MCP Hook required-input QA',prompt:'执行本轮自动化。若连接器要求用户输入，等待用户处理，不运行命令。',nextRunAt:new Date(Date.now()+6000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.requiredInputScheduleId=schedule.scheduleId;fs.writeFileSync(stateFile,JSON.stringify(saved,null,2));
 await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();});await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close();}).catch(error=>{if(!error.message.includes('closed'))throw error;});console.log(JSON.stringify({queued:true,scheduleId:schedule.scheduleId}));
}finally{await browser.close().catch(()=>{});}
