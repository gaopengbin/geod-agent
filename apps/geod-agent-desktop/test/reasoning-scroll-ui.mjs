// Verify the actual transcript component without model requests or saved user data.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/reasoning-scroll-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[];
try {
 for(const theme of ['light','dark'])for(const size of [{width:700,height:800},{width:360,height:600}]) {
  const page=await browser.newPage({viewport:size});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:1420/test/chat-activity-harness.html?theme=${theme}`);
  const group=page.locator('.agent-work-records').first();await group.waitFor();
  assert.equal(await page.locator('.agent-work-reasoning-area').count(),0,'reasoning must start folded');
  await group.locator('.agent-work-record-trigger').last().click();
  const inner=page.getByLabel('模型思考详情'),outer=page.locator('.agent-messages-viewport');await inner.waitFor();
  await page.waitForTimeout(350);await inner.scrollIntoViewIfNeeded();
  const measure=await inner.evaluate(e=>({height:e.clientHeight,contentHeight:e.scrollHeight,paragraphs:e.querySelectorAll('p').length,maxHeight:getComputedStyle(e).maxHeight,overscroll:getComputedStyle(e).overscrollBehavior,tabIndex:e.tabIndex}));
  assert(measure.height<=Math.min(280,size.height*.4)+1,'long reasoning must respect the responsive height cap');
  assert(measure.contentHeight>measure.height*5);assert.equal(measure.paragraphs,200,'all reasoning paragraphs must be retained');
  assert.equal(measure.overscroll,'contain');assert.equal(measure.tabIndex,0);
  const box=await inner.boundingBox(),outerBefore=await outer.evaluate(e=>e.scrollTop);
  await page.mouse.move(box.x+box.width/2,box.y+Math.min(box.height/2,100));await page.mouse.wheel(0,180);
  await page.waitForFunction(()=>document.querySelector('.agent-work-reasoning-area .geod-scroll-viewport').scrollTop>0);
  assert.equal(await outer.evaluate(e=>e.scrollTop),outerBefore,'wheel scrolling reasoning must not scroll the conversation');
  await inner.focus();await inner.evaluate(e=>{e.scrollTop=0;});await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.querySelector('.agent-work-reasoning-area .geod-scroll-viewport').scrollTop>0);
  await inner.evaluate(e=>{e.scrollTop=e.scrollHeight;});
  assert(await inner.evaluate(e=>e.scrollTop+e.clientHeight>=e.scrollHeight-1),'the final paragraph must remain reachable');
  assert.match(await inner.textContent(),/第 100 段/);
  const outerAtEnd=await outer.evaluate(e=>e.scrollTop);await page.mouse.wheel(0,300);await page.waitForTimeout(200);
  assert.equal(await outer.evaluate(e=>e.scrollTop),outerAtEnd,'wheel scrolling at the end must not escape into the conversation');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'coordinates must not widen narrow screens');
  await page.screenshot({path:join(output,`expanded-${theme}-${size.width}.png`)});
  await group.locator('.agent-work-record-trigger').last().click();await inner.waitFor({state:'detached'});
  await page.goto(`http://127.0.0.1:1420/test/chat-activity-harness.html?theme=${theme}&short=1`);
  await page.locator('.agent-work-record-trigger').last().click();await inner.waitFor();await page.waitForTimeout(350);
  const short=await inner.evaluate(e=>({height:e.clientHeight,contentHeight:e.scrollHeight}));
  assert(short.height<100,'short reasoning must keep its natural height');assert.equal(short.contentHeight,short.height);
  checks.push({theme,width:size.width,heightCap:measure.height,contentHeight:measure.contentHeight,shortHeight:short.height,keyboard:true,wheelContained:true,completeContent:true});await page.close();
 }
 assert.deepEqual(errors,[]);const report={passed:true,fixture:true,modelCalls:0,checks,errors};writeFileSync(join(output,'ui-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){const page=browser.contexts().flatMap(c=>c.pages()).at(-1);if(page)await page.screenshot({path:join(output,'failure.png')});throw error;}finally{await browser.close();}
