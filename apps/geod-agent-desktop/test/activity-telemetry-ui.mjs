import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out=resolve('../../artifacts/default-diagnostics-20261029/activity-ui');mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.addInitScript(()=>localStorage.setItem('geod-agent-activity-consent-v1:test-B','disabled'));
 await page.goto((process.env.GEOD_DIAGNOSTIC_UI_URL??'http://127.0.0.1:1443')+'/test/activity-telemetry-harness.html');const toggle=page.getByRole('button',{name:/Agent 使用统计/});await toggle.waitFor();
 await page.waitForFunction(()=>document.querySelector('button[aria-pressed="true"]')?.textContent?.includes('下载')&&[...document.querySelectorAll('button[aria-pressed="true"]')].some(v=>v.textContent?.includes('Agent 使用统计')));
 assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 assert.deepEqual(await page.evaluate(()=>window.activityTestCalls.filter(c=>c.command==='agent_activity_set')),[]);
 await page.screenshot({path:join(out,'default-on-disclosure.png')});await page.setViewportSize({width:390,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.keyboard.press('Escape');await page.locator('[data-morph-popover-portal]').waitFor({state:'detached'});await page.screenshot({path:join(out,'default-on-disclosure-narrow-dark.png')});
 const overflow=await page.locator('.download-consent-notice').evaluate(el=>{const r=el.getBoundingClientRect();return {right:r.right,width:innerWidth,scroll:el.scrollWidth,client:el.clientWidth};});assert(overflow.right<=overflow.width&&overflow.scroll<=overflow.client+1);
 await page.getByRole('button',{name:'知道了',exact:true}).click();await page.getByRole('button',{name:'账号与设置',exact:true}).click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 await toggle.click();await page.waitForFunction(()=>[...document.querySelectorAll('button[aria-pressed="false"]')].some(v=>v.textContent?.includes('Agent 使用统计')));
 await page.getByRole('button',{name:'Switch account'}).click();await page.getByRole('button',{name:'账号与设置',exact:true}).click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 await page.waitForFunction(()=>window.activityTestCalls.some(c=>c.command==='agent_activity_status'&&c.args.accountId==='test-B'));
 const calls=await page.evaluate(()=>window.activityTestCalls.filter(c=>c.command==='agent_activity_set'));
 assert(calls.some(c=>c.args.accountId==='test-A'&&c.args.enabled===false));assert.equal(calls.filter(c=>c.args.accountId==='test-B').length,0);
 await page.getByRole('button',{name:'Switch account'}).click();await page.getByRole('button',{name:'账号与设置',exact:true}).click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');await toggle.click();await page.waitForFunction(()=>[...document.querySelectorAll('button[aria-pressed="true"]')].some(v=>v.textContent?.includes('Agent 使用统计')));
 assert.equal(await page.getByRole('button',{name:/下载使用统计/}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:join(out,'consent-light.png')});await page.setViewportSize({width:390,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:join(out,'consent-narrow-dark.png')});
 const bounds=await toggle.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};});assert(bounds.left>=0&&bounds.right<=bounds.width);assert.deepEqual(errors,[]);
 const result={passed:true,checks:['default on without an automatic disable write','acknowledging notice does not change reporting','explicit enable and disable','account-specific legacy opt-out migration','narrow dark disclosure layout'],modelCalls:0,productionModified:false};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
