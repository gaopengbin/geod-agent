/** Back up and restart the real App bindings, then remove only the recorded QA objects. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-apps'),mode=process.argv[2];assert(['prepare','finish'].includes(mode));
const savedFile=path.join(root,'restart-state.json'),saved=JSON.parse(fs.readFileSync(savedFile,'utf8')),file=path.join(root,'recovery-result.json');
const report=mode==='prepare'?{passed:false,cases:[]}:JSON.parse(fs.readFileSync(file,'utf8'));assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!result.ok)throw result.error;return result.value;};
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const chats=()=>page.evaluate(async userId=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();return JSON.parse(accountChatStore(localStateStore,userId).getItem(CHAT_LIST_KEY)||'[]')},saved.userId);
try{
 await page.locator('.conversation-account-trigger').waitFor();await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});assert.equal((await rpc('background_status')).activeAiTurns,0);assert.equal(await page.locator('.conversation-running-dot').count(),0);
 const overview=await rpc('extensions_list'),metadata={connectors:overview.connectors.filter(c=>saved.connectorIds.includes(c.id)),apps:overview.registeredApps.filter(a=>saved.pluginIds.includes(a.pluginId))};assert.equal(metadata.connectors.length,1);assert.equal(metadata.apps.length,3);
 const skill=await rpc('skill_read',{name:'geod-apps-qa-read-apps'});assert(skill.includes(saved.skillMarker));assert(skill.includes(saved.installedRoot.replaceAll('\\','/')));
 if(mode==='prepare'){
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords())});assert(backup.verified);
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8')),prefix='plugin-packages/'+saved.pluginId+'/',resources=manifest.records.filter(r=>r.path.startsWith(prefix));assert.equal(resources.length,4);
  for(const r of resources){assert.equal(digest(path.join(backup.path,r.file)),r.sha256);assert.equal(digest(path.join(saved.installedRoot,r.path.slice(prefix.length))),r.sha256)}
  const configRecord=manifest.records.find(r=>r.path==='agent-extensions.json');assert(configRecord);const config=JSON.parse(fs.readFileSync(path.join(backup.path,configRecord.file),'utf8')),record=config.plugins.find(p=>p.id===saved.pluginId),cloud=config.plugins.find(p=>p.id===saved.appOnlyPluginId);
  assert.equal(record.mcpServerIds.notes,saved.connectors.notes.id);assert.deepEqual(record.registeredApps.map(a=>[a.name,a.id]),[['calendar',saved.calendarId],['notes',saved.notesId]]);assert.equal(cloud.registeredApps[0].id,saved.calendarId);assert.equal(cloud.connectorIds.length,0);assert(!resources.some(r=>r.path.endsWith('.app.json')||r.path.endsWith('plugin.json')));
  saved.preRestart={metadata,backup,resources:resources.map(r=>({path:r.path.slice(prefix.length),sha256:r.sha256}))};fs.writeFileSync(savedFile,JSON.stringify(saved,null,2));
  pass('Actual full backup preserves registered App declarations and the owned MCP binding separately from exact installed resources',{records:manifest.records.length,resources:resources.length,backupPath:backup.path});
 }else{
  assert.deepEqual(metadata,saved.preRestart.metadata);for(const r of saved.preRestart.resources)assert.equal(digest(path.join(saved.installedRoot,r.path)),r.sha256);
  const value=await rpc('mcp_call',{id:saved.connectors.notes.id,conversationId:saved.conversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}),actual=JSON.parse(value.content.find(c=>c.type==='text').text);assert.equal(actual.marker,saved.marker);assert(actual.inheritedVariable&&actual.explicitEnvOverride&&!actual.bridgeVisible);
  pass('Actual desktop and companion restart preserve unavailable App metadata and execute the same owned bundled MCP',{actualRead:actual});
  const current=await chats();fs.writeFileSync(path.join(root,'actual-qa-conversations.json'),JSON.stringify(current.filter(c=>saved.qaConversationIds.includes(c.conversationId)),null,2));
  for(const id of saved.pluginIds)await rpc('plugin_remove',{id});const removed=await rpc('extensions_list');assert(!removed.registeredApps.some(a=>saved.pluginIds.includes(a.pluginId)));assert(!fs.existsSync(saved.installedRoot));await assert.rejects(rpc('mcp_call',{id:saved.connectors.notes.id,conversationId:saved.conversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}),error=>error.code==='MCP_NOT_FOUND');await assert.rejects(rpc('skill_read',{name:'geod-apps-qa-read-apps'}),error=>error.code==='SKILL_NOT_ENABLED');
  await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId),ids=new Set(saved.qaConversationIds);for(const id of ids)if(saved.baselineChatIds.includes(id))throw new Error('Refusing to remove an original conversation');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(c=>!ids.has(c.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);await flushLocalState();if(saved.settings.language)setLanguagePreferences(JSON.parse(saved.settings.language));document.documentElement.dataset.theme=saved.settings.theme;document.documentElement.style.colorScheme=saved.settings.theme},saved);
  await page.setViewportSize({width:saved.settings.width,height:saved.settings.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  const original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8')),restored=await chats();assert.equal(restored.length,30);const restoredById=new Map(restored.map(c=>[c.conversationId,c]));for(const expected of original)assert.deepEqual(restoredById.get(expected.conversationId),expected);
  const active=await page.evaluate(async userId=>{const {localStateStore}=await import('/src/local-state.ts'),{accountChatStore}=await import('/src/pending-generations.ts');return accountChatStore(localStateStore,userId).getItem('geod-agent-active-conversation-0.1')},saved.userId);assert.equal(active,saved.originalActive);
  fs.writeFileSync(path.join(root,'original-conversations-result.json'),JSON.stringify({passed:true,count:30,strictContentMatch:true,originalSelection:active},null,2));
  pass('Only recorded QA plugins and conversation are removed; schedule is off, removed capabilities cannot execute and all 30 original records match strictly');report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
 }
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));throw error;}
finally{await browser.close()}
