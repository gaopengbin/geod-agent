import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/gis-install-20261007'),directory=join(output,'workspace');mkdirSync(directory,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
assert(page,'Native desktop must be running');
try{
 const initial=await page.evaluate(async directory=>{const m=await import('/test/gis-install-native-view.tsx');return m.mountNativeInstall(directory);},directory);
 console.log(JSON.stringify({initial:initial.offer.ready?'cached':'missing',downloadBytes:initial.offer.downloadBytes,beforeError:initial.beforeError}));
 if(!initial.offer.ready){
  assert.equal(initial.beforeError,'GIS_SKILL_NOT_INSTALLED');
  await page.getByRole('region',{name:'安装所需技能'}).waitFor();
  await page.screenshot({path:join(output,'native-install-offer.png')});
  await page.getByRole('button',{name:'下载安装并继续'}).click();
  const progress=page.getByRole('progressbar');await progress.waitFor({timeout:20000});
  await page.screenshot({path:join(output,'native-install-progress.png')});
 }
 await page.getByTestId('native-install-reply').waitFor({timeout:180000});
 const report=JSON.parse(await page.getByTestId('native-install-reply').textContent());
 assert.equal(report.state,'ready',JSON.stringify(report));assert(report.ready);assert(report.originalArgumentsPreserved);assert.equal(report.crs,'EPSG:4490');assert.equal(report.compression,'none');assert.equal(report.downloadStarted,false);
 if(!report.wasReady){assert(report.phases.includes('installing'));assert(report.phases.includes('ready'));}
 writeFileSync(join(output,'native-acceptance.json'),JSON.stringify({passed:true,...report},null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{
 await page.evaluate(()=>window.gisInstallTestCleanup?.());await browser.close();
}
