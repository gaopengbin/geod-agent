/** Reuses the completed real model turn; validates only the repaired native backup. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/audio-inputs');
const chat=JSON.parse(fs.readFileSync(path.join(root,'actual-final-metadata-chat.json'),'utf8'));
const audio=chat.messages.flatMap(message=>message.documents??[]).find(file=>file.kind==='audio');
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let attempt=0;attempt<100&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,100));}assert(page,'Development WebView did not become ready');
const rpc=async(command,args)=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
  await page.locator('.conversation-account-trigger').waitFor();
  const original=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8'));
  const state=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').map(chat=>chat.conversationId);});
  assert.deepEqual(new Set(state),new Set(original.originalChatIds));
  const store=path.join(process.env.APPDATA,'dev.geod-agent.desktop/chat-attachments');
  const copies=fs.readdirSync(store).map(folder=>path.join(store,folder,`${audio.id}.json`)).filter(file=>fs.existsSync(file)).map(file=>JSON.parse(fs.readFileSync(file,'utf8')).attachment);assert.equal(copies.length,2);
  const text=(await rpc('document_attachment_read',{conversationId:chat.conversationId,id:audio.id})).text;
  for(const copy of copies){const read=await rpc('document_attachment_read',{conversationId:copy.conversationId,id:audio.id});assert.equal(read.text,text);const list=await rpc('document_attachments_list',{conversationId:copy.conversationId});assert.equal(list.find(file=>file.id===audio.id).transcriptEdited,true);}
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));
  assert(!manifest.records.some(record=>record.path.includes('audio-models')));
  const files=manifest.records.filter(record=>record.path.includes(audio.id));assert.equal(files.length,8);
  for(const file of files){const bytes=fs.readFileSync(path.join(backup.path,file.file));assert.equal(digest(bytes),file.sha256);if(file.path.endsWith('.attachment'))assert.equal(file.sha256,audio.sha256);if(file.path.endsWith('.text'))assert.equal(bytes.toString('utf8'),text);if(file.path.endsWith('.transcript')){assert(bytes.toString('utf8').includes('Beijing'));assert.notEqual(file.sha256,digest(text));}}
  assert.equal(files.filter(file=>file.path.endsWith('.transcript')).length,2);
  const result={backup,conversationId:chat.conversationId,forkId:copies.find(copy=>copy.conversationId!==chat.conversationId).conversationId,audioId:audio.id,records:files.length,audioSha256:audio.sha256,textSha256:digest(text),modelCacheExcluded:true};
  fs.writeFileSync(path.join(root,'final-backup.json'),JSON.stringify(result,null,2));
  const report=JSON.parse(fs.readFileSync(path.join(root,'finish-result.json'),'utf8'));
  if(report.error){const failuresFile=path.join(root,'finish-failures.json'),failures=fs.existsSync(failuresFile)?JSON.parse(fs.readFileSync(failuresFile,'utf8')):[];failures.push({error:report.error,completedCases:report.cases.length});fs.writeFileSync(failuresFile,JSON.stringify(failures,null,2));}
  delete report.error;report.cases.push({name:'New full backup and native fork preserve machine transcript, edited text and original media',passed:true,...result});report.passed=true;
  fs.writeFileSync(path.join(root,'finish-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.length,originalChats:state.length,audioRecords:files.length}));
}finally{await browser.close();}
