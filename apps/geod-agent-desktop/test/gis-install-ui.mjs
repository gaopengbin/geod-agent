import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/gis-install-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[],errors=[];
try{
 for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:620,height:760}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:1420/test/gis-install-harness.html?theme=${theme}&failure=1`);
  await page.getByRole('region',{name:'安装所需技能'}).waitFor();
  assert.match(await page.locator('.gis-install-size').textContent(),/41.8 MB/);
  await page.screenshot({path:join(output,`install-${theme}.png`)});
  await page.getByRole('button',{name:'下载安装并继续'}).click();
  await page.getByRole('alert').waitFor();assert.equal(await page.getByTestId('reply').count(),0);
  await page.getByRole('button',{name:'重试安装'}).click();
  await page.getByRole('progressbar').waitFor();assert(await page.locator('.gis-install-card footer button').first().isDisabled());
  await page.screenshot({path:join(output,`downloading-${theme}.png`)});
  await page.evaluate(()=>window.gisInstallFixtureNext());
  await page.getByText('正在核验组件…',{exact:true}).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),null);
  await page.evaluate(()=>window.gisInstallFixtureNext());
  await page.getByText('正在安装组件…',{exact:true}).waitFor();
  await page.screenshot({path:join(output,`installing-${theme}.png`)});
  await page.evaluate(()=>window.gisInstallFixtureNext());
  await page.getByTestId('reply').waitFor();assert.deepEqual(JSON.parse(await page.getByTestId('reply').textContent()),{result:'ready'});
  checks.push(`${theme}: failure, retry, real phase rendering, continue after completion`);
  await page.reload();await page.getByRole('button',{name:'暂不安装'}).click();await page.getByTestId('reply').waitFor();assert.deepEqual(JSON.parse(await page.getByTestId('reply').textContent()),{result:'cancelled'});
  await page.setViewportSize({width:360,height:760});await page.reload();await page.getByRole('region',{name:'安装所需技能'}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(output,`install-${theme}-narrow.png`)});
  checks.push(`${theme}: cancel and narrow layout`);await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(output,'ui-acceptance.json'),JSON.stringify({passed:true,fixture:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser.close();}
