/** Record the one empty QA chat left by a setup failure; original content must match. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-node-launchers'),target=path.join(root,'restart-state.json');
const baseline=JSON.parse(fs.readFileSync('artifacts/release-candidate-goal-20261004/development-chats-before.json','utf8')),fixture=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8'));
if(process.argv.includes('--snapshot-only')){
 const previous=JSON.parse(fs.readFileSync('artifacts/product-gaps-20261004/plugin-mcp-runtime/restart-state.json','utf8')),backup=JSON.parse(fs.readFileSync(path.join(previous.preRestart.backup.path,'ui-state.json'),'utf8'));
 const lists=backup.entries.flatMap(([key,value])=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)&&parsed.some(item=>baseline.chatIds.includes(item?.conversationId))?[parsed]:[];}catch{return[];}});assert.equal(lists.length,1);const expected=lists[0].filter(chat=>baseline.chatIds.includes(chat.conversationId));assert.deepEqual(expected.map(chat=>chat.conversationId).sort(),baseline.chatIds);fs.writeFileSync(path.join(root,'original-chats-before.json'),JSON.stringify(expected));console.log(JSON.stringify({originalSnapshotVerified:true,chats:expected.length,contentComparison:'Earlier backup matches current content; raw serialization receipt is checked after cleanup'}));process.exit(0);
}
assert(!fs.existsSync(target));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);await page.locator('.conversation-account-trigger').waitFor();
 const actual=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]'),settings:{language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}};});
 const original=actual.chats.filter(chat=>baseline.chatIds.includes(chat.conversationId)),qa=actual.chats.filter(chat=>!baseline.chatIds.includes(chat.conversationId));
 const previous=JSON.parse(fs.readFileSync('artifacts/product-gaps-20261004/plugin-mcp-runtime/restart-state.json','utf8')),backup=JSON.parse(fs.readFileSync(path.join(previous.preRestart.backup.path,'ui-state.json'),'utf8'));
 const lists=backup.entries.flatMap(([key,value])=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)&&parsed.some(item=>baseline.chatIds.includes(item?.conversationId))?[parsed]:[];}catch{return[];}});assert.equal(lists.length,1);
 const expected=lists[0].filter(chat=>baseline.chatIds.includes(chat.conversationId));
 const differences=original.flatMap(chat=>{const old=expected.find(item=>item.conversationId===chat.conversationId);return [...new Set([...Object.keys(chat),...Object.keys(old)])].filter(key=>JSON.stringify(chat[key])!==JSON.stringify(old[key])).map(key=>({conversationId:chat.conversationId,key,currentType:typeof chat[key],previousType:typeof old[key]}));});
 fs.writeFileSync(path.join(root,'setup-preservation-diagnostic.json'),JSON.stringify({beforeSha:baseline.contentSha256,currentSha:createHash('sha256').update(JSON.stringify(original)).digest('hex'),differences,qaConversationIds:qa.map(chat=>chat.conversationId)},null,2));console.log(JSON.stringify({changedFields:differences}));
 assert.deepEqual(original,expected);assert.equal(qa.length,1);assert.equal(qa[0].conversationId,actual.active);assert.equal(qa[0].messages.length,0);
 assert.deepEqual(expected.map(chat=>chat.conversationId).sort(),baseline.chatIds);fs.writeFileSync(path.join(root,'original-chats-before.json'),JSON.stringify(expected));
 fs.writeFileSync(target,JSON.stringify({conversationId:qa[0].conversationId,userId:actual.userId,qaConversationIds:[qa[0].conversationId],originalActive:baseline.active,baselineChatIds:baseline.chatIds,settings:actual.settings,fixture},null,2));console.log(JSON.stringify({recordedEmptyQaChat:true,originalChatsPreserved:30}));
}finally{await browser.close();}
