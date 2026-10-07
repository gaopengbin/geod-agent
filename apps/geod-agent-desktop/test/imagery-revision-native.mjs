// Repair the proven redundant question in the current development conversation.
// Stop only its obsolete waiting turn; never send a new generation or download.
import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/imagery-revision-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
 const before=await page.evaluate(async()=>{
  const {api}=await import('/src/api.ts');const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
  const conversationId='0b3f3b0a-19ca-4fe9-a70a-ae1524f6864e';if(document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')!==conversationId)throw new Error('User changed conversations');
  const background=await window.__TAURI_INTERNALS__.invoke('background_status');if(background.activeCommands||background.activeDownloads||background.activeAiTurns)throw new Error('Work beyond the obsolete question is active');
  const chat=localStateEntries().filter(([k])=>k.startsWith('geod-agent-conversations-0.1')).flatMap(([,v])=>JSON.parse(v)).find(c=>c.conversationId===conversationId);
  const {resolvedRevisionQuestions}=await import('/src/imagery-revision.ts?native-check='+Date.now());
  const next=await resolvedRevisionQuestions(chat.display,chat.planIds??[],null,api.plansGet);
  const q=chat.display.find(m=>m.id==='question-crs-72c2dabb-f6fa-43a7-be45-ae971df55576'),fixed=next.find(m=>m.id===q?.id);
  if(!q||fixed.userInput?.resolution?.crs!=='EPSG:4326')throw new Error('The old question is not proven redundant');
  const proof=await api.billingRunSnapshot(q.turnId);if(proof.conversationId!==conversationId)throw new Error('Unexpected native run scope');
  const priorPlan=await api.plansGet(fixed.userInput.resolution.planId);
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const originalHash=await hash(chat.display.filter(m=>m.id!==q.id));
  if(proof.status==='running')await api.codexCommand(q.turnId,{type:'interrupt'});
  return {conversationId,questionId:q.id,runId:q.turnId,generations:proof.generations.length,planIds:chat.planIds,planHash:priorPlan.plan.planHash,originalHash,draft:q.userInput.draft,choice:fixed.userInput.resolution};
 });
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(id=>[...document.querySelectorAll('.user-input-request')].some(e=>e.textContent.includes('已沿用原任务坐标系')),before.questionId,{timeout:30000});
 const card=page.locator('.user-input-request').filter({hasText:'已沿用原任务坐标系'}).last();
 const trigger=card.locator('.user-input-request-trigger');if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
 assert.match(await card.textContent(),/EPSG:4326/);assert.equal(await card.locator('input[type="radio"]').count(),0);
 assert(await card.getByRole('button',{name:'继续调整计划'}).isEnabled());
 let after;
 for(let i=0;i<40;i++){
  after=await page.evaluate(async before=>{
   const {api}=await import('/src/api.ts');const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
   const chat=localStateEntries().filter(([k])=>k.startsWith('geod-agent-conversations-0.1')).flatMap(([,v])=>JSON.parse(v)).find(c=>c.conversationId===before.conversationId),q=chat.display.find(m=>m.id===before.questionId);
   const proof=await api.billingRunSnapshot(before.runId),plan=await api.plansGet(before.choice.planId),workspace=await api.workspaceGet(before.conversationId);
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(chat.display.filter(m=>m.id!==q.id)))))].map(x=>x.toString(16).padStart(2,'0')).join('');
   return {runStatus:proof.status,generations:proof.generations.length,planIds:chat.planIds,planHash:plan.plan.planHash,originalHash:hash,draft:q.userInput.draft,status:q.userInput.status,resolution:q.userInput.resolution,reply:q.userInput.reply,conversationDefault:workspace.outputCrs??null,stopButton:!!document.querySelector('button[aria-label="停止回复"]')};
  },before);
  if(after.runStatus!=='running')break;await delay(250);
 }
 assert.equal(after.generations,before.generations);assert.deepEqual(after.planIds,before.planIds);assert.equal(after.planHash,before.planHash);assert.equal(after.originalHash,before.originalHash);
 assert.deepEqual(after.draft,before.draft);assert.equal(after.status,'resolved');assert.equal(after.reply,undefined);assert.equal(after.conversationDefault,null);assert.equal(after.stopButton,false);assert.notEqual(after.runStatus,'running');
 await page.waitForFunction(()=>document.querySelector('.agent-primary textarea')?.disabled===false);
 await card.getByRole('button',{name:'继续调整计划'}).scrollIntoViewIfNeeded();
 await page.screenshot({path:join(output,'native-inherited-crs.png')});
 await page.reload({waitUntil:'domcontentloaded'});await page.locator('.user-input-request').filter({hasText:'已沿用原任务坐标系'}).last().waitFor();
 const report={passed:true,nativeOwnedPlanVerified:true,choice:after.resolution,questionResolvedWithoutFabricatedAnswer:true,userDraftPreserved:true,originalHistoryPreserved:true,originalPlanPreserved:true,noConversationDefault:true,obsoleteRunStatus:after.runStatus,generationCountUnchanged:after.generations,paidModelCalls:0,downloadJobsStarted:0,continueAvailable:true,composerRecovered:true,persistedAcrossReload:true};
 writeFileSync(join(output,'native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
