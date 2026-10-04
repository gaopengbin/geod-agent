/** Finish remaining checks using the real command already retained by the prior run. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),{chromium}=await import(pathToFileURL(process.argv[2]).href),commandId=process.argv[3];assert(commandId);
const output=path.resolve('artifacts/product-gaps-20261004/desktop-backup'),prior=JSON.parse(fs.readFileSync(path.join(output,'attempt.json'),'utf8'));
assert.equal(prior.cases.length,3);assert(prior.cases.every(item=>item.passed));
const foreground=JSON.parse(fs.readFileSync(path.join(output,'actual-foreground-turn.json'),'utf8'));assert.equal(foreground.result.status,'completed');assert(foreground.result.text.includes('BACKUP_FOREGROUND_FINISHED'));
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('textarea:not([disabled])').waitFor();const errors=[];page.on('pageerror',error=>errors.push(error.message));
const rpc=(command,args={})=>page.evaluate(async({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const original=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}));
const markerKey=`geod-backup-acceptance-${randomUUID()}`,markerValue=randomUUID();
try{
  const before=await rpc('background_status');assert.equal(before.activeDownloads,0);assert.equal(before.activeCommands,0);assert.equal(before.activeAiTurns,0);
  await page.evaluate(async({markerKey,markerValue})=>{localStorage.setItem(markerKey,markerValue);const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';window.dispatchEvent(new Event('geod:desktop-settings-open'));},{markerKey,markerValue});
  await page.setViewportSize({width:1000,height:720});const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Back up records',exact:true}).click();await dialog.locator('.desktop-backup-result').waitFor({timeout:90000});
  const backupPath=await dialog.locator('.desktop-backup-result code').textContent();assert(backupPath);await page.screenshot({path:path.join(output,'backup-dark-en.png')});
  const restored=JSON.parse((await exec('python',['-X','utf8','scripts/verify-desktop-backup-files.py',backupPath,'--marker-key',markerKey,'--marker-value',markerValue,'--command-id',commandId],{windowsHide:true,maxBuffer:4*1024*1024})).stdout);
  const resumed=await rpc('background_status');assert.equal(resumed.running,true);assert.notEqual(resumed.pid,before.pid);
  const layout=await dialog.evaluate(element=>{const bounds=element.getBoundingClientRect(),done=element.querySelector('.permission-dialog-actions button').getBoundingClientRect();return {height:bounds.height,overflow:element.scrollWidth>element.clientWidth,screenOverflow:document.documentElement.scrollWidth>innerWidth,doneVisible:done.bottom<innerHeight&&done.top>=bounds.top,footerOutsideScrollingBody:!element.querySelector('.desktop-settings-scroll').contains(element.querySelector('.permission-dialog-actions'))};});assert(layout.height<=672);assert.equal(layout.overflow,false);assert.equal(layout.screenOverflow,false);assert(layout.doneVisible&&layout.footerOutsideScrollingBody);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await rpc('background_stop');const snapshot=await page.evaluate(async()=>{const {snapshotLocalRecords}=await import('/src/local-state.ts');return snapshotLocalRecords();});const second=await rpc('desktop_backup_create',{uiState:snapshot});assert.equal(second.verified,true);assert.equal((await rpc('background_status')).running,false);
  await rpc('background_start');assert.equal((await rpc('background_status')).running,true);assert.deepEqual(errors,[]);
  const report={passed:true,actualDesktop:true,stagedVerification:true,priorHarnessIssues:['Canonical Windows temp alias comparison fixed','SQLite verification handles explicitly closed before temp cleanup'],cases:[...prior.cases,{name:'Actual UI snapshot and isolated restore',passed:true,backupPath,restored},{name:'Prior background restarts after snapshot',passed:true},{name:'Explicitly stopped background remains stopped',passed:true}],layout,pageErrors:errors};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  await rpc('background_start').catch(()=>{});await page.keyboard.press('Escape').catch(()=>{});
  await page.evaluate(async({original,markerKey})=>{localStorage.removeItem(markerKey);const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{original,markerKey}).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height});await browser.close();
}
