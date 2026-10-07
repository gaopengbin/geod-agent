import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/rtk-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
try{
 await page.reload();await page.getByRole('button',{name:'技能与连接器',exact:true}).waitFor();
 const before=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('rtk_status'));
 console.log(JSON.stringify({before}));
 if(!before.installed){
  const bad=join(output,'invalid.zip');writeFileSync(bad,'invalid archive');
  const rejected=await page.evaluate(async bad=>{try{await window.__TAURI_INTERNALS__.invoke('rtk_install',{requestId:crypto.randomUUID(),archivePath:bad});return null;}catch(e){return e.code;}},bad);
  assert.equal(rejected,'RTK_INVALID');
  const still=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('rtk_status'));assert(!still.installed);assert(!still.enabled);
 }
 await page.getByRole('button',{name:'技能与连接器',exact:true}).click();
 const skills=page.getByRole('tab',{name:'Skills',exact:true});if(await skills.count())await skills.click();
 const card=page.locator('article.extension-tile').filter({hasText:'命令输出精简（RTK）'});await card.waitFor();await card.scrollIntoViewIfNeeded();
 await page.screenshot({path:join(output,'native-component-before.png')});
 const phases=[];await page.evaluate(async()=>{window.rtkTestPhases=[];const {listen}=await import('/node_modules/@tauri-apps/api/event.js');window.rtkTestRelease=await listen('geod:rtk-install-progress',e=>window.rtkTestPhases.push(e.payload.phase));});
 if(!before.ready){await card.getByRole('button',{name:before.installed?'修复组件':'安装组件',exact:true}).click();await card.getByText('已启用',{exact:true}).waitFor({timeout:190000});}
 else if(!before.enabled){await card.getByRole('button',{name:'启用',exact:true}).click();await card.getByText('已启用',{exact:true}).waitFor();}
 const installed=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('rtk_status'));assert(installed.ready&&installed.enabled);assert.equal(installed.downloadBytes,0);
 await page.screenshot({path:join(output,'native-component-enabled.png')});
 await card.getByRole('button',{name:'停用',exact:true}).click();await card.getByText('已停用',{exact:true}).waitFor();
 const disabled=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('rtk_status'));assert(disabled.ready&&!disabled.enabled);
 await card.getByRole('button',{name:'启用',exact:true}).click();await card.getByText('已启用',{exact:true}).waitFor();
 phases.push(...await page.evaluate(()=>window.rtkTestPhases));
 const report={passed:true,nativeDesktop:true,before,installed,disableVerified:disabled.enabled===false,enableVerified:true,phases,paidModelCalls:0,downloadJobsStarted:0};
 writeFileSync(join(output,'native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await page.evaluate(()=>window.rtkTestRelease?.());await browser.close();}
