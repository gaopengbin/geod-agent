/** Read back the restored application profiles and running HMR desktop. */
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const [modulePath,output]=process.argv.slice(2),{chromium}=await import(modulePath);
const root=path.resolve(output),profiles=JSON.parse(await fs.readFile(path.join(root,'profiles.json'),'utf8'));
assert.equal(profiles.phase,'restored');
for(const profile of profiles.profiles){assert(profile.restored);assert((await fs.stat(profile.source)).isDirectory());assert.equal(await fs.stat(profile.backup).then(()=>true,()=>false),false);}
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
  const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();assert(await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled());
  const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const version=await rpc('plugin:app|version');assert.equal(version,'0.2.0');
  const auth=await rpc('auth_status');assert.equal(auth.state,'connected');
  const background=await rpc('background_status');assert(background.pid>0);assert.equal(background.activeAiTurns,0);
  const hash=crypto.createHash('sha256');for await(const chunk of createReadStream('apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe'))hash.update(chunk);assert.equal(background.fingerprint,hash.digest('hex'));
  const state=await page.evaluate(async userId=>{const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();const entries=localStateEntries();const values=entries.find(([key])=>key===`geod-agent-conversations-0.1:account:${userId}`)?.[1];const conversations=values?JSON.parse(values):[];const active=entries.find(([key])=>key===`geod-agent-active-conversation-0.1:account:${userId}`)?.[1];const{appDataDir}=await import('/node_modules/@tauri-apps/api/path.js');return{conversationIds:conversations.map(c=>c.conversationId),active,appDataDirectory:await appDataDir(),theme:document.documentElement.dataset.theme};},auth.userId);
  const expected=profiles.profiles.find(p=>p.kind==='Roaming').source;assert.equal(path.resolve(state.appDataDirectory),path.resolve(expected));assert(state.conversationIds.length>0);assert(state.conversationIds.includes(state.active));
  const prior=JSON.parse(await fs.readFile('artifacts/agent-tasks-20261003-final/acceptance.json','utf8'));assert(state.conversationIds.includes(prior.conversationId));
  const oldTask=prior.cases.find(c=>c.name.startsWith('Two real Codex threads')).result.tasks[0];const retained=await rpc('agent_tasks_get',{conversationId:prior.conversationId,taskId:oldTask.id});assert.equal(retained.task.status,'completed');assert.equal(retained.task.runId,oldTask.runId);assert(retained.files.some(f=>f.path.endsWith('result.json')));
  assert.equal(errors.length,0);await page.screenshot({path:path.join(root,'development-restored.png')});
  const report={pass:true,version,frontend:'http://127.0.0.1:1420',hotReload:true,authConnected:true,backgroundPid:background.pid,profilesRestored:true,conversationsRetained:state.conversationIds.length,activeConversationRetained:true,originalTaskRetained:oldTask.id,pageErrors:errors,finishedAt:new Date().toISOString()};
  await fs.writeFile(path.join(root,'development-restored.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
