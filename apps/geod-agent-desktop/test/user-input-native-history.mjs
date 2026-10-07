import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/user-input-history-20261007');mkdirSync(output,{recursive:true});const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
 const report=await page.evaluate(async()=>{
  const {localStateStore}=await import('/src/local-state.ts'),{answeredCrsChoice}=await import('/src/user-input-records.ts');
  const invoke=window.__TAURI_INTERNALS__.invoke,auth=await invoke('auth_status');const chats=JSON.parse(localStateStore.getItem('geod-agent-conversations-0.1:account:'+auth.userId)||'[]'),id=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');const chat=chats.find(c=>c.conversationId===id);
  const human=[...chat.display].reverse().find(m=>m.role==='user');const choice=answeredCrsChoice(chat.display,human.id);const workspace=await invoke('workspace_get',{conversationId:id});
  return {choice,conversationDefault:workspace.outputCrs,questionCount:chat.display.filter(m=>m.userInput).length,visibleRows:document.querySelectorAll('.user-input-request').length,activeConversation:id};
 });
 assert.equal(report.choice.crs,'EPSG:2363');assert.equal(report.choice.session,false);assert.equal(report.conversationDefault,'EPSG:4490');assert(report.visibleRows>0);
 const target=page.locator('.user-input-request-trigger').filter({hasText:'西安80形式'}).last();await target.scrollIntoViewIfNeeded();await target.click();
 await page.locator('.user-input-answer-list').filter({hasText:'3度带 带号 2363'}).last().waitFor();await page.screenshot({path:join(output,'native-restored-answer.png')});await target.click();
 writeFileSync(join(output,'native-history.json'),JSON.stringify({passed:true,actualNativeUi:true,modelCalls:0,...report},null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{await browser.close();}
