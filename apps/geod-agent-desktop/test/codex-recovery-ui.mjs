import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out='../../artifacts/codex-recovery-20261010';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[],errors=[];
try{
 for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:540,height:850}});page.on('pageerror',error=>errors.push(error.message));
  await page.route(/^https:\/\//,route=>route.abort());
  await page.goto(`http://127.0.0.1:1420/test/transcript-compact-harness.html?busy=1&theme=${theme}`);
  await page.getByText('模型输出达到本次上限',{exact:true}).waitFor();
  assert.equal(await page.getByText('此会话正在处理上一轮请求',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/继续处理/}).count(),0);
  assert.equal(await page.getByText('继续刚才的任务',{exact:true}).count(),3);
  await page.screenshot({path:`${out}/rejected-requests-${theme}.png`});
  checks.push(`${theme}: genuine failure retained; busy request rejections have no failure cards or retry buttons; human messages retained`);
  await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(`${out}/acceptance.json`,JSON.stringify({passed:true,fixture:true,modelCalls:0,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser.close();}
