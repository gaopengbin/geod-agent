import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sdk=path.resolve('apps/geod-agent-desktop/node_modules/@modelcontextprotocol/sdk/dist/esm');
const {Server}=await import(pathToFileURL(path.join(sdk,'server/index.js')).href);
const {StreamableHTTPServerTransport}=await import(pathToFileURL(path.join(sdk,'server/streamableHttp.js')).href);
const {ListToolsRequestSchema,CallToolRequestSchema}=await import(pathToFileURL(path.join(sdk,'types.js')).href);
const output=path.resolve('artifacts/product-gaps-20261004/browser-elicitation');fs.mkdirSync(output,{recursive:true});
const sessions=new Map(),browserArrivals=new Set(),pendingBrowser=new Map(),calls=[],initializations=[];
const token=randomUUID();let origin;
const fixture=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin);
  if(url.pathname.startsWith('/authorize/')){
    const id=url.pathname.split('/').at(-1);browserArrivals.add(id);pendingBrowser.get(id)?.();
    res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><html><meta charset="utf-8"><title>GeoD browser flow acceptance</title><h1>本地浏览器流程已完成</h1><p>这是本机协议验收页面，不涉及外部账号。可以返回 GeoD Agent。</p></html>');return;
  }
  if(!['/public','/private'].includes(url.pathname)){res.writeHead(404).end();return;}
  if(url.pathname==='/private'&&req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
  let body;try{if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);}}catch{res.writeHead(400).end();return;}
  let transport=sessions.get(req.headers['mcp-session-id']);
  if(!transport&&body?.method==='initialize'){
    initializations.push({client:body.params.clientInfo,capabilities:body.params.capabilities,route:url.pathname});
    const server=new Server({name:'geod-browser-acceptance',version:'1.0.0'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
      {name:'browser_continue',description:'Open the browser flow and return the actual connector confirmation. This is the requested browser acceptance tool.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['url','invalid','form']}},additionalProperties:false}},
    ]}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
      const kind=request.params.arguments?.kind??'url',id=randomUUID(),record={kind,route:url.pathname,id};calls.push(record);
      try{
        const params=kind==='form'?{mode:'form',message:'请选择本机验收参数',requestedSchema:{type:'object',properties:{label:{type:'string',title:'Label'},zoom:{type:'integer',title:'Zoom',minimum:0,maximum:22,default:12}},required:['label','zoom']}}:{mode:'url',message:'本机浏览器授权验收。请打开页面，连接器会单独确认结果。',url:kind==='invalid'?'javascript:alert(1)':`${origin}/authorize/${id}`,elicitationId:id};
        const value=await server.elicitInput(params,{timeout:60000});record.action=value.action;record.content=value.content;
        if(value.action==='accept'&&kind==='url'){
          if(!browserArrivals.has(id)){let timer;try{await Promise.race([new Promise(resolve=>pendingBrowser.set(id,resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Browser did not reach the fixture')),15000);})]);}finally{clearTimeout(timer);}}
          record.browserReached=true;
          await server.notification({method:'notifications/elicitation/complete',params:{elicitationId:id}});
        }
        const result={action:value.action,browserReached:!!record.browserReached,...(value.content?{content:value.content}:{}),confirmed:!!record.browserReached};
        return{content:[{type:'text',text:JSON.stringify(result)}]};
      }catch(error){record.error=error.message;return{isError:true,content:[{type:'text',text:error.message.includes('does not support')?'MCP_USER_REQUIRED: '+error.message:error.message}]};}
      finally{pendingBrowser.delete(id);}
    });
    transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:id=>sessions.set(id,transport)});
    transport.onclose=()=>{sessions.delete(transport.sessionId);};await server.connect(transport);
  }
  if(!transport){res.writeHead(400).end();return;}
  try{await transport.handleRequest(req,res,body);}catch(error){if(!res.headersSent)res.writeHead(500).end();}
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${fixture.address().port}`;
const{chromium}=await import(pathToFileURL(process.argv[2]).href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let attempt=0;attempt<30&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,500));}assert(page);
await page.locator('textarea:not([disabled])').waitFor();const errors=[];page.on('pageerror',error=>errors.push(error.message));
const rpc=async(command,args={})=>{const response=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(response.error)throw Object.assign(new Error(`${command}: ${response.error.message??JSON.stringify(response.error)}`),response.error);return response.value;};
const owned=[];let original,conversation;
const report={fixture:'Local MCP SDK protocol service; not an external provider login',cases:[],model:null};
const checkpoint=()=>fs.writeFileSync(path.join(output,'partial.json'),JSON.stringify({cases:report.cases,calls,initializations},null,2));
try{
  original=await page.evaluate(async()=>{const{api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{active:store.getItem('geod-agent-active-conversation-0.1'),language:localStorage.getItem('geod-agent-language-v1')};});
  await page.evaluate(async()=>{const{setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.getByRole('button',{name:'新对话',exact:true}).click();await page.waitForFunction(prior=>!!document.querySelector('.conversation-item.active')&&document.querySelector('.conversation-item.active').getAttribute('data-conversation-id')!==prior,original.active);
  conversation=await page.locator('.conversation-item.active').getAttribute('data-conversation-id');assert(conversation);
  const workspace=await rpc('workspace_get',{conversationId:conversation});
  await rpc('workspace_set',{conversationId:conversation,directory:workspace.directory,permission:'fullAccess'});
  // A fixture user message makes the normal transcript and native request queue
  // visible; all MCP results and the subsequent AI reply remain native/live.
  await page.evaluate(async({conversation,directory})=>{const{api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)??'[]');const chat=chats.find(item=>item.conversationId===conversation);chat.engine='codex';chat.title='浏览器交互验收';chat.workspaceDirectory=directory;chat.display=[{id:crypto.randomUUID(),role:'user',content:'验收连接器的浏览器交互'}];store.setItem(CHAT_LIST_KEY,JSON.stringify(chats));await flushLocalState();},{conversation,directory:workspace.directory});
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  const added=await rpc('mcp_add',{name:'浏览器验收私有连接器',url:`${origin}/private`,headers:{Authorization:`Bearer ${token}`}}),privateConnector=added.connectors.find(item=>item.url===`${origin}/private`);owned.push(privateConnector.id);await rpc('mcp_set_enabled',{id:privateConnector.id,enabled:true});
  const start=async kind=>page.evaluate(async({id,conversation,kind})=>{window.__mcpAudit={};window.__TAURI_INTERNALS__.invoke('mcp_call',{id,conversationId:conversation,toolName:'browser_continue',arguments:{kind},executionId:'browser-test:'+crypto.randomUUID(),interactive:true}).then(result=>window.__mcpAudit.result=result).catch(error=>window.__mcpAudit.error=error).finally(()=>window.__mcpAudit.finished=true);},{id:privateConnector.id,conversation,kind});
  const finish=async()=>{await page.waitForFunction(()=>window.__mcpAudit.finished,null,{timeout:80000});const value=await page.evaluate(()=>window.__mcpAudit);assert(!value.error,JSON.stringify(value.error));return value.result;};
  const card=()=>page.locator('.codex-request-card');
  await start('url');await card().waitFor();const first=await rpc('mcp_requests_pending',{conversationId:conversation});assert.equal(first.length,1);
  await assert.rejects(()=>rpc('mcp_request_reply',{requestId:first[0].requestId,value:{action:'accept',content:null}}),error=>error.code==='MCP_BROWSER_NOT_OPENED');
  if(original.active){await page.locator(`.conversation-item[data-conversation-id="${original.active}"]`).click();await page.waitForFunction(id=>document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')===id,original.active);await assert.equal(await card().count(),0);assert.equal((await rpc('mcp_requests_pending',{conversationId:conversation})).length,1);await page.locator(`.conversation-item[data-conversation-id="${conversation}"]`).click();await card().waitFor();}
  await card().getByRole('button',{name:'取消',exact:true}).click();let result=await finish();assert(JSON.stringify(result).includes('cancel'));assert(!calls.at(-1).browserReached);report.cases.push({name:'Cancel returns cancel without opening browser',passed:true,result});
  await start('invalid');await card().waitFor();assert(await card().getByRole('button',{name:'打开浏览器继续'}).isDisabled());const invalid=await rpc('mcp_requests_pending',{conversationId:conversation});await assert.rejects(()=>rpc('mcp_request_open_browser',{requestId:invalid[0].requestId}),error=>error.code==='MCP_BROWSER_URL');await card().getByRole('button',{name:'取消',exact:true}).click();await finish();report.cases.push({name:'Non-web URL rejected by UI and native opener',passed:true});
  await start('form');await card().getByRole('textbox',{name:'Label'}).fill('actual-form');await card().getByRole('button',{name:'发送回复',exact:true}).click();result=await finish();assert.equal(calls.at(-1).content.zoom,12);assert.equal(calls.at(-1).content.label,'actual-form');report.cases.push({name:'Private native form preserves schema types',passed:true,result});
  await start('url');await card().waitFor();await page.screenshot({path:path.join(output,'private-browser-flow-zh.png')});await card().getByRole('button',{name:'打开浏览器继续'}).click();result=await finish();assert.equal(calls.at(-1).browserReached,true);assert(JSON.stringify(result).includes('confirmed'));assert.equal((await rpc('mcp_requests_pending',{conversationId:conversation})).length,0);report.cases.push({name:'Native private flow opens system browser and reads connector confirmation',passed:true,result});
  checkpoint();console.log('Native browser, form, cancel, invalid URL and conversation isolation passed.');
  // The same native client handler is used by a real, isolated stdio process.
  const stdioName='浏览器验收本地连接器';
  const stdioAdded=await rpc('mcp_add',{name:stdioName,url:'',command:path.resolve('apps/geod-agent-desktop/src-tauri/resources/codex/node.exe'),args:[path.resolve('scripts/browser-elicitation-stdio.mjs')],env:{GEOD_BROWSER_FIXTURE:origin}}),stdioConnector=stdioAdded.connectors.find(item=>item.name===stdioName);owned.push(stdioConnector.id);await rpc('mcp_set_enabled',{id:stdioConnector.id,enabled:true});
  await page.evaluate(({id,conversation})=>{window.__mcpAudit={};window.__TAURI_INTERNALS__.invoke('mcp_call',{id,conversationId:conversation,toolName:'browser_continue',arguments:{},executionId:'browser-stdio:'+crypto.randomUUID(),interactive:true}).then(result=>window.__mcpAudit.result=result).catch(error=>window.__mcpAudit.error=error).finally(()=>window.__mcpAudit.finished=true);},{id:stdioConnector.id,conversation});
  await card().getByRole('button',{name:'打开浏览器继续'}).waitFor();await card().getByRole('button',{name:'打开浏览器继续'}).click();result=await finish();assert(JSON.stringify(result).includes('stdio'));assert(JSON.stringify(result).includes('accept'));report.cases.push({name:'Actual native stdio process supports browser interaction',passed:true,result});
  await assert.rejects(()=>rpc('mcp_call',{id:stdioConnector.id,conversationId:conversation,toolName:'browser_continue',arguments:{},executionId:'browser-background:'+randomUUID(),interactive:false}),error=>error.code==='USER_INPUT_REQUIRED');assert.equal((await rpc('mcp_requests_pending',{conversationId:conversation})).length,0);report.cases.push({name:'Background native client pauses for required user input without opening browser',passed:true});await rpc('mcp_set_enabled',{id:stdioConnector.id,enabled:false});checkpoint();
  await assert.rejects(()=>rpc('mcp_request_open_browser',{requestId:randomUUID()}),error=>error.code==='MCP_REQUEST_GONE');
  await rpc('mcp_set_enabled',{id:privateConnector.id,enabled:false});
  const publicAdded=await rpc('mcp_add',{name:'浏览器验收公开连接器',url:`${origin}/public`}),publicConnector=publicAdded.connectors.find(item=>item.url===`${origin}/public`);owned.push(publicConnector.id);await rpc('mcp_set_enabled',{id:publicConnector.id,enabled:true});
  await page.evaluate(async()=>{const source=await(await fetch('/src/agent-panel.tsx')).text(),specifier=[...source.matchAll(/from "([^"]+)"/g)].map(match=>match[1]).find(value=>value.includes('/src/api.ts'));const{api}=await import(specifier),turn=api.codexTurn;window.__browserModelAudit={events:[]};api.codexTurn=async(...args)=>{const emit=args[4];args[4]=event=>{window.__browserModelAudit.events.push(event);emit(event);};try{return window.__browserModelAudit.result=await turn(...args);}catch(error){window.__browserModelAudit.error={code:error.code,message:error.message};throw error;}finally{window.__browserModelAudit.finished=true;}};});
  const exactTool=`mcp__geod_${publicConnector.id.replaceAll('-','_')}__browser_continue`;
  await page.locator('textarea').fill(`浏览器流程验收：调用原生 MCP 工具 ${exactTool}，参数 kind=url。此次专门验收这一个原生 MCP 工具，请不要调用 extensions_list 或 mcp_call 包装器。必须实际调用并等用户完成浏览器流程，根据真实工具结果简短报告是否确认成功。`);await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>!!document.querySelector('.codex-browser-flow')||window.__browserModelAudit.finished,null,{timeout:120000});assert(await card().getByRole('button',{name:'打开浏览器继续'}).count(),JSON.stringify(await page.evaluate(()=>window.__browserModelAudit.result??window.__browserModelAudit.error)));await page.screenshot({path:path.join(output,'codex-browser-request-zh.png')});await card().getByRole('button',{name:'打开浏览器继续'}).click();
  await page.waitForFunction(()=>window.__browserModelAudit.finished,null,{timeout:180000});const audit=await page.evaluate(()=>window.__browserModelAudit);assert.equal(audit.result?.status,'completed',JSON.stringify(audit.error));assert(audit.events.some(event=>event.type==='request'&&event.method==='mcpServer/elicitation/request'&&event.params.mode==='url'),'Codex app-server did not deliver the URL request');assert.equal(calls.at(-1).browserReached,true);report.model={passed:true,result:audit.result,codexUrlRequest:true};
  await page.screenshot({path:path.join(output,'codex-browser-result-zh.png')});assert.deepEqual(errors,[]);report.calls=calls;report.initializations=initializations;report.pageErrors=errors;report.passed=true;
  assert(!JSON.stringify(report).includes(token));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.map(item=>item.name),realModel:true,codexUrlRequest:true}));
}catch(error){fs.writeFileSync(path.join(output,'attempt.json'),JSON.stringify({error:String(error.message??error),calls,initializations,model:await page.evaluate(()=>window.__browserModelAudit).catch(()=>null)},null,2));throw error;}
finally{
  if(conversation)await rpc('mcp_requests_cancel',{conversationId:conversation}).catch(()=>{});
  for(const id of owned)await rpc('mcp_remove',{id}).catch(()=>{});
  if(original)await page.evaluate(async({original,conversation})=>{const{api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,deleteStoredConversation}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);if(conversation)deleteStoredConversation(store,conversation);if(original.active)store.setItem('geod-agent-active-conversation-0.1',original.active);if(original.language)localStorage.setItem('geod-agent-language-v1',original.language);else localStorage.removeItem('geod-agent-language-v1');await flushLocalState();},{original,conversation}).catch(()=>{});
  await page.reload().catch(()=>{});await browser.close();for(const transport of sessions.values())await transport.close().catch(()=>{});fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
