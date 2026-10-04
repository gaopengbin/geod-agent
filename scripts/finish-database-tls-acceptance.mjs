/** Back up, fully restart, then remove only this acceptance run's records. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const mode=process.argv[2];assert(['prepare','restart','cleanup'].includes(mode));
const root=path.resolve('artifacts/product-gaps-20261004/database-tls');
const qa=JSON.parse(fs.readFileSync(path.join(root,'qa-state.json'),'utf8'));
const original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8'));
const providers=['mysql','mariadb','sqlserver','oracle'];
const fixtures=Object.fromEntries(providers.map(p=>[p,JSON.parse(fs.readFileSync(path.join(root,p+'-fixture.json'),'utf8'))]));
const secrets=providers.flatMap(p=>{const folder=path.join(root,'private',p),state=JSON.parse(fs.readFileSync(path.join(folder,'state.json'),'utf8'));return[state.password,state.readerPassword,...fs.readdirSync(folder).filter(n=>n.endsWith('.key')).map(n=>fs.readFileSync(path.join(folder,n),'utf8'))];});
const reportFile=path.join(root,'restart-backup-result.json');
const report=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):{passed:false,cases:[]};
const write=(name,value)=>{const text=JSON.stringify(value,null,2);assert(secrets.every(s=>!text.includes(s)));fs.writeFileSync(path.join(root,name),text);};
const record=(name,detail={})=>{report.cases.push({name,passed:true,...detail});write('restart-backup-result.json',report);console.log(JSON.stringify({name,passed:true}));};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,100));}
assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalized=chat=>{const value={...chat};if(value.pendingId==='')delete value.pendingId;return value;};
const checkChats=async()=>{const current=await state();assert.equal(current.userId,original.userId);for(const chat of original.chats){const actual=current.chats.find(c=>c.conversationId===chat.conversationId);assert(actual,'An original conversation is missing');assert.equal(hash(JSON.stringify(normalized(actual))),hash(JSON.stringify(normalized(chat))),'Original conversation changed: '+chat.conversationId);}return current;};
try{
 assert.equal(await page.locator('.conversation-running-dot').count(),0);
 if(mode==='prepare'){
  for(const scheduleId of qa.schedules)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false});
  const current=await checkChats();
  const processes=await rpc('background_status');assert.equal(processes.activeAiTurns,0);
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));
  for(const record of manifest.records){const content=fs.readFileSync(path.join(backup.path,record.file));assert.equal(hash(content),record.sha256);assert(secrets.every(s=>!content.includes(Buffer.from(s))),'Backup contains a fixture secret');}
  assert(manifest.records.every(r=>!r.path.endsWith('.client-tls')),'Machine-bound client keys must remain in the vault');
  const registry=manifest.records.filter(r=>r.path.startsWith('sql-inputs/')&&r.path.endsWith('/connections.json')).map(r=>fs.readFileSync(path.join(backup.path,r.file),'utf8')).join('\n');
  for(const id of qa.owned)assert(registry.includes(id));
  assert.equal(hash(fs.readFileSync(path.join(backup.path,manifest.uiState.file))),manifest.uiState.sha256);
  qa.backup=backup;qa.preparePids=await page.evaluate(async()=>{const {invoke}=await import('/node_modules/.vite/deps/@tauri-apps_api_core.js');return invoke('background_status');});write('qa-state.json',qa);
  record('Complete backup verifies every record, retains TLS references and excludes passwords and client private keys',{backup,originalChats:original.chats.length,currentChats:current.chats.length});
 }else if(mode==='restart'){
  const receipts=[];
  for(const provider of providers){
   for(const id of [...new Set([qa[provider].connectionId,qa[provider].mutualId].filter(Boolean))]){
    const result=await rpc('sql_query',{connectionId:id,sql:'SELECT marker FROM '+fixtures[provider].table});assert(JSON.stringify(result).includes(fixtures[provider].marker));receipts.push({provider,connectionId:id});
   }
  }
  const result=await rpc('sql_query',{connectionId:qa.uiConnectionId,sql:'SELECT marker FROM '+fixtures.mysql.table});assert(JSON.stringify(result).includes(fixtures.mysql.marker));receipts.push({provider:'mysql-native-form',connectionId:qa.uiConnectionId});
  const connections=(await rpc('sql_connections_list')).connections;for(const receipt of receipts){const connection=connections.find(c=>c.id===receipt.connectionId);assert(connection?.customCa);assert(!Object.hasOwn(connection,'password')&&!Object.hasOwn(connection,'sslClientKey'));}
  await checkChats();record('A full desktop and companion restart restores all seven private-CA and client-certificate connections',{receipts,originalChats:original.chats.length});
 }else{
  await checkChats();
  const listed=(await rpc('sql_connections_list')).connections;
  for(const connectionId of qa.owned)if(listed.some(c=>c.id===connectionId))await rpc('sql_connection_remove',{connectionId});
  const after=(await rpc('sql_connections_list')).connections;assert(after.every(c=>!qa.owned.includes(c.id)));for(const id of qa.baseline)assert(after.some(c=>c.id===id));
  const nativeRoot=path.join(process.env.APPDATA,'dev.geod-agent.desktop','sql-inputs');
  if(fs.existsSync(nativeRoot))for(const owner of fs.readdirSync(nativeRoot)){
   const certs=path.join(nativeRoot,owner,'certificates');if(fs.existsSync(certs))assert(fs.readdirSync(certs).every(n=>!qa.owned.some(id=>n===id+'.client-tls')));
   const tmp=path.join(nativeRoot,owner,'tmp');if(fs.existsSync(tmp))assert(fs.readdirSync(tmp).every(n=>!n.startsWith('.sql-tls-session-')));
  }
  record('Owned test connections and DPAPI client keys are removed; completed sessions leave no plaintext TLS material',{removed:qa.owned.length,unrelatedConnections:after.length});
  const credentialFile=qa.uiCredentialFile;
  if(fs.existsSync(credentialFile.file)){assert.equal(hash(fs.readFileSync(credentialFile.file)),credentialFile.sha256);fs.unlinkSync(credentialFile.file);}
  await page.evaluate(async({userId,uiId,active,language,theme})=>{
   const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY,PENDING_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStateStore,userId);
   const chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(c=>c.conversationId!==uiId)));
   const pending=JSON.parse(store.getItem(PENDING_KEY)||'{}');delete pending[uiId];store.setItem(PENDING_KEY,JSON.stringify(pending));
   if(store.getItem('geod-agent-active-conversation-0.1')===uiId)store.setItem('geod-agent-active-conversation-0.1',active);
   if(language===null)localStorage.removeItem('geod-agent-language-v1');else localStorage.setItem('geod-agent-language-v1',language);
   localStorage.setItem('geod-agent-theme',theme);await flushLocalState();
  },{userId:original.userId,uiId:qa.uiId,active:original.active,language:original.language,theme:original.theme});
  const errors=[];page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('pageerror',error=>errors.push(error.message));
  await page.reload();await page.locator('.conversation-account-trigger').waitFor();await page.setViewportSize({width:original.width,height:original.height});
  const restored=await checkChats();assert(!restored.chats.some(c=>c.conversationId===qa.uiId));
  write('actual-reload-renderer-errors.json',errors);assert.equal(errors.length,0,'The restored interface reported errors');
  record('Original conversations, active view and preferences are restored; the native interface reloads without errors',{originalChats:original.chats.length,totalChats:restored.chats.length});
  report.passed=true;
 }
}catch(error){report.error={code:error?.code,message:error?.message||String(error)};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{write('restart-backup-result.json',report);await browser.close();}
