import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,requestId=crypto.randomUUID();
  const {listen}=await import('/node_modules/@tauri-apps/api/event.js');
  let cancellation;
  const unlisten=await listen('geod:gis-install-progress',event=>{
   if(event.payload.requestId===requestId&&event.payload.phase==='checking'&&!cancellation)cancellation=invoke('gis_install_cancel',{requestId});
  });
  let result;
  try{result=await invoke('gis_skill_install',{id:'gis-raster-convert',directory:null,requestId});}catch(e){result={error:e.code};}finally{unlisten();}
  const cancelled=await cancellation,after=await invoke('gis_install_prepare',{id:'gis-raster-convert'});
  return {cancelled:cancelled?.cancelled,result,componentCachePreserved:after.ready,downloadBytes:after.downloadBytes};
 });
 assert.equal(report.cancelled,true);assert.equal(report.result.error,'GIS_INSTALL_CANCELLED');assert(report.componentCachePreserved);assert.equal(report.downloadBytes,0);
 writeFileSync(resolve('../../artifacts/gis-install-20261007/native-cancel.json'),JSON.stringify({passed:true,actualNativeIpc:true,...report},null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{await browser.close();}
