// Refresh the idle development window and verify its actual mounted component.
// No model requests, business tools, connector probes or credential values.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/chat-activity-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
 const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
 assert(page,'development window unavailable');
 const before=await page.evaluate(async()=>{
  const background=await window.__TAURI_INTERNALS__.invoke('background_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('User work is active; refresh deferred');
  const current=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');
  const installed=await window.__TAURI_INTERNALS__.invoke('extensions_list');
  const providers=installed.connectors.filter(c=>['https://mcp.amap.com/mcp','https://mcp.mapbox.com/mcp'].includes(c.url)).map(c=>({id:c.id,url:c.url,enabled:c.enabled,queryNames:c.queryNames,headerNames:c.headerNames}));
  const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
  return {current,providers};
 });
 // Recheck immediately before refreshing; a user can start another turn at any time.
 await page.evaluate(async()=>{
  const background=await window.__TAURI_INTERNALS__.invoke('background_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('User work is active; refresh deferred');
 });
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,before.current);
 await page.locator('.agent-messages').waitFor();
 const after=await page.evaluate(async()=>{
  const element=document.querySelector('.agent-messages');
  const fiberKey=Object.keys(element).find(key=>key.startsWith('__reactFiber$'));
  let activityComponentLoaded=false;
  for(let fiber=element[fiberKey];fiber;fiber=fiber.return){
   if(fiber.type?.name==='ChatTranscript'){
    activityComponentLoaded=String(fiber.type).includes('agent-live-status');break;
   }
  }
  const installed=await window.__TAURI_INTERNALS__.invoke('extensions_list');
  return {activityComponentLoaded,activeConversation:document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id'),stopButton:!!document.querySelector('button[aria-label="停止回复"]'),statusCount:document.querySelectorAll('.agent-live-status').length,credentialDialogs:document.querySelectorAll('[role="dialog"] #mcp-provider-key').length,providers:installed.connectors.filter(c=>['https://mcp.amap.com/mcp','https://mcp.mapbox.com/mcp'].includes(c.url)).map(c=>({id:c.id,url:c.url,enabled:c.enabled,queryNames:c.queryNames,headerNames:c.headerNames}))};
 });
 assert(after.activityComponentLoaded,'the mounted transcript must contain the new fixed activity indicator');
 assert.equal(after.activeConversation,before.current);
 assert.deepEqual(after.providers,before.providers);
 if(!after.stopButton)assert.equal(after.statusCount,0,'an idle window must not infer activity from old reasoning records');
 assert.equal(after.credentialDialogs,0,'old provider setup history must not reopen a credential dialog');
 const report={passed:true,refreshedIdleWindow:true,modelCalls:0,...after};
 writeFileSync(join(output,'native-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
} finally {await browser.close();}
