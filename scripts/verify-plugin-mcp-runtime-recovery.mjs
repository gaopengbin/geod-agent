/** Full native backup, real restart readback, and removal of recorded QA resources only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-runtime'),mode=process.argv[2];assert(['prepare','finish'].includes(mode));
const saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')),file=path.join(root,'recovery-result.json'),report=mode==='prepare'?{passed:false,cases:[]}:JSON.parse(fs.readFileSync(file,'utf8'));
assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let tries=0;tries<100&&!page;tries++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result=value=>JSON.parse(value.content.find(item=>item.type==='text').text);
let server;
try{
 await page.locator('.conversation-account-trigger').waitFor();await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});assert.equal((await rpc('background_status')).activeAiTurns,0);assert.equal(await page.locator('.conversation-running-dot').count(),0);
 const overview=await rpc('extensions_list'),metadata=overview.connectors.filter(connector=>saved.connectorIds.includes(connector.id));assert.equal(metadata.length,6);
 if(mode==='prepare'){
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});assert(backup.verified);
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8')),prefix='plugin-packages/'+saved.pluginId+'/',resources=manifest.records.filter(record=>record.path.startsWith(prefix));assert.equal(resources.length,2);
  for(const record of resources){assert.equal(digest(path.join(backup.path,record.file)),record.sha256);assert.equal(digest(path.join(saved.installedRoot,record.path.slice(prefix.length))),record.sha256);}
  const configRecord=manifest.records.find(record=>record.path==='agent-extensions.json');assert(configRecord);const config=JSON.parse(fs.readFileSync(path.join(backup.path,configRecord.file),'utf8'));
  for(const connector of metadata)assert.deepEqual(config.connectorSettings[connector.id].runtime,connector.runtime);
  const credential=JSON.parse(fs.readFileSync(path.join(saved.fixture,'mcp.json'),'utf8')).mcpServers.http.headers['X-Static-Key'];assert(!JSON.stringify(config).includes(credential));
  saved.preRestart={metadata,backup,resources:resources.map(record=>({path:record.path.slice(prefix.length),sha256:record.sha256}))};fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
  pass('Actual verified full backup preserves all MCP settings and installed files without authentication values',{records:manifest.records.length,resources:resources.length,backupPath:backup.path});
 }else{
  assert.deepEqual(metadata,saved.preRestart.metadata);for(const resource of saved.preRestart.resources)assert.equal(digest(path.join(saved.installedRoot,resource.path)),resource.sha256);
  const read=result(await rpc('mcp_call',{id:saved.connectors.stdio.id,conversationId:saved.modelConversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}));assert.equal(read.marker,saved.marker);assert(read.inheritedVariable&&read.explicitEnvOverride&&!read.bridgeVisible);
  pass('Actual desktop and companion restart retain cwd, tool filters, timeouts and process credentials',{actualRead:read});
  const config=JSON.parse(fs.readFileSync(path.join(saved.fixture,'mcp.json'),'utf8')).mcpServers.http;
  server=http.createServer(async(req,res)=>{
   if(req.method!=='POST'){res.writeHead(405).end();return;}
   if(req.headers.authorization!=='Bearer '+process.env.USERNAME||req.headers['x-static-key']!==config.headers['X-Static-Key']||req.headers['x-runtime-env']!==process.env.USERNAME){res.writeHead(401).end();return;}
   let text='';for await(const chunk of req)text+=chunk;const request=JSON.parse(text);if(request.id===undefined){res.writeHead(202).end();return;}
   const value=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'geod-restored-http-qa',version:'1.0'}}:request.method==='tools/list'?{tools:[{name:'read_context',description:'Read actual restored native HTTP authentication',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:JSON.stringify({marker:saved.marker,restoredAuthentication:true})}]};
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:value}));
  });await new Promise(resolve=>server.listen(Number(new URL(config.url).port),'127.0.0.1',resolve));
  await rpc('mcp_set_enabled',{id:saved.connectors.http.id,enabled:true});const restored=result(await rpc('mcp_call',{id:saved.connectors.http.id,conversationId:saved.modelConversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}));assert.equal(restored.marker,saved.marker);assert(restored.restoredAuthentication);
  pass('Actual HTTP connection after restart reads vault credentials and native environment references');
  const archived=await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const store=accountChatStore(localStateStore,saved.userId);return JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(chat=>saved.qaConversationIds.includes(chat.conversationId));},saved);
  fs.writeFileSync(path.join(root,'actual-qa-conversations.json'),JSON.stringify(archived,null,2));assert(!JSON.stringify(archived).includes(config.headers['X-Static-Key']));
  await rpc('plugin_remove',{id:saved.pluginId});assert(!fs.existsSync(saved.installedRoot));assert(!(await rpc('plugins_list')).plugins.some(plugin=>plugin.id===saved.pluginId));
  await assert.rejects(rpc('mcp_call',{id:saved.connectors.stdio.id,conversationId:saved.modelConversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}),error=>error.code==='MCP_NOT_FOUND');
  await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId),ids=new Set(saved.qaConversationIds);for(const id of ids)if(saved.baselineChatIds.includes(id))throw new Error('Refusing to remove an original conversation');const chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>!ids.has(chat.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);await flushLocalState();if(saved.settings.language)setLanguagePreferences(JSON.parse(saved.settings.language));document.documentElement.dataset.theme=saved.settings.theme;document.documentElement.style.colorScheme=saved.settings.theme;},saved);
  await page.setViewportSize({width:saved.settings.width,height:saved.settings.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  pass('Only recorded QA plugin and five QA sidebar chats are removed; schedule is disabled and removed MCP cannot execute',{qaConversationIds:saved.qaConversationIds,actualForegroundModelTurns:archived.reduce((sum,chat)=>sum+(chat.messages??[]).filter(message=>message.role==='user').length,0)});
  report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
 }
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));throw error;}
finally{await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
