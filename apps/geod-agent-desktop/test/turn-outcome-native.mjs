// Inspect authoritative native receipts and refresh only an idle development window.
// Never press the real resume button or invoke a model/download for this check.
import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/turn-outcome-20261007');mkdirSync(output,{recursive:true});const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 const turnId='c9da4c8d-df69-46cf-bc12-6aa72533efc3';
 async function snapshot(){return page.evaluate(async turnId=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,background=await invoke('background_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('User work is active; refresh deferred');
  const proof=await invoke('billing_run_snapshot',{runId:turnId}),current=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');
  if(proof.conversationId!==current)throw new Error('The user changed conversations; refresh deferred');
  const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
  const chats=localStateEntries().filter(([key])=>key.startsWith('geod-agent-conversations-0.1')).flatMap(([,value])=>JSON.parse(value));
  const chat=chats.find(c=>c.conversationId===current);
  const original=chat.display.filter(m=>m.turnId===turnId&&!m.turnOutcome);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(original)));const originalHash=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {current,runStatus:proof.status,generationCount:proof.generations.length,originalHash,outcomes:chat.display.filter(m=>m.turnOutcome&&m.turnId===turnId).map(m=>({id:m.id,status:m.turnOutcome.status,code:m.turnOutcome.code,generationId:m.turnOutcome.generationId}))};
 },turnId);}
 const before=await snapshot();await page.reload({waitUntil:'domcontentloaded'});
 const outcome=page.getByRole('status',{name:'本轮未完成'});await outcome.waitFor();assert.match(await outcome.textContent(),/模型只返回了思考/);assert(await outcome.getByRole('button',{name:'继续处理'}).isEnabled());assert.equal(await page.locator('.agent-live-status').count(),0);
 await page.waitForFunction(turnId=>!document.querySelector('button[aria-label="停止回复"]')&&document.querySelectorAll('.agent-turn-outcome').length===1,turnId);
 const after=await snapshot();assert.equal(after.originalHash,before.originalHash,'Original questions, answers, reasoning and tool records must remain unchanged');assert.equal(after.generationCount,before.generationCount,'History correction must not initiate a new model request');assert.equal(after.outcomes.length,1);assert.equal(after.outcomes[0].status,'incomplete');assert.equal(after.outcomes[0].code,'MODEL_EMPTY_RESPONSE');
 await page.reload({waitUntil:'domcontentloaded'});await outcome.waitFor();const restored=await snapshot();assert.deepEqual(restored.outcomes,after.outcomes);assert.equal(restored.generationCount,before.generationCount);assert.equal(restored.originalHash,before.originalHash);
 await outcome.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'native-incomplete.png')});const report={passed:true,modelCalls:0,refreshedIdleWindow:true,historyPreserved:true,originalNativeRunStatus:before.runStatus,generationCount:after.generationCount,outcome:after.outcomes[0],continueAvailable:true,persistedAcrossReload:true};writeFileSync(join(output,'native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
