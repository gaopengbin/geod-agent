import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/user-input-history-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[],errors=[];
try{for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width:620,height:860}});page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:1420/test/user-input-history-harness.html?theme=${theme}`);
 const trigger=page.locator('.user-input-request-trigger');await trigger.waitFor();assert.match(await trigger.textContent(),/待回答/);assert.equal(await page.getByRole('region',{name:'Agent 等待你的回复'}).count(),0);
 await trigger.click();await page.getByText('3度带 带号 2363',{exact:true}).click();await page.getByRole('button',{name:'下一题'}).click();await trigger.click();
 await page.getByTestId('switch-chat').click();assert.equal(await trigger.count(),0);await page.getByTestId('switch-chat').click();await trigger.waitFor();
 await page.reload();await trigger.waitFor();assert.match(await trigger.textContent(),/待回答/);await trigger.click();assert(await page.getByRole('tab',{name:/应用方式/}).getAttribute('aria-selected')==='true');
 await page.getByRole('button',{name:'上一题'}).click();assert(await page.getByRole('radio').first().isChecked());await page.getByRole('button',{name:'下一题'}).click();await page.getByText('两版都保留',{exact:true}).click();await page.getByRole('button',{name:'提交并继续'}).click();
 await page.waitForFunction(()=>document.querySelector('.user-input-request-trigger')?.textContent.includes('已回答'));await trigger.click();assert(await page.locator('.user-input-answer-list').textContent().then(t=>t.includes('3度带 带号 2363')&&t.includes('两版都保留')));
 await page.screenshot({path:join(output,`answered-${theme}.png`)});await page.reload();await trigger.waitFor();assert.match(await trigger.textContent(),/已回答/);await trigger.click();assert.equal(await page.getByRole('region',{name:'Agent 等待你的回复'}).count(),0);
 checks.push(`${theme}: pending row, open/collapse, switch, reload and draft recovery, submit, answer history`);
 await page.evaluate(()=>localStorage.clear());await page.setViewportSize({width:360,height:860});await page.reload();await trigger.waitFor();await trigger.click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(output,`pending-${theme}-narrow.png`)});
 await page.getByRole('button',{name:'取消本次操作'}).click();await page.waitForFunction(()=>document.querySelector('.user-input-request-trigger')?.textContent.includes('已取消'));await page.reload();await trigger.waitFor();assert.match(await trigger.textContent(),/已取消/);
 checks.push(`${theme}: narrow card, explicit cancel remains in history`);await page.close();
}assert.deepEqual(errors,[]);writeFileSync(join(output,'ui-acceptance.json'),JSON.stringify({passed:true,fixture:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));}finally{await browser.close();}
