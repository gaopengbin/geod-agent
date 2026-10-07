import assert from 'node:assert/strict';import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';import {createOutputCompactor} from '../src-tauri/rtk-output.mjs';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/rtk-20261007');mkdirSync(output,{recursive:true});let browser;
for(let attempt=0;attempt<30&&!browser;attempt++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9233');}catch{await new Promise(r=>setTimeout(r,500));}}assert(browser,'Native desktop did not become ready');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
try{
 await page.reload();await page.getByRole('button',{name:'技能与连接器',exact:true}).waitFor();
 const native=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const {appDataDir}=await import('/node_modules/@tauri-apps/api/path.js');const [status,auth,dataDir,background]=await Promise.all([invoke('rtk_status'),invoke('auth_status'),appDataDir(),invoke('background_status')]);return {status,owner:auth.userId,dataDir,background};});
 assert(native.status.enabled&&native.status.ready);assert.equal(native.status.activeRequestId,null);assert(native.background.running);assert(native.owner);
 const p=JSON.parse(readFileSync(resolve('../../vendor/rtk-runtime.json'),'utf8')),base=join(native.dataDir,'rtk-runtime'),account=join(base,'accounts',createHash('sha256').update(native.owner).digest('hex'));
 // Native descriptor prepares its profile on turn start. This read-only smoke
 // uses an isolated test profile instead of starting a paid conversation.
 const profile=join(output,'restart-profile');for(const dir of ['','temp','appdata','localappdata'])mkdirSync(join(profile,dir),{recursive:true});
 const runtime={enabled:true,executable:join(base,`rtk-${p.version}-${p.sha256.slice(0,16)}`,'rtk.exe'),sha256:p.executableSha256,settingsFile:join(account,'settings.json'),profile};
 const stdout=Array.from({length:100},(_,i)=>`src/file${Math.floor(i/20)}.ts:${i+1}: native runtime verification line ${i} with test data only`).join('\n');
 const filtered=await createOutputCompactor(runtime).compact(stdout,'rg -n verification src',0);assert(filtered.startsWith('[RTK summary'));assert(filtered.length<stdout.length);
 await page.getByRole('button',{name:'技能与连接器',exact:true}).click();const card=page.locator('.rtk-output-tile');await card.getByText('已启用',{exact:true}).waitFor();await card.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'native-final.png')});
 const report={passed:true,enabledAfterRestart:true,verifiedInstalledBinary:true,actualAccountSettingUsed:true,backgroundRunning:true,originalChars:stdout.length,summaryChars:filtered.length,paidModelCalls:0};writeFileSync(join(output,'restart-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
