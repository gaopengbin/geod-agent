import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/rtk-20261007');mkdirSync(output,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[],errors=[];
try{
 for(const theme of ['light','dark']){const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  for(const width of [900,390,300]){
   await page.setViewportSize({width,height:620});await page.goto(`http://127.0.0.1:1420/test/rtk-ui-harness.html?theme=${theme}`);
   const card=page.locator('.rtk-output-tile');await card.getByText('未安装',{exact:true}).waitFor();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await card.getByRole('button',{name:'安装组件',exact:true}).click();await card.getByRole('button',{name:'下载中 50%',exact:true}).waitFor();await page.screenshot({path:join(output,`progress-${theme}-${width}.png`)});
   await page.evaluate(()=>window.rtkFixtureShow(false));await card.waitFor({state:'hidden'});await page.evaluate(()=>window.rtkFixtureShow(true));await card.getByRole('button',{name:'取消安装',exact:true}).waitFor();
   await page.evaluate(()=>window.rtkFixtureFinish());await card.getByText('已启用',{exact:true}).waitFor({timeout:5000});
   await card.getByRole('button',{name:'停用',exact:true}).click();await card.getByText('已停用',{exact:true}).waitFor();await page.screenshot({path:join(output,`disabled-${theme}-${width}.png`)});
   await card.getByRole('button',{name:'启用',exact:true}).click();await card.getByText('已启用',{exact:true}).waitFor();
   const contained=await card.evaluate(tile=>{const r=tile.getBoundingClientRect();return [...tile.querySelectorAll('button')].every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1;});});assert(contained);checks.push(`${theme} ${width}: progress, reattach, enable/disable and contained layout`);
  }
  await page.goto(`http://127.0.0.1:1420/test/rtk-ui-harness.html?theme=${theme}&failure`);await page.getByRole('button',{name:'安装组件',exact:true}).click();await page.getByRole('alert').waitFor();assert((await page.getByRole('alert').textContent()).includes('组件下载失败'));
  await page.getByRole('button',{name:'安装组件',exact:true}).click();await page.getByRole('button',{name:'取消安装',exact:true}).click();await page.getByRole('alert').filter({hasText:'安装已取消'}).waitFor();await page.getByText('未安装',{exact:true}).waitFor();checks.push(`${theme}: retry and cancel controls`);await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(output,'ui-report.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser.close();}
