/** Production plugin UI and actual native MCP transports; no model mocking. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-runtime'),file=path.join(root,'native-result.json'),fixture=path.join(root,'runtime package with spaces');
fs.mkdirSync(path.join(fixture,'server'),{recursive:true});
fs.copyFileSync('scripts/fixtures/mcp-runtime-fixture.mjs',path.join(fixture,'server','mcp-runtime-fixture.mjs'));
const marker='MCP_RUNTIME_'+randomUUID().replaceAll('-',''),staticCredential=randomUUID(),expectedTemp='qa-explicit-'+randomUUID(),auditFile=path.join(root,'actual-stdio-audit.jsonl');
assert(process.env.USERNAME);fs.writeFileSync(path.join(fixture,'server','context.json'),JSON.stringify({marker,expectedTemp,expectedUserHash:createHash('sha256').update(process.env.USERNAME).digest('hex')}));
const report={passed:false,cases:[]},httpAudit=[];
const tools=['read_context','slow_read','excluded','outside'].map(name=>({name,description:'Read actual HTTP fixture evidence',inputSchema:{type:'object',properties:{},additionalProperties:false}}));
const fixtureServer=http.createServer(async(req,res)=>{
 httpAudit.push({method:req.method,path:req.url,authenticated:req.headers.authorization==='Bearer '+process.env.USERNAME,staticAuthenticated:req.headers['x-static-key']===staticCredential,environmentHeader:req.headers['x-runtime-env']===process.env.USERNAME,at:Date.now()});
 if(req.method!=='POST'){res.writeHead(405).end();return;}
 let body='';for await(const part of req)body+=part;const request=JSON.parse(body),audit=httpAudit.at(-1);audit.rpcMethod=request.method;audit.tool=request.params?.name;
 if(!audit.authenticated||!audit.staticAuthenticated||!audit.environmentHeader){res.writeHead(401).end();return;}
 if(request.id===undefined){res.writeHead(202).end();return;}
 let result;
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'geod-runtime-http-qa',version:'1.0.0'}};
 else if(request.method==='tools/list')result={tools};
 else if(request.method==='tools/call'){
  if(request.params.name==='slow_read')await new Promise(resolve=>setTimeout(resolve,31250));
  result={content:[{type:'text',text:JSON.stringify({marker,source:'actual HTTP fixture',authenticated:true,staticAuthenticated:true,environmentHeader:true})}]};
 }else result={};
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});
await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+fixtureServer.address().port+'/mcp',node=path.resolve('apps/geod-agent-desktop/src-tauri/resources/codex/node.exe');assert(fs.existsSync(node));
const pluginRoot='$'+'{PLUGIN_ROOT}';
const stdio={type:'stdio',command:node,args:['./server/mcp-runtime-fixture.mjs'],cwd:pluginRoot+'/server',env_vars:[{name:'USERNAME',source:'local'}],env:{TEMP:expectedTemp,QA_AUDIT_FILE:auditFile},startup_timeout_sec:5,tool_timeout_sec:3,enabled_tools:['read_context','slow_read','excluded'],disabled_tools:['excluded']};
const httpConfig={type:'http',url,headers:{'X-Static-Key':staticCredential},bearer_token_env_var:'USERNAME',env_http_headers:{'X-Runtime-Env':'USERNAME'},startup_timeout_sec:5,tool_timeout_sec:40,enabled_tools:['read_context','slow_read','excluded'],disabled_tools:['excluded']};
const configs={stdio,http:httpConfig,short_start:{...stdio,env:{...stdio.env,QA_INIT_DELAY:'200',QA_LIST_DELAY:'300'},startup_timeout_ms:400,startup_timeout_sec:undefined},short_call:{...stdio,tool_timeout_sec:0.15},missing_auth:{...httpConfig,bearer_token_env_var:'GEOD_QA_ABSENT_'+randomUUID().replaceAll('-','')},declared_off:{...stdio,enabled:false}};
fs.writeFileSync(path.join(fixture,'plugin.json'),JSON.stringify({name:'geod-mcp-runtime-qa',version:'1.0.0',description:'Actual plugin MCP runtime acceptance',extensions:{'com.openai':{interface:{displayName:'MCP runtime acceptance'}}}}));
fs.writeFileSync(path.join(fixture,'mcp.json'),JSON.stringify({mcpServers:configs}));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let attempts=0;attempts<100&&!page;attempts++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,200));}assert(page);
const dialogRoute='**/@tauri-apps_plugin-dialog.js*';
await page.route(dialogRoute,async route=>{const response=await route.fetch(),body=await response.text(),signature='async function open(options = {}) {';assert(body.includes(signature));await route.fulfill({response,body:body.replace(signature,signature+'\n  if(options.directory && options.multiple === false) return '+JSON.stringify(fixture)+';')});});
await page.reload();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(condition,label,timeout=20000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Timeout '+label);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const stdioAudit=()=>fs.existsSync(auditFile)?fs.readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const readResult=value=>JSON.parse(value.content.find(item=>item.type==='text').text);
const previous=fs.existsSync(path.join(root,'restart-state.json'))?JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8')):null;
let saved,installed,original;
try{
 await page.locator('.conversation-account-trigger').waitFor();original=await state();
 const settings=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}));
 assert(!(await rpc('plugins_list')).plugins.some(plugin=>plugin.name==='geod-mcp-runtime-qa'));
 await page.locator('.sidebar-new-chat').click();const conversationId=await wait(async()=>(await state()).chats.find(chat=>!original.chats.some(old=>old.conversationId===chat.conversationId))?.conversationId,'Owned fixture conversation');
 const workspace=await rpc('workspace_get',{conversationId});await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId,channelId:'hosted',modelId:'hosted'});
 saved={fixture,marker,conversationId,userId:original.userId,qaConversationIds:[...new Set([...(previous?.qaConversationIds??[]),...(previous?.conversationId?[previous.conversationId]:[]),conversationId])],originalActive:previous?.originalActive??original.active,baselineChatIds:previous?.baselineChatIds??original.chats.map(chat=>chat.conversationId),settings:previous?.settings??settings};fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await page.setViewportSize({width:1000,height:720});
 await page.getByRole('button',{name:'技能与连接器',exact:true}).click();await page.getByRole('button',{name:'插件',exact:true}).click();
 // Only supply the chosen path to the OS file-picker boundary. Preview, import,
 // credentials, subprocesses, transport and all production UI remain actual.
 await page.getByRole('button',{name:'导入插件',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
 assert.equal(await dialog.locator('.plugin-tool-summary').count(),6);assert.equal(await dialog.getByText('认证变量',{exact:true}).count(),2);assert.equal(await dialog.getByText('默认停用',{exact:false}).count(),1);
 let bounds=await dialog.boundingBox();assert(bounds.y>=0&&bounds.y+bounds.height<=720);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert(!(await dialog.textContent()).includes(staticCredential));
 await page.screenshot({path:path.join(root,'actual-runtime-preview-dark-1000.png')});
 pass('Actual plugin preview shows cwd, variable names, deadlines, tool filters and default-disabled service without credential values',{filePicker:'Only path selection supplied by test; all following native operations are actual'});
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});
 assert.equal(await dialog.getByText('Authentication variables',{exact:true}).count(),2);assert.equal(await dialog.getByText('Inherited variables',{exact:true}).count(),4);bounds=await dialog.boundingBox();assert(bounds.y+bounds.height<=720);await page.screenshot({path:path.join(root,'actual-runtime-preview-light-en-1000.png')});
 await dialog.getByRole('button',{name:'Add and enable',exact:true}).click();await dialog.waitFor({state:'hidden'});
 installed=await wait(async()=>(await rpc('plugins_list')).plugins.find(plugin=>plugin.name==='geod-mcp-runtime-qa'),'Actual plugin install');saved.pluginId=installed.id;saved.connectorIds=installed.connectorIds;fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 const overview=await rpc('extensions_list'),connectors=overview.connectors.filter(connector=>installed.connectorIds.includes(connector.id));assert.equal(connectors.length,6);assert.equal(connectors.filter(connector=>connector.enabled).length,5);assert(!JSON.stringify(overview).includes(staticCredential));
 const byName=Object.fromEntries(connectors.map(connector=>[connector.name.split(' · ').at(-1),connector]));saved.connectors=byName;saved.installedRoot=path.join(process.env.APPDATA,'dev.geod-agent.desktop','plugin-packages',installed.id);fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 pass('Actual English light preview imports all six services; declaration enabled=false remains off and vault values are absent from metadata');
 for(const name of ['stdio','http']){
  const list=await rpc('mcp_tools',{id:byName[name].id,conversationId});assert.deepEqual(list.tools.map(tool=>tool.name),['read_context','slow_read']);
  const read=readResult(await rpc('mcp_call',{id:byName[name].id,conversationId,toolName:'read_context',arguments:{},executionId:randomUUID()}));assert.equal(read.marker,marker);
  if(name==='stdio'){assert.equal(fs.realpathSync.native(read.cwd).toLowerCase(),fs.realpathSync.native(path.join(saved.installedRoot,'server')).toLowerCase());assert(read.inheritedVariable&&read.explicitEnvOverride&&!read.bridgeVisible);}else assert(read.authenticated&&read.staticAuthenticated&&read.environmentHeader);
  saved[name+'Read']=read;
 }
 fs.writeFileSync(path.join(root,'actual-read-results.json'),JSON.stringify({stdio:saved.stdioRead,http:saved.httpRead},null,2));
 pass('Actual stdio uses installed cwd, declared inherited variable and explicit env override; HTTP resolves native bearer and header references',{stdio:saved.stdioRead,http:saved.httpRead});
 const before={http:httpAudit.length,stdio:stdioAudit().length};
 for(const name of ['stdio','http'])for(const toolName of ['excluded','outside'])await assert.rejects(rpc('mcp_call',{id:byName[name].id,conversationId,toolName,arguments:{},executionId:randomUUID()}),error=>error.code==='MCP_TOOL_DISABLED');
 assert.equal(httpAudit.length,before.http);assert.equal(stdioAudit().length,before.stdio);
 pass('Both configured allow-list and deny-list enforce native calls before launching processes or sending requests');
 let started=Date.now();await assert.rejects(rpc('mcp_tools',{id:byName.short_start.id,conversationId}),error=>error.code==='MCP_LIST_TIMEOUT');let elapsed=Date.now()-started;assert(elapsed<6000);
 pass('Configured startup budget includes handshake and initial tool discovery',{elapsedMs:elapsed,configuredMs:400});
 const executionId=randomUUID();started=Date.now();await assert.rejects(rpc('mcp_call',{id:byName.short_call.id,conversationId,toolName:'slow_read',arguments:{},executionId}),error=>error.code==='MCP_RESULT_UNKNOWN');elapsed=Date.now()-started;const count=stdioAudit().length;
 await assert.rejects(rpc('mcp_call',{id:byName.short_call.id,conversationId,toolName:'slow_read',arguments:{},executionId}),error=>error.code==='MCP_RESULT_UNKNOWN');assert.equal(stdioAudit().length,count);
 await wait(async()=>stdioAudit().filter(event=>event.type==='started').every(event=>{try{process.kill(event.pid,0);return false;}catch{return true;}}),'Actual MCP processes reaped',10000);
 pass('Tool timeout cancels and reaps actual process; an uncertain execution is not retried',{elapsedMs:elapsed,configuredMs:150});
 const requests=httpAudit.length;await assert.rejects(rpc('mcp_tools',{id:byName.missing_auth.id,conversationId}),error=>error.code==='MCP_ENV_REQUIRED');assert.equal(httpAudit.length,requests);
 pass('Missing declared authentication variable returns actionable native error before network request');
 console.log(JSON.stringify({pending:'Actual HTTP tool waits beyond previous fixed transport timeout'}));started=Date.now();const long=readResult(await rpc('mcp_call',{id:byName.http.id,conversationId,toolName:'slow_read',arguments:{},executionId:randomUUID()}));elapsed=Date.now()-started;assert.equal(long.marker,marker);assert(elapsed>=31000&&elapsed<40000);
 pass('Actual HTTP tool runs beyond 30 seconds and obeys the configured 40-second deadline',{elapsedMs:elapsed});
 report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,'actual-http-audit.json'),JSON.stringify(httpAudit,null,2));fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'native-failure.png')}).catch(()=>{});throw error;}
finally{await page.unroute(dialogRoute).catch(()=>{});await page.reload().catch(()=>{});await browser.close();fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));}
