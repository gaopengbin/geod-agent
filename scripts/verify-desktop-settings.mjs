import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('textarea:not([disabled])').waitFor();
const output=path.resolve('artifacts/product-gaps-20261004/desktop-settings');fs.mkdirSync(output,{recursive:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const original=await page.evaluate(async()=>{
  const {api}=await import('/src/api.ts');
  const {appDataDir}=await import('/node_modules/@tauri-apps/api/path.js');
  return {settings:await api.desktopSettings(),root:await appDataDir(),language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme};
});
const preferencesFile=path.join(original.root,'desktop-settings.json');
const preferences=fs.existsSync(preferencesFile)?fs.readFileSync(preferencesFile):null;
const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',name='GeoD Agent (development)';
const registry=()=>{try{return execFileSync('reg.exe',['query',key,'/v',name],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();}catch{return null;}};
const originalEntry=registry();
const mode=async name=>assert.equal((await fetch('http://127.0.0.1:16451/mode',{method:'POST',body:name})).status,204);
const dialog=()=>page.getByRole('dialog');
async function check(){await dialog().getByRole('button',{name:/检查更新|Check for updates/,exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.desktop-update-actions button[disabled]'));}
async function rejectsInvalidPayload(name){
  await mode(name);await check();
  await dialog().getByRole('button',{name:/下载更新|Download update/,exact:true}).click();
  await dialog().getByRole('alert').waitFor();
  const text=await dialog().getByRole('alert').textContent();assert.match(text,/签名验证失败/);
  assert.equal(await dialog().getByRole('button',{name:'重启并安装',exact:true}).count(),0);
  return text;
}
try{
  assert(original.settings.development);assert(original.settings.updateConfigured);
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.locator('.conversation-account-trigger').click();
  await page.getByRole('button',{name:/^应用设置/}).click();await dialog().getByRole('switch',{name:'登录系统后在后台运行'}).waitFor();
  const autostart=dialog().getByRole('switch',{name:'登录系统后在后台运行'});
  if((await autostart.getAttribute('aria-checked'))==='true'){await autostart.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='false');}
  await autostart.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true');
  const registered=registry();assert(registered);assert(registered.includes('--background-runtime'));assert(registered.includes('geod-agent-desktop.exe'));
  await autostart.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='false');assert.equal(registry(),null);
  const automatic=dialog().getByRole('switch',{name:'自动检查更新'});
  const before=await automatic.getAttribute('aria-checked');await automatic.click();
  await page.waitForFunction(before=>document.querySelectorAll('[role=switch]')[1]?.getAttribute('aria-checked')!==before,before);
  const saved=await page.evaluate(async()=>{const {api}=await import('/src/api.ts');return api.desktopSettings();});assert.equal(saved.automaticUpdateChecks,before!=='true');
  await mode('valid');await check();await dialog().getByRole('button',{name:'下载更新',exact:true}).click();await dialog().getByText('更新已下载并通过签名验证。',{exact:true}).waitFor();
  const downloaded=fs.readdirSync(path.join(original.root,'updates')).filter(name=>name.endsWith('.exe')).map(name=>path.join(original.root,'updates',name)).find(file=>fs.readFileSync(file).includes(Buffer.from('GeoD signed update acceptance fixture.')));assert(downloaded);
  assert.equal(fs.readFileSync(downloaded).length,88);
  const install=await page.evaluate(async()=>{const {api}=await import('/src/api.ts');try{return {value:await api.desktopUpdateInstall('0.2.1')};}catch(error){return {code:error.code,message:error.message};}});assert.equal(install.code,'UPDATE_DEVELOPMENT');
  assert.equal(await dialog().getByRole('button',{name:'重启并安装',exact:true}).count(),0);
  await page.screenshot({path:path.join(output,'signed-update-ready-zh.png')});
  const tampered=await rejectsInvalidPayload('tampered'),version=await rejectsInvalidPayload('wrong-version');
  await page.screenshot({path:path.join(output,'invalid-signature-rejected-zh.png')});
  await mode('current');await check();await dialog().getByText('已是最新版本。',{exact:true}).waitFor();
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='dark';});
  await dialog().getByRole('heading',{name:'Application settings',exact:true}).waitFor();
  await page.setViewportSize({width:1000,height:720});await page.screenshot({path:path.join(output,'settings-dark-en-narrow.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  const report={passed:true,applicationSettingsActualUi:true,autostartRegisteredBackgroundArgument:true,autostartDisabledAndRemoved:true,automaticPreferenceSaved:true,signedVersion:'0.2.1',signedNonExecutablePayloadAccepted:true,bytes:fs.readFileSync(downloaded).length,tamperedPayloadRejected:tampered,signedVersionMismatchRejected:version,sameVersionUpToDate:true,developmentInstallationBlocked:install.code,englishDarkNarrowWindow:{width:1000,height:720,horizontalOverflow:false},pageErrors:errors};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  fs.unlinkSync(downloaded);
}finally{
  await page.evaluate(async original=>{const {api}=await import('/src/api.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');await api.desktopAutostart(original.settings.autostart);await api.desktopUpdatePreferences(original.settings.automaticUpdateChecks);setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});document.documentElement.dataset.theme=original.theme;},original).catch(()=>{});
  if(preferences)fs.writeFileSync(preferencesFile,preferences);else if(fs.existsSync(preferencesFile))fs.unlinkSync(preferencesFile);
  assert.equal(registry(),originalEntry,'Development startup entry was not restored');
  await mode('valid').catch(()=>{});await page.setViewportSize({width:1440,height:900});await page.reload().catch(()=>{});await browser.close();
}
