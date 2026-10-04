/** Actual databases, native DBHub and real Codex/DeepSeek discovery and queries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const provider=process.argv[2];assert(['mariadb','sqlserver','oracle'].includes(provider));
const root=path.resolve('artifacts/product-gaps-20261004/database-providers'),workspace=path.join(root,'workspace');
const fixture=JSON.parse(fs.readFileSync(path.join(root,`${provider}-fixture.json`),'utf8'));
const privateState=JSON.parse(fs.readFileSync(path.join(root,`${provider}-private-state.json`),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const outputFile=path.join(root,`${provider}-result.json`),report={passed:false,cases:[]},saved=new Set(),conversationId=randomUUID();let original,uiId,scheduleId,primaryId,baseline=[];
if(fs.existsSync(outputFile))fs.copyFileSync(outputFile,path.join(root,`${provider}-attempt-${Date.now()}.json`));
const publicWrite=(name,value)=>{const text=JSON.stringify(value,null,2);assert(!text.includes(privateState.password)&&!text.includes(privateState.readerPassword),'Private credentials entered evidence');fs.writeFileSync(path.join(root,name),text);};
const record=(name,details={})=>{report.cases.push({name,passed:true,...details});publicWrite(`${provider}-result.json`,report);console.log(JSON.stringify({name,passed:true}));};
const lower=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.toLowerCase(),value]));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function state(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});}
try{
  original={...(await state()),...(await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})))};
  const previousStateFile=path.join(root,`${provider}-restart-state.json`);
  if(fs.existsSync(previousStateFile)){const previous=JSON.parse(fs.readFileSync(previousStateFile,'utf8'));if(previous.partial){const connection=(await rpc('sql_connections_list')).connections.find(connection=>connection.id===previous.connectionId);if(connection){assert.equal(connection.port,fixture.port);assert.equal(connection.database,fixture.database);await rpc('sql_connection_remove',{connectionId:previous.connectionId});}}}
  baseline=(await rpc('sql_connections_list')).connections;
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  await rpc('ai_model_select',{conversationId,channelId:'hosted',modelId:'hosted'});
  const connected=await rpc('sql_connection_connect',{conversationId,request:{credentialFile:fixture.credentialFile}});assert(!connected.error,JSON.stringify(connected.error));primaryId=connected.connection.id;saved.add(primaryId);assert.equal(connected.mcp.server,'DBHub MCP Server');assert.equal(connected.mcp.version,'1.4.0');
  record(`Actual ${provider} connection uses the bundled native MCP with system credentials`,{connection:connected.connection,mcp:connected.mcp});
  const tables=await rpc('sql_objects_search',{connectionId:primaryId,request:{objectType:'table',schema:fixture.schema,pattern:'%REGIONS%',detailLevel:'full'}});
  // MySQL-family identifiers follow the container's case-sensitive defaults.
  let actualTables=tables;if(!tables.result.results?.length)actualTables=await rpc('sql_objects_search',{connectionId:primaryId,request:{objectType:'table',schema:fixture.schema,pattern:'%regions%',detailLevel:'full'}});
  assert(actualTables.result.results.some(row=>String(row.name).toLowerCase()==='regions'));
  const fields=await rpc('sql_objects_search',{connectionId:primaryId,request:{objectType:'column',schema:fixture.schema,table:provider==='oracle'?'REGIONS':'regions',detailLevel:'full'}});assert(fields.result.results.some(row=>String(row.name).toLowerCase()==='score'));
  const data=await rpc('sql_query',{connectionId:primaryId,sql:`SELECT * FROM ${fixture.table} ORDER BY id`}),rows=data.result.statements[0].rows.map(lower);
  assert.equal(rows.length,2);assert.equal(rows[0].city,'北京');assert.equal(rows[1].city,'上海');assert.equal(rows[0].note,'制表符\t与换行\n正文');
  const sum=await rpc('sql_query',{connectionId:primaryId,sql:`SELECT SUM(score) AS total FROM ${fixture.table}`});assert.equal(Number(lower(sum.result.statements[0].rows[0]).total),50);
  // The exact bigint must survive a normal SELECT, not a pre-cast fixture query.
  assert.equal(String(rows[0].big_integer),'9223372036854775806');
  record(`Actual ${provider} schema and fields preserve Unicode, newlines, decimal and large integer data`,{tables:actualTables.result,fields:fields.result,data:data.result,sum:sum.result});
  await assert.rejects(rpc('sql_query',{connectionId:primaryId,sql:`DELETE FROM ${fixture.table} WHERE id < 0`}),error=>error.code==='INPUT_READ_ONLY');
  const authentication=await rpc('sql_connection_connect',{conversationId,request:{name:`${provider} native authentication QA`,kind:fixture.kind,host:fixture.host,port:fixture.port,database:fixture.database,user:fixture.user,sslMode:fixture.sslMode}});assert.equal(authentication.error?.code,'INPUT_AUTH_REQUIRED');assert(!Object.hasOwn(authentication.authentication,'password'));
  const wrong=await rpc('sql_connection_save',{conversationId,draft:{...authentication.authentication,password:'Wrong_QA_9!'}});assert.equal(wrong.error?.code,'INPUT_AUTH_REQUIRED');assert(!JSON.stringify(wrong).includes('Wrong_QA_9!'));
  record(`Actual ${provider} rejects writes and requests missing or incorrect credentials without disclosure`);
  const actual=await page.evaluate(async value=>{
    const {runCodexTurn}=await import('/src/codex-client.ts'),{executeDataInputTool}=await import('/src/data-input-tools.ts');const calls=[],generations=[],events=[];
    try{
      const result=await runCodexTurn(crypto.randomUUID(),value.conversationId,'实际 '+value.provider+' 数据库验收。用 sql_connection_connect 读取工作区相对连接配置 '+value.credentialFile+'。通过 MCP 发现 '+value.schema+' 架构下的实际 regions 表及字段，再查询表 '+value.table+'。最终回复 marker 列以 '+value.prefix+' 开头的完整标记、两座城市、两行 score 总和和第一行 big_integer 的完整值。不要使用文件或 shell 工具读取配置，也不要询问已有配置。',[],{
        onEvent:event=>{if(['error','status','stderr'].includes(event.type))events.push(event);},onModel:()=>{},onGeneration:record=>generations.push({state:record.state,inputTokens:record.inputTokens}),onRequest:async()=>({decision:'decline'}),
        execute:async call=>{const args=JSON.parse(call.function.arguments||'{}'),entry={name:call.function.name,args};calls.push(entry);if(!call.function.name.startsWith('sql_'))return{result:{error:'QA_SQL_TOOLS_ONLY'}};try{entry.result=await executeDataInputTool(value.conversationId,call.function.name,args);return{result:entry.result};}catch(error){entry.error={code:error?.code,message:error?.message||String(error)};throw error;}}
      });return{result,calls,generations,events};
    }catch(error){return{error:{code:error?.code,message:error?.message||String(error)},calls,generations,events};}
  },{conversationId,provider,credentialFile:fixture.credentialFile,schema:fixture.schema,table:fixture.table,prefix:provider.toUpperCase()+'_'});
  for(const call of actual.calls)if(call.result?.connection?.id)saved.add(call.result.connection.id);
  publicWrite(`${provider}-actual-model.json`,actual);if(actual.error)throw actual.error;assert.equal(actual.result.status,'completed');assert(actual.result.text.includes(fixture.marker)&&actual.result.text.includes('50')&&actual.result.text.includes('9223372036854775806'));assert(actual.calls.some(call=>call.name==='sql_connection_connect'));assert(actual.calls.some(call=>call.name==='sql_objects_search'));assert(actual.calls.some(call=>call.name==='sql_query'));assert(actual.generations.every(generation=>generation.state==='settled'&&generation.inputTokens>0));
  record(`Real Codex/DeepSeek connects to ${provider}, discovers actual columns and queries the database`,{tools:actual.calls.map(call=>call.name),actualAnswer:actual.result.text});
  if(provider!=='mariadb'){
    await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});await page.locator('.sidebar-new-chat').click();uiId=(await state()).active;
    const assigned=await rpc('workspace_get',{conversationId:uiId});await rpc('workspace_set',{conversationId:uiId,directory:assigned.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:uiId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
    await page.locator('textarea').fill('实际数据库认证验收。通过 sql_connection_connect 新建 '+provider+' 连接，名称 PROVIDER_UI_'+uiId+'，kind '+fixture.kind+'，主机 '+fixture.host+'，端口 '+fixture.port+'，数据库 '+fixture.database+'，用户名 '+fixture.user+'，sslMode '+fixture.sslMode+'。需要密码时使用原生认证界面。连接后用 sql_query 查询 '+fixture.table+' 的 marker，最终只回复实际 '+provider.toUpperCase()+'_ 开头的完整标记。不要复用已有连接、不要使用 shell、不要在聊天索要密码。');await page.locator('textarea').press('Enter');
    const dialog=page.locator('.sql-connection-dialog');await dialog.waitFor({timeout:180000});assert.equal(await dialog.locator('input[type=password]').inputValue(),'');await page.setViewportSize({width:1000,height:720});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await delay(400);await page.screenshot({path:path.join(root,`${provider}-native-auth-dark-zh.png`)});
    await dialog.locator('input[type=password]').fill(privateState.readerPassword);await dialog.getByRole('button',{name:'测试并保存',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),fixture.marker,{timeout:180000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:30000});
    const chat=(await state()).chats.find(chat=>chat.conversationId===uiId);publicWrite(`${provider}-actual-ui-chat.json`,chat);assert(chat.display.some(item=>item.toolName==='sql_query'));assert(!JSON.stringify(chat).includes(privateState.readerPassword));record(`Actual ${provider} AI opens native password entry and reads data in the real application`,{conversationId:uiId});
  }
  const schedule=await rpc('ai_schedules_create',{conversationId,name:`Actual ${provider} background MCP QA`,prompt:'只调用 sql_query，使用连接 '+primaryId+' 查询 '+fixture.table+' 的 marker 列。最终回复实际 '+provider.toUpperCase()+'_ 开头的完整随机标记，不调用其他工具。',nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});scheduleId=schedule.scheduleId;
  let background;const deadline=Date.now()+180000;while(Date.now()<deadline){const status=await rpc('ai_schedules_list',{conversationId}),run=status.runs.find(run=>run.scheduleId===scheduleId);if(run&&!['queued','running'].includes(run.state)){background=await rpc('ai_schedules_run_events',{runId:run.runId});break;}await delay(1000);}
  publicWrite(`${provider}-actual-background.json`,background);assert.equal(background?.run.state,'succeeded');assert(JSON.stringify(background.events).includes(fixture.marker));record(`Actual companion Agent reads ${provider} through the saved MCP connection`,{run:background.run});
  publicWrite(`${provider}-restart-state.json`,{provider,conversationId,connectionId:primaryId,originalChatIds:original.chats.map(chat=>chat.conversationId),baselineIds:baseline.map(connection=>connection.id)});report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false}).catch(()=>{});
  const connections=(await rpc('sql_connections_list').catch(()=>({connections:[]}))).connections;for(const connection of connections)if(!baseline.some(previous=>previous.id===connection.id))saved.add(connection.id);
  for(const id of saved)if(id!==primaryId)await rpc('sql_connection_remove',{connectionId:id}).catch(()=>{});
  if(primaryId&&!report.passed)publicWrite(`${provider}-restart-state.json`,{provider,conversationId,connectionId:primaryId,baselineIds:baseline.map(connection=>connection.id),partial:true});
  if(original&&uiId){await page.evaluate(async({original,uiId})=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStateStore,original.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>chat.conversationId!==uiId)));store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();},{original:{userId:original.userId,active:original.active},uiId}).catch(()=>{});await page.reload();await page.locator('.conversation-account-trigger').waitFor();}
  if(original){await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{language:original.language,theme:original.theme}).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  publicWrite(`${provider}-result.json`,report);await browser.close();
}
