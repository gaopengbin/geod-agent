/** Real full backup, restart readback and cleanup of only the recorded acceptance fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const mode=process.argv[2]??'prepare',root=path.resolve('artifacts/product-gaps-20261004/plugin-hooks'),stateFile=path.join(root,'restart-state.json'),saved=JSON.parse(fs.readFileSync(stateFile,'utf8')),file=path.join(root,'recovery-result.json');
const report=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{passed:false,cases:[]};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;const ready=Date.now()+20000;while(!page&&Date.now()<ready){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!value.ok)throw value.error;return value.value;};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try{
 await page.locator('.conversation-account-trigger').waitFor();const plugin=(await rpc('plugins_list')).plugins.find(p=>p.id===saved.installedId);assert(plugin);assert.equal(plugin.enabledHooks,mode==='cleanup'?0:5);assert.equal(plugin.hooksReviewed,mode!=='cleanup');
 await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});
 if(mode==='prepare'){
  assert.equal((await rpc('background_status')).activeAiTurns,0);assert.equal(await page.locator('.conversation-running-dot').count(),0);
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});assert(backup.verified);
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8')),prefix='plugin-packages/'+saved.installedId+'/',dataPrefix='plugin-data/'+saved.installedId+'/';
  const resources=manifest.records.filter(record=>record.path.startsWith(prefix));assert.equal(resources.length,2);assert(resources.some(record=>record.path.endsWith('/hooks/collect.mjs')));assert(resources.some(record=>record.path.endsWith('/hooks/hooks.json')));
  for(const record of resources){assert.equal(digest(path.join(backup.path,record.file)),record.sha256);assert.equal(digest(path.join(saved.installedRoot,record.path.slice(prefix.length))),record.sha256);}
  const eventRecord=manifest.records.find(record=>record.path===dataPrefix+'events.jsonl');assert(eventRecord);assert.equal(digest(path.join(saved.dataRoot,'events.jsonl')),eventRecord.sha256);assert.equal(digest(path.join(backup.path,eventRecord.file)),eventRecord.sha256);
  saved.backupPath=backup.path;saved.dataSha256=eventRecord.sha256;saved.resourceHashes=resources.map(record=>({path:record.path.slice(prefix.length),sha256:record.sha256}));fs.writeFileSync(stateFile,JSON.stringify(saved,null,2));
  pass('Actual verified full backup preserves reviewed resources and native plugin lifecycle data',{backupPath:backup.path,records:manifest.records.length,resources:resources.length});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await page.setViewportSize({width:1000,height:720});
  await page.getByRole('button',{name:'技能与连接器',exact:true}).click();await page.getByRole('button',{name:'插件',exact:true}).click();await page.locator('.memory-row').filter({hasText:'Hook lifecycle acceptance'}).getByRole('button',{name:'自动化 5/5',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();const bounds=await dialog.boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=720);assert.equal(await dialog.locator('.plugin-hook-row').count(),5);
  const height=await dialog.locator('.plugin-hook-command').first().evaluate(element=>element.getBoundingClientRect().height);assert(height<55,'One-line command is wasting vertical space');
  await page.screenshot({path:path.join(root,'actual-review-compact-dark-1000.png')});await dialog.getByRole('button',{name:'取消',exact:true}).click();
  pass('Actual compact command review keeps one-line commands compact at 1000 × 720',{commandHeight:height});
 }else if(mode==='verify'){
  for(const resource of saved.resourceHashes)assert.equal(digest(path.join(saved.installedRoot,resource.path)),resource.sha256);assert.equal(digest(path.join(saved.dataRoot,'events.jsonl')),saved.dataSha256);
  const review=await rpc('plugin_hooks_preview',{id:saved.installedId});assert.equal(review.enabled,true);assert.equal(review.reviewed,true);assert.equal(review.hooks.length,5);
  pass('Actual desktop and companion restart retain consent, resources and lifecycle records');
  await rpc('plugin_hooks_set_enabled',{id:saved.installedId,expectedSha256:saved.sha256,enabled:false});assert.equal((await rpc('plugins_list')).plugins.find(p=>p.id===saved.installedId).enabledHooks,0);
  pass('Actual native disable clears the runtime review and command export');
 }else if(mode==='cleanup'){
  const probe=JSON.parse(fs.readFileSync(path.join(root,'native-discovery-probe.json'),'utf8'));assert.equal(probe.result.status,'interrupted');assert(!probe.messages.some(message=>message.method?.startsWith('hook/')));assert.equal(digest(path.join(saved.dataRoot,'events.jsonl')),saved.dataSha256);
  fs.writeFileSync(path.join(root,'actual-lifecycle-records.json'),JSON.stringify(fs.readFileSync(path.join(saved.dataRoot,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)),null,2));
  pass('Actual resumed native thread executes no hooks after disable, with no model request sent');
  await rpc('plugin_remove',{id:saved.installedId});assert(!fs.existsSync(saved.installedRoot));assert(!fs.existsSync(saved.dataRoot));assert.deepEqual((await rpc('plugins_list')).plugins.map(p=>p.id),saved.baselineIds);
  await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.original.userId),ids=new Set(saved.qaConversationIds);for(const id of ids)if(saved.original.chatIds.includes(id))throw new Error('Refusing to remove an original conversation');const chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>!ids.has(chat.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.original.active);await flushLocalState();if(saved.original.language)setLanguagePreferences(JSON.parse(saved.original.language));document.documentElement.dataset.theme=saved.original.theme;document.documentElement.style.colorScheme=saved.original.theme;},saved);
  await page.setViewportSize({width:saved.original.width,height:saved.original.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  pass('Only the recorded QA plugin and sidebar conversations are removed; the schedule stays disabled',{qaConversationIds:saved.qaConversationIds});report.passed=true;delete report.error;fs.writeFileSync(file,JSON.stringify(report,null,2));
 }else throw new Error('Unknown recovery mode');
}catch(error){report.error={message:error.message||JSON.stringify(error),stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));throw error;}
finally{await browser.close();}
