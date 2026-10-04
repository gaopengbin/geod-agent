/** Actual desktop restart, native credentials and common complete backup. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/database-providers');
const providers=process.argv.slice(2);assert(providers.length&&providers.every(provider=>['mariadb','sqlserver','oracle'].includes(provider)));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let attempt=0;attempt<100&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,100));}assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const report={passed:false,cases:[]},states=providers.map(provider=>JSON.parse(fs.readFileSync(path.join(root,`${provider}-restart-state.json`),'utf8'))),secrets=providers.flatMap(provider=>{const state=JSON.parse(fs.readFileSync(path.join(root,`${provider}-private-state.json`),'utf8'));return[state.password,state.readerPassword];});
const publicWrite=(name,value)=>{const text=JSON.stringify(value,null,2);assert(secrets.every(secret=>!text.includes(secret)));fs.writeFileSync(path.join(root,name),text);};
try{
  const chats=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').map(chat=>chat.conversationId);});assert.deepEqual(new Set(chats),new Set(states[0].originalChatIds));
  for(const state of states){assert(!state.partial);const fixture=JSON.parse(fs.readFileSync(path.join(root,`${state.provider}-fixture.json`),'utf8'));const result=await rpc('sql_query',{connectionId:state.connectionId,sql:`SELECT marker FROM ${fixture.table} ORDER BY id`});assert(JSON.stringify(result).includes(fixture.marker));report.cases.push({name:`Actual restarted ${state.provider} connection reads saved native credentials and real data`,passed:true,connectionId:state.connectionId});}
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));const registry=manifest.records.filter(record=>record.path.startsWith('sql-inputs/')&&record.path.endsWith('/connections.json'));assert(registry.length);
  const contents=registry.map(record=>fs.readFileSync(path.join(backup.path,record.file),'utf8')).join('\n');for(const state of states)assert(contents.includes(state.connectionId));assert(secrets.every(secret=>!contents.includes(secret)));report.cases.push({name:'Actual complete backup retains all provider connection references and excludes passwords',passed:true,backup,originalChats:chats.length});
  for(const state of states){await rpc('sql_connection_remove',{connectionId:state.connectionId});await assert.rejects(rpc('sql_query',{connectionId:state.connectionId,sql:'SELECT 1'}),error=>error.code==='INPUT_CONNECTION_NOT_FOUND');}report.cases.push({name:'Owned QA connections are removed with their system credentials',passed:true});report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};process.exitCode=1;console.error(JSON.stringify(report.error));}
finally{publicWrite('restart-backup-result.json',report);await browser.close();}
console.log(JSON.stringify({passed:report.passed,cases:report.cases.length}));
