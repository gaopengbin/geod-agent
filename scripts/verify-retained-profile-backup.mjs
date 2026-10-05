// Use the actual development settings dialog; never restore over the live profile.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const expectedFile=resolve(process.argv[2]??'');
const expected=JSON.parse(readFileSync(expectedFile,'utf8')).state.application;
const root=resolve('artifacts/retained-profile-backup-20261005');mkdirSync(root);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page,opened=false;const report={passed:false,startedAt:new Date().toISOString(),actualDesktop:true,installed:false,productionModified:false};
const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)?value:String(value)).digest('hex');
const write=(name,value)=>writeFileSync(join(root,name),JSON.stringify(value,null,2));
async function application(){
  const state=await page.evaluate(async()=>{
    const {snapshotLocalRecords}=await import('/src/local-state.ts');const records=Object.fromEntries((await snapshotLocalRecords()).entries);
    const key=Object.keys(records).find(k=>k.startsWith('geod-agent-conversations-0.1:account:'));if(!key)throw Error('Original conversations missing');
    return {history:records[key],active:records['geod-agent-active-conversation-0.1:account:'+key.split(':account:')[1]],pending:Object.fromEntries(Object.entries(records).filter(([k])=>k.includes('pending'))),language:records['geod-agent-language-v1']};
  });
  return {count:JSON.parse(state.history).length,sha256:hash(state.history),active:state.active,pending:Object.fromEntries(Object.entries(state.pending).map(([k,v])=>[k,hash(v)])),language:state.language};
}
async function background(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts');return api.backgroundStatus();});}
function protectedProcesses(){
  const p=spawnSync('python',['-X','utf8','-c','import psutil,json; print(json.dumps([{ "pid":pid,"created":psutil.Process(pid).create_time(),"exe":psutil.Process(pid).exe()} for pid in [70224,59112]]))'],{encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
try{
  page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://127.0.0.1:1420/');assert(page);
  assert.equal(await page.getByRole('dialog').count(),0,'Do not replace an existing user dialog');
  const before=await application();assert.deepEqual(before,expected);const beforeBackground=await background();
  assert(beforeBackground.running);assert.equal(beforeBackground.activeDownloads,0);assert.equal(beforeBackground.activeCommands,0);assert.equal(beforeBackground.activeAiTurns,0);assert(!beforeBackground.maintenanceActive);
  const originalProcesses=protectedProcesses();write('before.json',{application:before,background:beforeBackground,protectedProcesses:originalProcesses});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.evaluate(()=>window.dispatchEvent(new Event('geod:desktop-settings-open')));opened=true;
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:/^(备份记录|Back up records)$/}).click();
  await dialog.locator('.desktop-backup-result code').waitFor({timeout:120000});
  const backupPath=await dialog.locator('.desktop-backup-result code').textContent();assert(backupPath);
  await page.screenshot({path:join(root,'actual-backup-dialog.png')});
  const verified=spawnSync('python',['-X','utf8','scripts/verify-desktop-backup-files.py',backupPath,'--expected-state',join(root,'before.json')],{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});assert.equal(verified.status,0,verified.stderr);
  const restored=JSON.parse(verified.stdout);assert(restored.passed&&restored.retainedRawStateVerified);
  const after=await application();assert.deepEqual(after,before);const afterBackground=await background();
  assert(afterBackground.running);assert.equal(afterBackground.activeAiTurns,0);assert.equal(afterBackground.activeCommands,0);assert.equal(afterBackground.activeDownloads,0);assert(!afterBackground.maintenanceActive);
  assert.notEqual(afterBackground.pid,beforeBackground.pid,'Maintenance must resume a fresh background process');
  assert.deepEqual(protectedProcesses(),originalProcesses);assert.deepEqual(errors,[]);
  const manifest=JSON.parse(readFileSync(join(backupPath,'manifest.json'),'utf8'));
  write('after.json',{application:after,background:afterBackground,protectedProcesses:originalProcesses});
  Object.assign(report,{passed:true,backupPath,manifestSha256:hash(readFileSync(join(backupPath,'manifest.json'))),restored,
    conversations:after.count,pendingRecordsVerified:Object.keys(after.pending).length,
    previousBackgroundPid:beforeBackground.pid,resumedBackgroundPid:afterBackground.pid,
    foregroundAndGatewayPreserved:true,backupVersion:manifest.fromVersion,finishedAt:new Date().toISOString(),pageErrors:errors});
  write('result.json',report);console.log(JSON.stringify({passed:true,conversations:after.count,pendingRecordsVerified:report.pendingRecordsVerified,restored,previousBackgroundPid:beforeBackground.pid,resumedBackgroundPid:afterBackground.pid}));
}catch(error){write('attempt.json',{...report,error:String(error)});throw error;}
finally{if(opened)await page.keyboard.press('Escape').catch(()=>{});await browser.close();}
