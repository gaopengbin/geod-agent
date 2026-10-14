import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const output=resolve('../../artifacts/task-cleanup-20261012');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[];
try{for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width:700,height:800}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:1426/test/task-cleanup-harness.html?theme='+theme);
 const row=name=>page.locator('.task-queue-row').filter({hasText:name});
 await row('正在下载').waitFor();assert.equal(await row('正在下载').getByRole('button',{name:'清理任务记录',exact:true}).count(),0);
 await page.getByRole('button',{name:'切换失败测试'}).click();await row('未启动影像计划').getByRole('button',{name:'清理任务记录',exact:true}).click();await page.getByRole('alert').filter({hasText:'任务仍在停止中'}).waitFor();
 await page.getByRole('button',{name:'切换失败测试'}).click();await row('未启动影像计划').getByRole('button',{name:'清理任务记录',exact:true}).click();await row('未启动影像计划').waitFor({state:'hidden'});
 await page.getByRole('tab',{name:/已清理/}).click();await row('未启动影像计划').getByRole('button',{name:'恢复任务',exact:true}).click();await row('未启动影像计划').waitFor({state:'hidden'});
 await page.getByRole('tab',{name:/待处理/}).click();await row('未启动影像计划').waitFor();
 await page.getByRole('tab',{name:/已结束/}).click();await page.getByRole('button',{name:'多选',exact:true}).click();await page.getByRole('checkbox',{name:'全选当前列表'}).check();await page.getByRole('button',{name:'清理记录 3',exact:true}).click();
 await page.getByRole('tab',{name:'已清理 3',exact:true}).click();assert.equal(await page.locator('.task-queue-row').count(),3);
 await page.getByRole('button',{name:'完成选择',exact:true}).click();await page.screenshot({path:resolve(output,theme+'.png')});
 await row('矢量成果').getByRole('button',{name:'恢复任务',exact:true}).click();await page.getByRole('tab',{name:/已结束/}).click();await row('矢量成果').waitFor();
 await page.setViewportSize({width:380,height:760});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(output,theme+'-narrow.png')});
 checks.push(theme+': single/batch cleanup, imagery/data restoration, running exclusion, errors and narrow layout');await page.close();
}assert.deepEqual(errors,[]);writeFileSync(resolve(output,'ui-acceptance.json'),JSON.stringify({passed:true,checks,errors,fixture:true},null,2));console.log(JSON.stringify({passed:true,checks}));}finally{await browser.close();}
