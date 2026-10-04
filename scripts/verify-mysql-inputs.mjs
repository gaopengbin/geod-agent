import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output=path.resolve('artifacts/product-gaps-20261004/sql-inputs'),workspace=path.join(output,'workspace');
const fixture=JSON.parse(fs.readFileSync(path.join(output,'mysql-fixture.json'),'utf8'));
const privateState=JSON.parse(fs.readFileSync(path.join(output,'mysql-private-state.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let n=0;n<100&&!page;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,100));}assert(page);
await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(e){return{error:{code:e?.code,message:e?.message||String(e)}};}},{command,args});if(result.error)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.value;};
const report={passed:false,cases:[]},saved=[],conversationId=randomUUID();let original,uiId,scheduleId;
if(fs.existsSync(path.join(output,'mysql-result.json')))fs.copyFileSync(path.join(output,'mysql-result.json'),path.join(output,'mysql-result-attempt-'+Date.now()+'.json'));
function publicWrite(file,value){const text=JSON.stringify(value,null,2);assert(!text.includes(privateState.password),'Private fixture password entered public evidence');fs.writeFileSync(path.join(output,file),text);}
function record(name,details={}){report.cases.push({name,passed:true,...details});publicWrite('mysql-result.json',report);console.log(JSON.stringify({name,passed:true}));}
async function chatState(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});}
try{
  assert.equal(await page.locator('.conversation-running-dot').count(),0);
  const background=await rpc('background_status');assert.equal(background.activeAiTurns,0);assert.equal(background.activeDownloads,0);
  original={...(await chatState()),...(await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})))};
  const baseline=(await rpc('sql_connections_list')).connections;
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const connection=await rpc('sql_connection_connect',{conversationId,request:{credentialFile:fixture.credentialFile}});
  assert(!connection.error,JSON.stringify(connection));saved.push(connection.connection.id);assert.equal(connection.connection.database,fixture.database);
  assert.equal(connection.mcp.server,'DBHub MCP Server');assert.equal(connection.mcp.version,'1.4.0');assert(connection.catalog.results.some(row=>row.name==='regions'));
  record('Actual native DBHub connects to a Unicode MySQL database from native credential file',{connection:connection.connection,mcp:connection.mcp,catalog:connection.catalog});
  const fields=await rpc('sql_objects_search',{connectionId:connection.connection.id,request:{objectType:'column',schema:fixture.database,table:'regions',detailLevel:'full'}});assert(fields.result.results.some(row=>row.name==='score'));
  const rows=await rpc('sql_query',{connectionId:connection.connection.id,sql:'SELECT * FROM regions ORDER BY id'});assert.equal(rows.result.statements[0].rows[0].city,'北京');assert.equal(rows.result.statements[0].rows[0].note,'制表符\t与换行\n正文');assert.equal(rows.result.statements[0].rows[0].big_integer,'9223372036854775806');
  const sum=await rpc('sql_query',{connectionId:connection.connection.id,sql:'SELECT SUM(score) AS total FROM regions'});assert.equal(Number(sum.result.statements[0].rows[0].total),50);
  record('Actual MySQL catalog fields, Unicode, newlines, precise bigint and aggregation',{fields:fields.result,rows:rows.result,sum:sum.result});
  let violation;try{await rpc('sql_query',{connectionId:connection.connection.id,sql:'DELETE FROM regions WHERE id < 0'});}catch(e){violation=e;}assert.equal(violation?.code,'INPUT_READ_ONLY');
  const noPassword=await rpc('sql_connection_connect',{conversationId,request:{name:'SQL_MYSQL_AUTH_CHECK',kind:'mysql',host:fixture.host,port:fixture.port,database:fixture.database,user:fixture.user,sslMode:'disable'}});
  assert.equal(noPassword.error?.code,'INPUT_AUTH_REQUIRED');assert(!Object.hasOwn(noPassword.authentication,'password'));
  const wrong=await rpc('sql_connection_save',{conversationId,draft:{...noPassword.authentication,password:'wrong-fixture-password'}});assert.equal(wrong.error?.code,'INPUT_AUTH_REQUIRED');assert(!JSON.stringify(wrong).includes('wrong-fixture-password'));
  record('Actual read-only rejection and native missing/wrong password request without credential disclosure');
  const actual=process.argv.includes('--resume-model')?JSON.parse(fs.readFileSync(path.join(output,'actual-model-mysql.json'),'utf8')):await page.evaluate(async p=>{
    const {runCodexTurn}=await import('/src/codex-client.ts'),{executeDataInputTool}=await import('/src/data-input-tools.ts');const calls=[],generations=[];
    const result=await runCodexTurn(crypto.randomUUID(),p.conversationId,'实际 MySQL 输入验收。通过 sql_connection_connect 读取用户提供的工作区相对配置文件 '+p.credentialFile+'。发现实际表及字段，再用 sql_query 查询 regions。最终只回复 marker 列的 MYSQL_ 开头标记、两条城市名和 score 总和。不要用文件或 shell 工具读取配置文件，也不要重复询问连接信息。',[],{onEvent:()=>{},onModel:()=>{},onGeneration:g=>generations.push({state:g.state,inputTokens:g.inputTokens}),onRequest:async()=>({decision:'decline'}),execute:async call=>{const args=JSON.parse(call.function.arguments||'{}');if(!call.function.name.startsWith('sql_'))return{result:{error:'QA_SQL_INPUT_TOOLS_ONLY'}};const result=await executeDataInputTool(p.conversationId,call.function.name,args);calls.push({name:call.function.name,args,result});return{result};}});
    return{result,calls,generations};
  },{conversationId,credentialFile:fixture.credentialFile});
  if(!process.argv.includes('--resume-model'))for(const call of actual.calls)if(call.result?.connection?.id)saved.push(call.result.connection.id);
  publicWrite('actual-model-mysql.json',actual);assert.equal(actual.result.status,'completed');assert(actual.result.text.includes(fixture.marker));assert(actual.result.text.includes('50'));assert(actual.generations.every(g=>g.state==='settled'&&g.inputTokens>0));
  record('Real Codex/DeepSeek connects, discovers and queries MySQL through MCP',{actualAnswer:actual.result.text,tools:actual.calls.map(call=>call.name)});
  // Actual application prompt must suspend for a native password dialog.
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.locator('.sidebar-new-chat').click();await page.waitForFunction(async old=>{const {localStateStore}=await import('/src/local-state.ts'),{accountChatStore}=await import('/src/pending-generations.ts'),{api}=await import('/src/api.ts');const auth=await api.authStatus();return accountChatStore(localStateStore,auth.userId).getItem('geod-agent-active-conversation-0.1')!==old;},original.active);
  uiId=(await chatState()).active;const assigned=await rpc('workspace_get',{conversationId:uiId});await rpc('workspace_set',{conversationId:uiId,directory:assigned.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:uiId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
  await page.locator('textarea').fill('实际数据库密码交互验收：请调用 sql_connection_connect 新建 MySQL 连接，名称 MYSQL_UI_AUTH_'+uiId+'，主机 '+fixture.host+'，端口 '+fixture.port+'，数据库「'+fixture.database+'」，用户名 '+fixture.user+'，sslMode disable。需要密码时使用工具提供的认证界面。连接后发现实际表，再读取 regions 的 marker 与 score 总和；最终只回复 MYSQL_ 随机标记及总和。不要复用其他连接、不要使用 shell、不要读取配置文件、不要在聊天索要密码。');await page.locator('textarea').press('Enter');
  const dialog=page.locator('.sql-connection-dialog');await dialog.waitFor({timeout:120000});assert.equal(await dialog.locator('input[type=password]').count(),1);assert.equal(await dialog.locator('input[type=password]').inputValue(),'');
  await page.setViewportSize({width:1000,height:720});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await page.waitForTimeout(400);
  const bounds=await dialog.boundingBox();assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1001&&bounds.y+bounds.height<=721);await page.screenshot({path:path.join(output,'mysql-auth-dark-zh.png')});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});await page.waitForTimeout(400);assert.equal(await dialog.getByRole('heading',{name:'Database authentication',exact:true}).count(),1);await page.screenshot({path:path.join(output,'mysql-auth-light-en.png')});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await dialog.locator('input[type=password]').fill('wrong-fixture-password');await dialog.getByRole('button',{name:'测试并保存',exact:true}).click();await dialog.getByRole('alert').waitFor({timeout:60000});assert(!(await dialog.getByRole('alert').textContent()).includes('wrong-fixture-password'));
  await dialog.locator('input[type=password]').fill(privateState.password);await dialog.getByRole('button',{name:'测试并保存',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});
  await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),fixture.marker,{timeout:180000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:30000});
  const uiChat=(await chatState()).chats.find(chat=>chat.conversationId===uiId);assert(uiChat.display.some(item=>item.toolName==='sql_query'));publicWrite('actual-ui-mysql-chat.json',uiChat);
  const after=(await rpc('sql_connections_list')).connections;for(const item of after)if(!baseline.some(old=>old.id===item.id))saved.push(item.id);
  assert.equal(await page.locator('input[type=password]').count(),0);record('Actual AI opens native password form, preserves narrow bilingual layout, retries and reads data',{conversationId:uiId});
  const schedule=await rpc('ai_schedules_create',{conversationId,name:'MySQL 实际后台读取验收',prompt:'仅使用 sql_query 连接 '+connection.connection.id+'，查询 regions 表的 marker 列和 score 总和。最后只回复 MYSQL_ 开头的随机标记及总和，不使用其他工具。',nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});scheduleId=schedule.scheduleId;
  let scheduled;const deadline=Date.now()+180000;while(Date.now()<deadline){const list=await rpc('ai_schedules_list',{conversationId}),run=list.runs.find(run=>run.scheduleId===scheduleId);if(run&&!['running','queued'].includes(run.state)){scheduled=await rpc('ai_schedules_run_events',{runId:run.runId});break;}await new Promise(r=>setTimeout(r,1000));}
  publicWrite('actual-background-mysql.json',scheduled);assert.equal(scheduled?.run.state,'succeeded');assert(JSON.stringify(scheduled.events).includes(fixture.marker));record('Actual companion background Agent queries saved MySQL MCP connection',{run:scheduled.run});
  // Leave one owned connection for actual desktop restart validation.
  for(const id of new Set(saved))if(id!==connection.connection.id)await rpc('sql_connection_remove',{connectionId:id});
  publicWrite('mysql-restart-state.json',{conversationId,connectionId:connection.connection.id,baselineIds:baseline.map(c=>c.id)});saved.length=0;report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false}).catch(()=>{});
  if(uiId){const all=await rpc('sql_connections_list').catch(()=>({connections:[]}));for(const connection of all.connections)if(connection.name==='MYSQL_UI_AUTH_'+uiId)saved.push(connection.id);}
  for(const id of new Set(saved))await rpc('sql_connection_remove',{connectionId:id}).catch(()=>{});
  if(original&&uiId){await page.evaluate(async p=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStateStore,p.original.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>chat.conversationId!==p.uiId)));store.setItem('geod-agent-active-conversation-0.1',p.original.active);await flushLocalState();},{original,uiId}).catch(()=>{});await page.reload();await page.locator('.conversation-account-trigger').waitFor();}
  if(original){await page.evaluate(async p=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(p.language)setLanguagePreferences(JSON.parse(p.language));document.documentElement.dataset.theme=p.theme;document.documentElement.style.colorScheme=p.theme;},original).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  publicWrite('mysql-result.json',report);await browser.close();
}
