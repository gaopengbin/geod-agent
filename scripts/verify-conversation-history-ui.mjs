import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
const output=path.resolve('artifacts/product-gaps-20261004/history-ui');fs.mkdirSync(output,{recursive:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const nonce=`History QA ${Date.now()}`,renamed=`${nonce} renamed`;
let importedId;
const original=await page.evaluate(async()=>{
  const {invoke}=await import('/node_modules/.vite/deps/@tauri-apps_api_core.js');
  const {localStateStore}=await import('/src/local-state.ts');
  const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');
  const auth=await invoke('auth_status'),store=accountChatStore(localStateStore,auth.userId);
  return {ids:JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]').map(chat=>chat.conversationId),active:store.getItem('geod-agent-active-conversation-0.1'),language:localStorage.getItem('geod-agent-language-v1')};
});
async function saved(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts');const {localStateStore}=await import('/src/local-state.ts');const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus();return JSON.parse(accountChatStore(localStateStore,auth.userId).getItem(CHAT_LIST_KEY)??'[]');});}
async function menuAction(id,label){const row=page.locator('.conversation-sidebar .conversation-row').filter({has:page.locator(`[data-conversation-id="${id}"]`)});await row.hover();await row.locator('.conversation-more').click();await page.getByRole('button',{name:label,exact:true}).click();}
try{
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  await page.keyboard.press('Control+k');
  const dialog=page.getByRole('dialog').filter({has:page.getByText('Chat history',{exact:true})});
  await dialog.getByRole('textbox',{name:'Search titles or messages'}).waitFor();
  await dialog.locator('input[type=file]').setInputFiles({name:'history-qa.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({product:'geod-agent',schemaVersion:1,conversation:{title:nonce,messages:[{role:'user',content:'HistorySearchUniqueNeedle'}],display:[{role:'user',content:'HistorySearchUniqueNeedle'}]}}))});
  await page.locator('.agent-header strong').filter({hasText:nonce}).waitFor();
  importedId=(await saved()).find(chat=>chat.title===nonce)?.conversationId;assert(importedId);
  await menuAction(importedId,'Rename');
  await page.getByRole('dialog').getByRole('textbox',{name:'Chat name'}).fill(renamed);
  await page.getByRole('dialog').getByRole('button',{name:'Save name',exact:true}).click();
  await page.locator('.agent-header strong').filter({hasText:renamed}).waitFor();
  await menuAction(importedId,'Pin');assert((await saved()).find(chat=>chat.conversationId===importedId).pinned);
  await menuAction(importedId,'Archive');
  await page.keyboard.press('Control+k');
  await dialog.getByRole('tab',{name:'Archived',exact:true}).click();
  await dialog.getByRole('textbox',{name:'Search titles or messages'}).fill('HistorySearchUniqueNeedle');
  await dialog.locator(`[data-conversation-id="${importedId}"]`).waitFor();
  assert.equal(await dialog.locator('.conversation-row').count(),1);
  await page.screenshot({path:path.join(output,'archived-search-en.png')});
  await dialog.locator('.conversation-more').click();await page.getByRole('button',{name:'Unarchive',exact:true}).click();
  await dialog.getByRole('tab',{name:'All chats',exact:true}).click();
  await dialog.locator(`[data-conversation-id="${importedId}"]`).click();
  await page.reload();await page.locator('.agent-header strong').filter({hasText:renamed}).waitFor();
  assert((await saved()).find(chat=>chat.conversationId===importedId).pinned);
  await menuAction(importedId,'Delete chat');await page.getByRole('dialog').getByRole('button',{name:'Delete chat',exact:true}).click();
  await page.waitForFunction(async id=>{const {api}=await import('/src/api.ts');const {localStateStore}=await import('/src/local-state.ts');const {accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const status=await api.authStatus();return !JSON.parse(accountChatStore(localStateStore,status.userId).getItem(CHAT_LIST_KEY)??'[]').some(chat=>chat.conversationId===id);},importedId);
  const remaining=await saved();assert.deepEqual(new Set(remaining.map(chat=>chat.conversationId)),new Set(original.ids));assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['import new identity','rename','pin','archive','search message content','unarchive','reload persistence','delete','original conversation IDs preserved'],errors},null,2));
  console.log(JSON.stringify({passed:true,originalCount:original.ids.length,errors}));
}finally{
  if(importedId){await page.evaluate(async id=>{const {api}=await import('/src/api.ts');const {localStateStore,flushLocalState}=await import('/src/local-state.ts');const {accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts');const auth=await api.authStatus();deleteStoredConversation(accountChatStore(localStateStore,auth.userId),id);await flushLocalState();},importedId).catch(()=>{});}
  await page.evaluate(async original=>{const {api}=await import('/src/api.ts');const {localStateStore,flushLocalState}=await import('/src/local-state.ts');const {accountChatStore}=await import('/src/pending-generations.ts');const {setLanguagePreferences}=await import('/src/i18n.ts');const auth=await api.authStatus();if(original.active)accountChatStore(localStateStore,auth.userId).setItem('geod-agent-active-conversation-0.1',original.active);setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});await flushLocalState();},original).catch(()=>{});
  await page.reload().catch(()=>{});await browser.close();
}
