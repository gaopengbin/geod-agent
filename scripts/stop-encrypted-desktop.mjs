import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
 const status=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('background_status'));
 assert.equal(status.activeAiTurns,0);assert.equal(status.activeDownloads,0);assert.equal(status.activeCommands,0);
 assert.equal((await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('background_stop'))).stopped,true);
 await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts'),{getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await flushLocalState();await getCurrentWindow().close()}).catch(error=>{if(!error.message.includes('closed'))throw error});
 console.log(JSON.stringify({normalDesktopCloseRequested:true,normalCompanionStopRequested:true}));
}finally{await browser.close().catch(()=>{})}
