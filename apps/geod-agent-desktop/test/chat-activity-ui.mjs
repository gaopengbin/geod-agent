import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/chat-activity-single-20261010');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[];
try {
 for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width:700,height:800}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:1420/test/chat-activity-harness.html?theme=${theme}`);
  const group=page.locator('.agent-work-records').first(),trigger=group.locator('.agent-work-records-trigger'),status=page.getByRole('status',{name:'当前执行状态'});
  await trigger.waitFor();
  assert.equal(await status.count(),1,'a busy turn must have an activity indicator outside the scrollable work history');
  assert.match(await status.textContent(),/正在思考下一步/);
  assert.match(await trigger.textContent(),/思考与执行/);
  assert(!/正在思考|正在处理/.test(await trigger.textContent()),'the history heading is not another activity indicator');
  assert.equal(await trigger.locator('[role="status"]').count(),0);
  await trigger.click();assert.equal(await trigger.getAttribute('aria-expanded'),'false');await status.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.agent-work-records-body'));
  assert(await status.evaluate(e=>!e.closest('.agent-messages')),'status must stay outside the transcript scroller');
  await page.screenshot({path:join(output,`collapsed-${theme}.png`)});
  await trigger.click();
  await group.locator('.agent-work-record-trigger').last().click();
  await page.waitForTimeout(350); // Wait for the existing disclosure transition before measuring/screenshotting.
  const viewport=page.locator('.agent-messages-viewport');
  await viewport.evaluate(e=>{e.scrollTop=0;});
  const before=await status.boundingBox();
  await viewport.evaluate(e=>{e.scrollTop=e.scrollHeight;});
  const after=await status.boundingBox();assert(Math.abs(before.y-after.y)<1,'scrolling long reasoning must not move the activity indicator');
  const composer=await page.getByTestId('composer').boundingBox();assert(after.y+after.height<=composer.y+1);
  await page.screenshot({path:join(output,`long-reasoning-${theme}.png`)});
  for(const [state,label] of [['waiting','等待你的回复'],['tool','正在计算影像计划'],['writing','正在生成回复'],['new-turn','正在等待模型响应'],['active-only','正在思考下一步']]){
   await page.getByTestId(state).click();await page.waitForFunction(label=>document.querySelector('.agent-live-status')?.textContent.includes(label),label);assert.equal(await status.count(),1);await status.waitFor({state:'visible'});
   assert(!await page.locator('.agent-work-records-trigger').evaluateAll(elements=>elements.some(element=>/正在思考|正在计算|正在生成|等待你的回复|正在等待/.test(element.textContent))),'only the pinned status describes the current activity');
   if(state==='new-turn')assert.equal(await page.locator('.agent-work-records.is-active').count(),0,'a new run must not mark an old run active');
   if(state==='waiting'){
    await page.locator('.user-input-request-trigger').click();await page.getByRole('radio',{name:/EPSG:4490/}).click();await page.getByRole('button',{name:'提交并继续'}).click();
    await page.waitForFunction(()=>document.querySelector('.agent-live-status')?.textContent.includes('正在思考下一步'));assert.match(await page.locator('.user-input-request-trigger').textContent(),/已回答/);
   }
  }
  for(const state of ['completed','stopped']){await page.getByTestId(state).click();assert.equal(await status.count(),0,'a finished or stopped turn must not keep showing activity');assert.equal(await page.locator('.agent-work-records.is-active').count(),0);}
  await page.getByTestId('thinking').click();await page.setViewportSize({width:360,height:760});await status.waitFor({state:'visible'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(output,`narrow-${theme}.png`)});
  checks.push(`${theme}: folded history, long reasoning and scroll, question submission resumes activity, waiting, tool, final stream, new turn, active run, completed/stopped and 360px`);
  await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(output,'ui-report.json'),JSON.stringify({passed:true,fixture:true,modelCalls:0,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(cause){
 const page=browser.contexts().flatMap(context=>context.pages()).at(-1);
 if(page){await page.screenshot({path:join(output,'failure.png')});console.error(JSON.stringify({errors,url:page.url(),buttons:await page.locator('header button').allTextContents()}));}
 throw cause;
}finally{await browser.close();}
