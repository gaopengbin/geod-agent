import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out='../../artifacts/final-reply-20261010';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],errors=[];
try {
 for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width:540,height:960}});
  page.on('pageerror',error=>errors.push(error.message));await page.route(/^https:\/\//,route=>route.abort());
  await page.goto(`http://127.0.0.1:1420/test/transcript-compact-harness.html?summary=1&theme=${theme}`);
  await page.locator('.agent-work-records-trigger').waitFor();
  assert.equal(await page.locator('.agent-work-entry.final').count(),0,'Unfinished commentary stays in work');
  await page.getByTestId('complete-reply').click();
  const final=page.locator('.agent-work-entry.final');await final.waitFor();
  assert.equal(await final.count(),1);assert.match(await final.textContent(),/已加载完成/);
  assert.match(await final.textContent(),/GeoD Agent/);assert.equal(await final.locator('table').count(),1);
  const work=page.locator('.agent-work-records');assert.equal(await work.count(),1);
  await page.waitForFunction(()=>document.querySelector('.agent-work-records-trigger')?.getAttribute('aria-expanded')==='false');
  assert.equal(await work.locator('.agent-work-entry.final').count(),0);
  assert.equal(await page.locator('.agent-live-status').count(),0);
  await page.screenshot({path:`${out}/completed-${theme}.png`});
  await work.locator('.agent-work-records-trigger').click();
  assert(!/已加载完成|思考已停止/.test(await work.textContent()));
  assert.match(await work.textContent(),/先核对图源/);
  await page.getByTestId('complete-reply').click();assert.equal(await final.count(),1);
  checks.push(`${theme}: terminal commentary becomes one standalone summary, process stays folded and reopenable, no duplicate or stopped reasoning`);
  await work.locator('.agent-work-records-trigger').click();
  await page.setViewportSize({width:380,height:820});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${out}/completed-${theme}-narrow.png`});
  checks.push(`${theme}: standalone summary remains readable at 380px`);
  await page.close();
 }
 assert.deepEqual(errors,[]);
 const result={passed:true,fixture:true,modelCalls:0,checks,errors};writeFileSync(`${out}/acceptance.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();}
