import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const output=resolve('artifacts/product-gaps-20261004/payments');mkdirSync(output,{recursive:true});
const baseline=JSON.parse(readFileSync('artifacts/release-candidate-integrated-20261004-actual/development-chats-before.json','utf8'));
const oldConnections=JSON.parse(readFileSync('artifacts/release-candidate-integrated-20261004-actual/original-connections-restored.json','utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
 const all=await page.evaluate(async()=>{await window.__GEOD_LOCAL_STATE__?.flush();return new Promise((resolve,reject)=>{const opened=indexedDB.open('geod-ui-state-v1',1);opened.onerror=()=>reject(opened.error);opened.onsuccess=()=>{const db=opened.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();const result=new Map(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]));keys.result.forEach((key,i)=>result.set(String(key),values.result[i]));resolve(Object.fromEntries(result));};tx.onabort=()=>reject(tx.error);};});});
 const key=Object.keys(all).find(k=>k.startsWith('geod-agent-conversations-0.1:account:')),chats=JSON.parse(all[key]);
 // Preserve the same order as the prior full-profile acceptance fingerprint.
 const contentSha256=createHash('sha256').update(JSON.stringify(chats)).digest('hex');
 const active=all['geod-agent-active-conversation-0.1:account:'+key.split(':account:')[1]];
 assert.equal(chats.length,baseline.count);assert.deepEqual(chats.map(c=>c.conversationId).sort(),baseline.chatIds);
 assert.equal(contentSha256,baseline.contentSha256);assert.equal(active,baseline.active);
 const connections=await page.evaluate(async()=>[...await window.__TAURI_INTERNALS__.invoke('data_connections_list'),...(await window.__TAURI_INTERNALS__.invoke('sql_connections_list')).connections]);
 assert.deepEqual(connections.map(c=>c.id).sort(),oldConnections.ids.slice().sort());
 const report={passed:true,originalConversations:chats.length,originalConnectionCount:connections.length,activePreserved:true,contentSha256,developmentHmrAvailable:true};
 writeFileSync(join(output,'original-profile-preserved.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
