import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out='../../artifacts/turn-token-icon-20261010';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[],errors=[];
try {
 for(const theme of ['light','dark'])for(const locale of ['zh-CN','en']) {
  const page=await browser.newPage({viewport:{width:570,height:760}});page.on('pageerror',error=>errors.push(error.message));
  await page.route(/^https:\/\//,route=>route.abort());
  await page.addInitScript(()=>{
   window.isTauri=true;window.__usageCalls=[];
   window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
    window.__usageCalls.push(command);
    if(command==='billing_run_snapshot')return {conversationId:'fixture',status:'completed',generations:[
     {generationId:'a',state:'settled',inputTokens:20558,outputTokens:38,cachedInputTokens:3328,reasoningTokens:13},
     {generationId:'b',state:'settled',inputTokens:100,outputTokens:20,cachedInputTokens:80,reasoningTokens:10},
    ]};
    throw Error(`Unexpected mutation/command: ${command}`);
   }};
  });
  await page.goto(`http://127.0.0.1:1420/test/turn-token-usage-harness.html?theme=${theme}&locale=${locale}`);
  const footer=page.locator('.agent-turn-token-usage');
  await page.waitForFunction(()=>document.querySelector('.agent-turn-token-usage')?.dataset.usageStatus==='complete');
  assert.equal(await footer.count(),1);assert.equal(await page.locator('.agent-work-records .agent-turn-token-usage').count(),0);
  assert.equal(await footer.textContent(),'','statistics are hidden in the icon tooltip');
  const [copyBounds,iconBounds]=await page.evaluate(()=>['.agent-message-actions .chat-copy','.agent-turn-token-usage'].map(selector=>{
   const rect=document.querySelector(selector).getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  }));
  assert(iconBounds.x>=copyBounds.x+copyBounds.width,'statistics icon is directly to the right of copy');
  assert(Math.abs(iconBounds.y-copyBounds.y)<1);assert(Math.abs(iconBounds.width-copyBounds.width)<.1);assert(Math.abs(iconBounds.height-copyBounds.height)<.1);
  await footer.hover();
  const tooltip=page.getByRole('tooltip');await tooltip.waitFor();
  assert.match(await tooltip.textContent(),/20,716/);assert.match(await tooltip.textContent(),/20,658/);assert.match(await tooltip.textContent(),/58/);
  assert.match(await tooltip.textContent(),locale==='en'?/Turn usage.*Input.*Output/s:/本轮消耗.*输入.*输出/s);
  assert.match(await tooltip.textContent(),/3,408/);assert.match(await tooltip.textContent(),/23/);
  assert.match(await tooltip.textContent(),locale==='en'?/included in input/:/已包含在输入/);
  await page.screenshot({path:`${out}/${theme}-${locale}-details.png`});
  await page.mouse.move(550,740,{steps:8});await tooltip.waitFor({state:'hidden'});
  await footer.focus();await tooltip.waitFor();assert.match(await tooltip.textContent(),/20,716/);
  await footer.evaluate(el=>el.blur());
  await tooltip.waitFor({state:'hidden'});
  await page.screenshot({path:`${out}/${theme}-${locale}.png`});
  await page.setViewportSize({width:360,height:760});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const bounds=await footer.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=360);
  await page.screenshot({path:`${out}/${theme}-${locale}-narrow.png`});
  await footer.hover();await tooltip.waitFor();
  const tooltipBounds=await tooltip.boundingBox();assert(tooltipBounds.x>=0&&tooltipBounds.x+tooltipBounds.width<=360);
  assert.equal(await tooltip.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.screenshot({path:`${out}/${theme}-${locale}-narrow-details.png`});
  await page.reload();await footer.waitFor();
  await footer.focus();await tooltip.waitFor();assert.match(await tooltip.textContent(),/20,716/);
  assert.deepEqual(await page.evaluate(()=>window.__usageCalls),[],'persisted actual usage needs no repeat native requests');
  checks.push(`${theme}/${locale}: statistics icon right of copy; hover and keyboard details; no inline counts; 360px tooltip; saved usage survives reload`);
  await page.close();
 }
 for(const state of ['partial','pending','unavailable','stopped','streaming']) {
  const page=await browser.newPage({viewport:{width:360,height:760}});page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({state})=>{
   window.isTauri=true;window.__usageCalls=[];window.__settled=false;
   window.__TAURI_INTERNALS__={invoke:async(command)=>{
    window.__usageCalls.push(command);
    if(command==='billing_run_snapshot') {
     if(state==='unavailable')throw Error('missing receipt');
     const actual={generationId:'a',state:'settled',inputTokens:100,outputTokens:10};
     return {conversationId:'fixture',status:'completed',generations:state==='partial'?[actual,{generationId:'b',state:'settled',usageKnown:false}]:state==='pending'&&!window.__settled?[{generationId:'a',state:'requested'}]:[actual]};
    }
    if(command==='agent_generation_get')throw Error('usage not yet available');
    throw Error(`Unexpected mutation/command: ${command}`);
   }};
  },{state});
  await page.goto(`http://127.0.0.1:1420/test/turn-token-usage-harness.html?theme=dark&state=${state}`);
  const footer=page.locator('.agent-turn-token-usage');
  if(state==='streaming'){assert.equal(await footer.count(),0);assert.deepEqual(await page.evaluate(()=>window.__usageCalls),[]);}
  else {
   await page.waitForFunction(expected=>document.querySelector('.agent-turn-token-usage')?.dataset.usageStatus===expected,state==='stopped'?'complete':state);
   assert.equal(await footer.count(),1);
   await footer.hover();const tooltip=page.getByRole('tooltip');await tooltip.waitFor();
   if(state==='partial')assert.match(await tooltip.textContent(),/已知用量.*110/s);
   if(state==='unavailable')assert.match(await tooltip.textContent(),/用量不可用/);
   if(state==='pending'){
    assert.match(await tooltip.textContent(),/用量待核对/);
    await page.evaluate(()=>{window.__settled=true;});await footer.click();
    await page.waitForFunction(()=>document.querySelector('.agent-turn-token-usage')?.dataset.usageStatus==='complete');
    await page.mouse.move(340,740,{steps:8});await footer.hover();await tooltip.waitFor();assert.match(await tooltip.textContent(),/本轮消耗.*110/s);
   }
   const calls=await page.evaluate(()=>window.__usageCalls);assert(calls.every(command=>['billing_run_snapshot','agent_generation_get'].includes(command)));
   await page.screenshot({path:`${out}/${state}-dark-narrow.png`});
  }
  checks.push(`${state}: status in tooltip; icon retry reads receipts only; no usage requests while streaming`);
  await page.close();
 }
 assert.deepEqual(errors,[]);const result={passed:true,fixture:true,modelCalls:0,checks,errors};
 writeFileSync(`${out}/acceptance.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();}
