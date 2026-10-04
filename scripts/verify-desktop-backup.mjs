/** Actual native dialog, maintenance gates, persisted records and isolated restore. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile), {chromium}=await import(pathToFileURL(process.argv[2]).href);
const output=path.resolve('artifacts/product-gaps-20261004/desktop-backup');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('textarea:not([disabled])').waitFor();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const conversationId=randomUUID(),runId=randomUUID(),markerKey=`geod-backup-acceptance-${randomUUID()}`,markerValue=randomUUID();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return {value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {error};}},{command,args});if(result.error)throw result.error;return result.value;};
const snapshot=()=>page.evaluate(async()=>{const {snapshotLocalRecords}=await import('/src/local-state.ts');return snapshotLocalRecords();});
const wait=async(predicate,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Native acceptance timed out');};
const original=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}));
let commandId,report={passed:false,cases:[]};
try{
  assert.equal(await page.locator('.conversation-running-dot').count(),0,'Existing conversation is executing');
  const initial=await rpc('background_status');assert.equal(initial.activeDownloads,0);assert.equal(initial.activeCommands,0);assert.equal(initial.activeAiTurns,0);
  await rpc('workspace_set',{conversationId,directory:output,permission:'fullAccess'});
  const prepared=await rpc('background_command_prepare',{conversationId,idempotencyKey:randomUUID(),draft:{title:'备份运行中命令门禁验收',command:['powershell.exe','-NoProfile','-Command',"Write-Output 'BACKUP_GATE_STARTED'; Start-Sleep -Seconds 12; Write-Output 'BACKUP_GATE_FINISHED'"]}});
  commandId=prepared.command.id;await rpc('background_command_start',{conversationId,commandId,planHash:prepared.command.planHash,confirmed:false});
  await wait(async()=>{const command=await rpc('background_command_get',{conversationId,commandId});return command.status==='running'&&command.stdout.includes('BACKUP_GATE_STARTED')?command:null;});
  let rejected;try{await rpc('desktop_backup_create',{uiState:await snapshot()});}catch(error){rejected=error;}
  assert.equal(rejected?.code,'BACKGROUND_BUSY',JSON.stringify(rejected));
  const completed=await wait(async()=>{const command=await rpc('background_command_get',{conversationId,commandId});return command.status==='completed'?command:null;});assert(completed.stdout.includes('BACKUP_GATE_FINISHED'));
  report.cases.push({name:'Active background command prevents backup and finishes normally',code:rejected.code,passed:true});
  await page.evaluate(async({runId,conversationId})=>{
    const {api}=await import('/src/api.ts');window.__backupTurn={events:[],started:true};
    void api.codexTurn(runId,conversationId,"备份门禁验收：必须实际执行 powershell.exe -NoProfile -Command \"Start-Sleep -Seconds 12; Write-Output 'BACKUP_FOREGROUND_FINISHED'\"，等命令完成后只回复实际输出标记。",[],event=>window.__backupTurn.events.push(event)).then(result=>{window.__backupTurn.result=result;}).catch(error=>{window.__backupTurn.error={code:error.code,message:error.message};}).finally(()=>{window.__backupTurn.finished=true;});
  },{runId,conversationId});
  await new Promise(resolve=>setTimeout(resolve,700));let foregroundRejected;
  try{await rpc('desktop_backup_create',{uiState:await snapshot()});}catch(error){foregroundRejected=error;}
  assert.equal(foregroundRejected?.code,'UPDATE_TASKS_ACTIVE',JSON.stringify(foregroundRejected));
  await page.waitForFunction(()=>window.__backupTurn?.finished,null,{timeout:180000});
  const foreground=await page.evaluate(()=>window.__backupTurn);assert.equal(foreground.result?.status,'completed',JSON.stringify(foreground.error));assert(foreground.result.text.includes('BACKUP_FOREGROUND_FINISHED'));assert(foreground.events.some(event=>JSON.stringify(event).includes('commandExecution')));
  fs.writeFileSync(path.join(output,'actual-foreground-turn.json'),JSON.stringify(foreground,null,2));
  report.cases.push({name:'Actual foreground Codex turn prevents backup and finishes normally',code:foregroundRejected.code,passed:true});
  const beforeInvalid=await rpc('background_status');let invalid;
  try{await rpc('desktop_backup_create',{uiState:{schemaVersion:1,entries:[['unrelated-account','invalid']]}});}catch(error){invalid=error;}
  assert.equal(invalid?.code,'UPDATE_BACKUP');const afterInvalid=await rpc('background_status');assert.equal(afterInvalid.pid,beforeInvalid.pid);
  report.cases.push({name:'Invalid UI records rejected before stopping background',passed:true});
  await page.evaluate(({markerKey,markerValue})=>localStorage.setItem(markerKey,markerValue),{markerKey,markerValue});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';window.dispatchEvent(new Event('geod:desktop-settings-open'));});
  await page.setViewportSize({width:1000,height:720});const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Back up records',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Back up records',exact:true}).click();
  await dialog.locator('.desktop-backup-result').waitFor({timeout:90000});
  const backupPath=await dialog.locator('.desktop-backup-result code').textContent();assert(backupPath);
  await page.screenshot({path:path.join(output,'backup-dark-en.png')});
  const restored=JSON.parse((await exec('python',['-X','utf8','scripts/verify-desktop-backup-files.py',backupPath,'--marker-key',markerKey,'--marker-value',markerValue,'--command-id',commandId],{cwd:process.cwd(),windowsHide:true,maxBuffer:4*1024*1024})).stdout);
  const resumed=await rpc('background_status');assert.equal(resumed.running,true);assert.notEqual(resumed.pid,beforeInvalid.pid);assert.equal(resumed.activeCommands,0);
  report.cases.push({name:'Native dialog creates verified full records; prior background resumes',passed:true,backupPath,restored});
  const settingsBounds=await dialog.evaluate(element=>({height:element.getBoundingClientRect().height,overflow:element.scrollWidth>element.clientWidth,screenOverflow:document.documentElement.scrollWidth>innerWidth}));assert(settingsBounds.height<=672);assert.equal(settingsBounds.overflow,false);assert.equal(settingsBounds.screenOverflow,false);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await rpc('background_stop');const stoppedSnapshot=await rpc('desktop_backup_create',{uiState:await snapshot()});assert.equal(stoppedSnapshot.verified,true);assert.equal((await rpc('background_status')).running,false);
  report.cases.push({name:'Explicitly stopped background remains stopped after backup',passed:true});
  await rpc('background_start');assert.equal((await rpc('background_status')).running,true);
  assert.deepEqual(errors,[]);report={...report,passed:true,actualDesktop:true,pageErrors:errors,layout:settingsBounds};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.map(item=>item.name),restored}));
}catch(error){fs.writeFileSync(path.join(output,'attempt.json'),JSON.stringify({...report,error:{message:error.message,...error}},null,2));throw error;}
finally{
  await page.evaluate(async runId=>{const {api}=await import('/src/api.ts');if(window.__backupTurn&&!window.__backupTurn.finished)await api.codexCommand(runId,{type:'interrupt'});},runId).catch(()=>{});
  if(commandId)await rpc('background_command_stop',{conversationId,commandId}).catch(()=>{});
  await rpc('background_start').catch(()=>{});await page.keyboard.press('Escape').catch(()=>{});
  await page.evaluate(async({original,markerKey})=>{localStorage.removeItem(markerKey);const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{original,markerKey}).catch(()=>{});
  await page.setViewportSize({width:original.width,height:original.height});await browser.close();
}
