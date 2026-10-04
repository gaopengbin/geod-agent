/** Actual production import and native MCP under a scoped no-system-Node PATH. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-node-launchers'),fixture=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8')),file=path.join(root,'native-result.json'),report=fs.existsSync(path.join(root,'restart-state.json'))&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{passed:false,cases:[]};delete report.error;
const applicationRuntime=path.resolve('apps/geod-agent-desktop/src-tauri/target/debug/codex-runtime'),applicationManifest=JSON.parse(fs.readFileSync(path.join(applicationRuntime,'manifest.json'),'utf8'));assert.equal(Object.keys(applicationManifest.files).length,fixture.filesVerified);
for(const [name,spec] of Object.entries(applicationManifest.files))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(applicationRuntime,name))).digest('hex'),spec.sha256);
const isolation=JSON.parse(fs.readFileSync(path.join(root,'isolation.json'),'utf8'));assert(isolation.started);assert(!isolation.systemNodeOnPath&&!isolation.systemNpmOnPath);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let tries=0;tries<100&&!page;tries++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(condition,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Timeout '+label);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const audit=()=>fs.existsSync(fixture.audit)?fs.readFileSync(fixture.audit,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const dead=pid=>{try{process.kill(pid,0);return false;}catch{return true;}};
const canonical=value=>fs.realpathSync.native(value).toLowerCase();
const dialogRoute='**/@tauri-apps_plugin-dialog.js*';let saved;
try{
 await page.locator('.conversation-account-trigger').waitFor();const original=await state();const previous=fs.existsSync(path.join(root,'restart-state.json'))?JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')):null;assert.equal(original.chats.length,previous?31:30);const existing=(await rpc('plugins_list')).plugins.find(plugin=>plugin.name==='geod-node-launcher-qa');assert(!existing||existing.id===previous?.pluginId);
 const settings=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}));
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
 if(!previous)await page.locator('.sidebar-new-chat').click();const conversationId=previous?.conversationId??await wait(async()=>(await state()).chats.find(chat=>!original.chats.some(old=>old.conversationId===chat.conversationId))?.conversationId,'Scoped QA chat');
 saved=previous??{conversationId,userId:original.userId,qaConversationIds:[conversationId],originalActive:original.active,baselineChatIds:original.chats.map(chat=>chat.conversationId),settings,fixture};fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const workspace=await rpc('workspace_get',{conversationId});await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId,channelId:'hosted',modelId:'hosted'});
 if(!existing){await page.route(dialogRoute,async route=>{const response=await route.fetch(),body=await response.text(),signature='async function open(options = {}) {';assert(body.includes(signature));await route.fulfill({response,body:body.replace(signature,signature+'\n  if(options.directory && options.multiple === false) return '+JSON.stringify(fixture.plugin)+';')});});
 await page.reload();await page.locator('.conversation-account-trigger').waitFor();await page.setViewportSize({width:1000,height:720});
 await page.getByRole('button',{name:'技能与连接器',exact:true}).click();await page.getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('button',{name:'导入插件',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('.plugin-tool-summary').count(),7);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(root,'actual-seven-launcher-preview-1000.png')});await dialog.getByRole('button',{name:'添加并启用',exact:true}).click();await dialog.waitFor({state:'hidden'});
 const plugin=await wait(async()=>(await rpc('plugins_list')).plugins.find(plugin=>plugin.name==='geod-node-launcher-qa'),'Actual plugin installation');saved.pluginId=plugin.id;saved.connectorIds=plugin.connectorIds;
 const overview=await rpc('extensions_list'),connectors=overview.connectors.filter(connector=>saved.connectorIds.includes(connector.id));assert.equal(connectors.length,7);saved.connectors=Object.fromEntries(connectors.map(connector=>[connector.name.split(' · ').at(-1),connector]));fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 pass('Actual production preview imports all seven Node/npm/npx configurations',{filePicker:'Only selected path supplied at OS picker boundary; native preview/import/transports are actual',filesVerified:fixture.filesVerified,isolation});
 }
 for(const [name,connector] of Object.entries(saved.connectors)){
  if(report.cases.some(item=>item.passed&&item.name.startsWith('Actual '+name+' launch ')))continue;
  const list=await rpc('mcp_tools',{id:connector.id,conversationId});assert.deepEqual(list.tools.map(tool=>tool.name),['read_context']);
  const output=await rpc('mcp_call',{id:connector.id,conversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}),read=JSON.parse(output.content.find(item=>item.type==='text').text),expectedRoot=name==='explicit_npx'?fixture.explicitRoot:applicationRuntime;
  assert.equal(read.marker,fixture.marker);assert.equal(canonical(read.execPath),canonical(path.join(expectedRoot,'node.exe')));assert.equal(read.nodeVersion,name==='explicit_npx'?fixture.explicitNodeVersion:fixture.nodeVersion);assert.equal(canonical(read.descendant.execPath),canonical(read.execPath));assert.deepEqual(read.argv,['--tag',fixture.literal]);assert.equal(canonical(read.cwd),canonical(fixture.work));assert(!read.bridgeVisible);
  await wait(()=>audit().filter(event=>event.type==='started').every(event=>dead(event.pid)&&dead(event.descendant.pid)),'Root and descendant processes reaped',15000);
  pass('Actual '+name+' launch reads independent data, preserves literal arguments and reaps its Node descendant',{actualRead:read});
 }
 for(const [name,connector] of Object.entries(saved.connectors))await rpc('mcp_set_enabled',{id:connector.id,enabled:name==='npx'});
 report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'native-failure.png')}).catch(()=>{});throw error;}
finally{await page.unroute(dialogRoute).catch(()=>{});await page.reload().catch(()=>{});await browser.close();}
