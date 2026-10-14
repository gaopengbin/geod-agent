// Real WebView2 composition events + native source preview. No login or model calls.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const output=resolve('../../artifacts/input-source-20261012');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
assert(page);const report={checks:[]};
try{
 await page.route('http://127.0.0.1:1420/**',async route=>{
   try{const response=await route.fetch({url:route.request().url().replace(':1420',':1426'),maxRetries:3});await route.fulfill({response});}
   catch{await route.abort().catch(()=>{});}
 });
 await page.goto('http://127.0.0.1:1420/test/input-source-harness.html');
 const input=page.getByRole('textbox',{name:'输入验证'});await input.waitFor();await input.focus();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.agent-start-content')).transform==='none');
 const session=await page.context().newCDPSession(page);
 const height=(await input.boundingBox()).height;
 await session.send('Input.imeSetComposition',{text:'zhongwen'.repeat(20),selectionStart:160,selectionEnd:160});
 assert.equal(await page.locator('output').textContent(),'','Uncommitted spelling must not reach parent draft');
 assert.equal((await input.boundingBox()).height,height,'Do not move the candidate anchor during composition');
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter'});
 await input.evaluate(el=>el.form.requestSubmit());
 assert.deepEqual(await page.evaluate(()=>window.qa.submissions),[],'IME Enter and form submission must not send spelling');
 console.log('IME preedit checks passed');
 await session.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
 await session.send('Input.insertText',{text:'中文输入'});
 await page.waitForFunction(()=>document.querySelector('output').textContent==='中文输入');
 assert.equal(await input.inputValue(),'中文输入');
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229});
 assert.deepEqual(await page.evaluate(()=>window.qa.submissions),[],'Legacy IME keyCode must not send');
 await input.press('Shift+Enter');assert.equal(await page.evaluate(()=>window.qa.submissions.length),0);
 await input.press('Enter');assert.equal(await page.evaluate(()=>window.qa.submissions.length),1);
 report.checks.push('composition draft isolation, stable caret layout, commit, IME Enter/229, newline and single send');
 console.log('IME renderer checks passed');
 assert.deepEqual(await page.locator('.agent-start-content').evaluate(el=>({transform:getComputedStyle(el).transform,filter:getComputedStyle(el).filter})),{transform:'none',filter:'none'});
 report.checks.push('no persistent transform/filter around the start-page input');
 const actual=await page.evaluate(async()=>{
   const {api}=await import('/src/api.ts'), {rasterPreset,separateUrlToken}=await import('/src/source-presets.ts');
   const {getSourceThumbnail}=await import('/src/source-thumbnails.ts');
   const before=await api.sourcesList();const draft=rasterPreset('esri-world-imagery');
   // Same connection path as manually pasted addresses; fixed query value is retained.
   draft.source.id='qa-unsaved-esri';draft.source.urlTemplate=separateUrlToken(draft.source.urlTemplate.replace('{z}','%7BTileMatrix%7D').replace('{y}','{TileRow}').replace('{x}','{TileCol}')+'?fixed=kept%2Bvalue').url;
   const image=await getSourceThumbnail({draft},true);
   const automatic=await getSourceThumbnail({draft:rasterPreset('esri-world-imagery')},true);
   return {registeredUnchanged:JSON.stringify(before)===JSON.stringify(await api.sourcesList()),manualBytes:image.url.length,automaticBytes:automatic.url.length,sample:image.tile,image:image.url};
 });
 assert(actual.registeredUnchanged);assert(actual.manualBytes>1000&&actual.automaticBytes>1000);
 report.checks.push('real Esri tile: manual mixed/encoded URL and preset both display without registering a source');
 console.log('Real manual/preset preview checks passed');
 const encoded=actual.image.split(',')[1];delete actual.image;report.actual=actual;
 // Controlled stuck native request: it must release its queue slot and permit a subsequent preview.
 await page.clock.install();
 await page.evaluate(async encoded=>{
  const {api}=await import('/src/api.ts'),{getSourceThumbnail}=await import('/src/source-thumbnails.ts'),{rasterPreset}=await import('/src/source-presets.ts');
  window.qa.previewOriginal=api.sourcePreviewTile;let calls=0;
  api.sourcePreviewTile=()=>++calls<=2?new Promise(()=>{}):Promise.resolve(encoded);
  const draft=rasterPreset('esri-world-imagery');draft.source.urlTemplate='https://tiles.example.org/{z}/{x}/{y}';
  window.qa.requests=[1,2,3].map(revision=>getSourceThumbnail({draft,revision},true).then(()=>({ok:true}),e=>({error:e.message})));
 },encoded);
 await page.clock.runFor(30_100);
 const stalled=await page.evaluate(async()=>{const results=await Promise.all(window.qa.requests);window.api.sourcePreviewTile=window.qa.previewOriginal;return results;});
 assert(stalled[0].error.includes('超时'));assert(stalled[1].error.includes('超时'));assert.equal(stalled[2].ok,true);
 report.stalled=stalled;report.checks.push('two stuck requests time out, queue releases and third preview succeeds');
 await page.clock.resume();
 await page.evaluate(encoded=>{window.api.sourcePreviewTile=()=>{if(!window.qa.retryFailed){window.qa.retryFailed=true;return Promise.reject(new Error('图源连接失败（受控验证）'));}return Promise.resolve(encoded);};},encoded);
 await page.getByRole('button',{name:'预览验证',exact:true}).click();
 const retry=page.getByRole('button',{name:'重试图源预览'});await retry.waitFor();
 await page.screenshot({path:resolve(output,'source-retry.png')});
 await retry.click();await page.locator('.source-thumbnail-image img').waitFor();
 await page.waitForFunction(()=>document.querySelector('.source-thumbnail-image img').naturalWidth>0);
 await page.evaluate(()=>{window.api.sourcePreviewTile=window.qa.previewOriginal;});
 report.checks.push('failed source card exposes retry; retry replaces error with a visible image');
 await page.screenshot({path:resolve(output,'source-preview.png')});
 await page.getByRole('button',{name:'输入验证',exact:true}).click();
 await page.screenshot({path:resolve(output,'input-renderer.png')});
 report.passed=true;report.finishedAt=new Date().toISOString();writeFileSync(resolve(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
