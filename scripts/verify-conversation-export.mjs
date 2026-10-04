import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
assert(page);const directory=fs.mkdtempSync(path.join(os.tmpdir(),'geod-chat-export-'));
const output=path.resolve('artifacts/product-gaps-20261004/history-ui');fs.mkdirSync(output,{recursive:true});
try {
  const result=await page.evaluate(async directory=>{
    const {exportConversation,importConversation}=await import('/src/conversation-history.ts');
    const chat={conversationId:crypto.randomUUID(),title:'会话导出 · Test',messages:[],display:[{id:'user',role:'user',content:'范围与影像范围 Test'}, {id:'answer',role:'assistant',phase:'final',content:'实际回答 Answer'}],planId:'native-not-portable',updatedAt:new Date().toISOString()};
    const files=[];
    for(const format of ['json','markdown']){
      const content=exportConversation(chat,format),path=directory+(format==='json'?'/会话.json':'/会话.md');
      const bytes=await window.__TAURI_INTERNALS__.invoke('conversation_export_save',{path,content});files.push({format,path,content,bytes});
    }
    const imported=importConversation(files[0].content,crypto.randomUUID());
    let invalid;
    try{await window.__TAURI_INTERNALS__.invoke('conversation_export_save',{path:directory+'/unsafe.exe',content:'test'});}catch(error){invalid=String(error);}
    return{files,newIdentity:imported.conversationId!==chat.conversationId,planAbsent:!imported.planId,invalid};
  },directory);
  for(const file of result.files){assert.equal(fs.readFileSync(file.path,'utf8'),file.content);assert.equal(file.bytes,Buffer.byteLength(file.content));}
  assert(result.newIdentity&&result.planAbsent);assert(result.invalid);
  const report={passed:true,formats:result.files.map(file=>({format:file.format,bytes:file.bytes})),newImportIdentity:true,nativeTaskAuthorityExcluded:true,invalidExtensionRejected:true};
  fs.writeFileSync(path.join(output,'native-export.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
