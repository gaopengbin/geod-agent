import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out=resolve('../../artifacts/analytics/20261021-two-days/activity-ui');mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:1443/test/activity-telemetry-harness.html');const toggle=page.getByRole('button',{name:/Agent 使用统计/});await toggle.waitFor();
 assert.equal(await toggle.getAttribute('aria-pressed'),'false');await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Switch account'}).click();await page.getByRole('button',{name:'账号与设置',exact:true}).click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 await page.waitForFunction(()=>window.activityTestCalls.some(c=>c.command==='agent_activity_set'&&c.args.accountId==='test-B'));
 const calls=await page.evaluate(()=>window.activityTestCalls.filter(c=>c.command==='agent_activity_set'));
 assert(calls.some(c=>c.args.accountId==='test-A'&&c.args.enabled));assert(calls.filter(c=>c.args.accountId==='test-B').every(c=>c.args.enabled===false));
 await page.getByRole('button',{name:'Switch account'}).click();await page.getByRole('button',{name:'账号与设置',exact:true}).click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 assert.equal(await page.getByRole('button',{name:/下载使用统计/}).getAttribute('aria-pressed'),'false');
 await page.screenshot({path:join(out,'consent-light.png')});await page.setViewportSize({width:390,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:join(out,'consent-narrow-dark.png')});
 const bounds=await toggle.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};});assert(bounds.left>=0&&bounds.right<=bounds.width);assert.deepEqual(errors,[]);
 const result={passed:true,checks:['default off','explicit enable and disable','account isolation without transient opt-in','download consent unchanged','narrow theme layout'],modelCalls:0,productionModified:false};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
