// Refresh only an idle development window and expand the existing reasoning record.
// Never resume the real turn or initiate a model request/download.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/reasoning-scroll-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page,'Development window unavailable');
 const turnId='c9da4c8d-df69-46cf-bc12-6aa72533efc3';
 async function snapshot(){return page.evaluate(async turnId=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,background=await invoke('background_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('User work is active; refresh deferred');
  const proof=await invoke('billing_run_snapshot',{runId:turnId}),current=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');
  if(proof.conversationId!==current)throw new Error('The user changed conversations; refresh deferred');
  const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
  const chat=localStateEntries().filter(([key])=>key.startsWith('geod-agent-conversations-0.1')).flatMap(([,value])=>JSON.parse(value)).find(c=>c.conversationId===current);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(chat.display)));
  return {current,generationCount:proof.generations.length,historyHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};
 },turnId);}
 const before=await snapshot();await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,before.current);
 await page.getByRole('status',{name:'本轮未完成'}).waitFor();
 const group=page.locator('.agent-work-records').last(),groupTrigger=group.locator('.agent-work-records-trigger');
 if(await groupTrigger.getAttribute('aria-expanded')!=='true')await groupTrigger.click();
 const reasoningTrigger=group.locator('.agent-work-record-trigger').filter({hasText:'思考已停止'}).last();await reasoningTrigger.click();
 const inner=page.getByLabel('模型思考详情').last();await inner.waitFor();await page.waitForTimeout(350);await inner.scrollIntoViewIfNeeded();
 const measure=await inner.evaluate(e=>({height:e.clientHeight,contentHeight:e.scrollHeight,maxHeight:parseFloat(getComputedStyle(e).maxHeight),textLength:e.textContent.length}));
 assert(measure.height<=measure.maxHeight+1&&measure.contentHeight>measure.height*3,'the actual long reasoning must scroll inside the height cap');
 const outer=page.locator('.agent-messages-viewport'),outerBefore=await outer.evaluate(e=>e.scrollTop);
 await inner.evaluate(e=>{e.scrollTop=e.scrollHeight;});assert.equal(await outer.evaluate(e=>e.scrollTop),outerBefore);
 const after=await snapshot();assert.equal(after.historyHash,before.historyHash,'expanding and scrolling must not modify the saved history');assert.equal(after.generationCount,before.generationCount,'the UI check must not call the model');
 assert.equal(await page.locator('[role="dialog"] #mcp-provider-key').count(),0);
 await page.screenshot({path:join(output,'native-reasoning-scroll.png')});
 const report={passed:true,modelCalls:0,refreshedIdleWindow:true,historyPreserved:true,generationCount:after.generationCount,...measure};writeFileSync(join(output,'native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
