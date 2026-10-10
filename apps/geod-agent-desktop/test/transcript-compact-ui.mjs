import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out='../../artifacts/transcript-compact-20261009';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],errors=[];
try{
 for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width:1050,height:920}});
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https:\/\//,route=>route.abort());
  await page.goto(`http://127.0.0.1:1420/test/transcript-compact-harness.html?theme=${theme}`);
  const work=page.locator('.agent-work-records'),trigger=work.locator('.agent-work-records-trigger');
  await trigger.waitFor();assert.equal(await work.count(),1);
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.user-input-request').count(),0);
  assert.equal(await page.locator('.background-job-row,.background-job-trigger').count(),0);
  assert.equal(await page.locator('.transcript-task-group').count(),1);
  assert.match(await page.locator('.transcript-task-group').textContent(),/13 项影像任务/);
  assert.match(await trigger.textContent(),/120/);
  await page.screenshot({path:`${out}/completed-${theme}.png`});
  await trigger.click();await page.locator('.user-input-request-trigger').first().waitFor();
  assert.equal(await work.locator('.user-input-request').count(),3);
  await work.locator('.user-input-request-trigger').first().click();
  await page.locator('.user-input-answer-list').waitFor();assert.match(await page.locator('.user-input-answer-list').textContent(),/EPSG:4326/);
  await trigger.click();await page.locator('.user-input-request').first().waitFor({state:'detached'});
  checks.push(`${theme}: one completed work group, question history reopenable inside it, one 13-task summary, no download rows`);
  await page.getByTestId('waiting').click();
  await page.locator('.user-input-request.pending').waitFor();
  assert.equal(await page.locator('.user-input-request.pending .user-input-request-trigger').getAttribute('aria-expanded'),'true');
  await page.getByRole('radio',{name:/EPSG:4326/}).click();
  await page.getByRole('button',{name:'提交并继续'}).click();
  await page.getByTestId('completed').click();
  await page.waitForFunction(()=>document.querySelector('.agent-work-records-trigger')?.getAttribute('aria-expanded')==='false'&&!document.querySelector('.user-input-request'));
  checks.push(`${theme}: waiting question remains accessible; answering and finishing folds questions and work`);
  await page.locator('.transcript-task-group button').click();await page.getByTestId('results-panel').waitFor();
  assert.match(await page.getByTestId('results-panel').textContent(),/13/);
  await page.screenshot({path:`${out}/results-${theme}.png`});checks.push(`${theme}: summary opens real task panel`);
  await page.reload();await trigger.waitFor();assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  await page.setViewportSize({width:380,height:820});await page.waitForTimeout(150);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${out}/completed-${theme}-narrow.png`});
  checks.push(`${theme}: restored completed view stays compact at 380px`);await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(`${out}/acceptance.json`,JSON.stringify({passed:true,fixture:true,modelCalls:0,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser.close();}
