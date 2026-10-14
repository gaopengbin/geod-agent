import assert from 'node:assert/strict';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('127.0.0.1:1426'));
 assert(page,'Agent development profile unavailable');
 const result=await page.evaluate(async stop=>{
  const invoke=window.__TAURI_INTERNALS__.invoke;
  const background=await invoke('background_status'),auth=await invoke('auth_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns||background.maintenanceActive)throw new Error('Development runtime has active work');
  if(stop)await invoke('background_stop');
  return {background,authState:auth.state,stopped:stop};
 },process.argv.includes('--stop'));
 console.log(JSON.stringify(result));
}finally{await browser.close();}
