import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
  const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
  assert.equal(await page.locator('.conversation-running-dot').count(),0,'A conversation is still executing');
  const state=await page.evaluate(async()=>{
    const {api}=await import('/src/api.ts'),{invoke}=await import('/node_modules/.vite/deps/@tauri-apps_api_core.js');
    const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
    const active=await api.jobsActive();if(active.length)throw new Error('An imagery job is active; rebuild deferred');
    const status=await invoke('background_status');if(status.activeAiTurns>0)throw new Error('A background AI turn is active; rebuild deferred');
    await invoke('background_stop');return {saved:true,activeImagery:active.length,backgroundStopped:true};
  });
  console.log(JSON.stringify(state));
  await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close();}).catch(error=>{if(!error.message.includes('has been closed'))throw error;});
}finally{await browser.close().catch(()=>{});}
