import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const output=resolve('../../artifacts/channels-layout-20261012');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[],errors=[];
try{
 for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:1426/test/channels-layout-harness.html?theme='+theme);
  await page.getByRole('heading',{name:'我的模型渠道',exact:true}).waitFor();
  assert.equal(await page.locator('.context-settings-panel').count(),0);assert.equal(await page.evaluate(()=>window.channelsLayoutQa.reads),0);
  const size=await page.locator('.ai-channel-settings-row').boundingBox();assert(size.height<120);
  assert((await page.getByRole('heading',{name:'我的模型渠道',exact:true}).boundingBox()).y<550);
  await page.screenshot({path:resolve(output,theme+'-list.png')});
  const trigger=page.getByRole('button',{name:'上下文设置',exact:true});await trigger.click();
  const dialog=page.getByRole('dialog',{name:'上下文设置',exact:true});await dialog.getByRole('spinbutton',{name:'上下文预算（Token）',exact:true}).waitFor();
  await dialog.getByRole('spinbutton',{name:'自动压缩阈值（%）',exact:true}).fill('92');await dialog.getByRole('button',{name:'保存上下文设置',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'已保存'}).waitFor();assert.equal(await page.evaluate(()=>window.channelsLayoutQa.saves),1);
  await page.screenshot({path:resolve(output,theme+'-dialog.png')});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement===document.querySelector('.ai-channel-settings-row > button'));assert(await trigger.evaluate(e=>e===document.activeElement));
  await page.setViewportSize({width:820,height:760});await page.screenshot({path:resolve(output,theme+'-narrow-list.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await trigger.click();await dialog.waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.ai-channel-settings-row > button'));assert(await trigger.evaluate(e=>e===document.activeElement));checks.push(theme+': compact list, lazy settings load, edit/save, Escape/close, focus restoration, 820px layout');await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(resolve(output,'acceptance.json'),JSON.stringify({passed:true,checks,errors,uiFixture:true,realAccountMutations:0},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser.close();}
