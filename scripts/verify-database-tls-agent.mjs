/** Real Codex turns, native certificate entry and closed-window schedules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const mode=process.argv[2];assert(['models','ui','ui-resume','background'].includes(mode));
const root=path.resolve('artifacts/product-gaps-20261004/database-tls'),qaFile=path.join(root,'qa-state.json');
const qa=JSON.parse(fs.readFileSync(qaFile,'utf8')),providers=['mysql','mariadb','sqlserver','oracle'];
const fixtures=Object.fromEntries(providers.map(provider=>[provider,JSON.parse(fs.readFileSync(path.join(root,provider+'-fixture.json'),'utf8'))]));
const privateStates=Object.fromEntries(providers.map(provider=>[provider,JSON.parse(fs.readFileSync(path.join(root,'private',provider,'state.json'),'utf8'))]));
const secrets=providers.flatMap(provider=>[privateStates[provider].password,privateStates[provider].readerPassword,...['ca','wrong-ca','client','wrong-client','server'].map(name=>fs.readFileSync(path.join(root,'private',provider,name+'.key'),'utf8'))]);
const publicWrite=(name,value)=>{const text=JSON.stringify(value,null,2);assert(secrets.every(secret=>!text.includes(secret)),'Private credentials entered evidence');fs.writeFileSync(path.join(root,name),text);};
const report={passed:false,cases:[]},reportName='agent-'+(mode==='ui-resume'?'ui':mode)+'-result.json';
if(fs.existsSync(path.join(root,reportName)))fs.copyFileSync(path.join(root,reportName),path.join(root,reportName.replace('.json','-attempt-'+Date.now()+'.json')));
const record=(name,detail={})=>{report.cases.push({name,passed:true,...detail});publicWrite(reportName,report);console.log(JSON.stringify({name,passed:true}));};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let attempt=0;attempt<60&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await delay(500);}
assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
try{
  if(mode==='models'){
    await rpc('ai_model_select',{conversationId:qa.conversationId,channelId:'hosted',modelId:'hosted'});
    for(const provider of providers){
      const fixture=fixtures[provider];
      const actual=await page.evaluate(async value=>{
        const {runCodexTurn}=await import('/src/codex-client.ts'),{executeDataInputTool}=await import('/src/data-input-tools.ts');const calls=[],generations=[];
        try{const result=await runCodexTurn(crypto.randomUUID(),value.conversationId,'实际 '+value.provider+' 私有 CA 数据库验收。用 sql_connection_connect 连接工作区相对配置 '+value.credentialFile+'。通过 MCP 发现 '+value.schema+' 的 regions 表及字段，再用 sql_query 读取表 '+value.table+' 的 CITY/MARKER。最终回复实际城市和以 '+value.prefix+' 开头的完整随机标记。不要用 shell 或文件工具读取连接文件，不要推测数据。',[],{
          onEvent:()=>{},onModel:()=>{},onGeneration:g=>generations.push({state:g.state,inputTokens:g.inputTokens}),onRequest:async()=>({decision:'decline'}),
          execute:async call=>{const entry={name:call.function.name,args:JSON.parse(call.function.arguments||'{}')};calls.push(entry);if(!entry.name.startsWith('sql_'))return{result:{error:'QA_SQL_TOOLS_ONLY'}};entry.result=await executeDataInputTool(value.conversationId,entry.name,entry.args);return{result:entry.result};}
        });return{result,calls,generations};}catch(error){return{error:{code:error?.code,message:error?.message||String(error)},calls,generations};}
      },{conversationId:qa.conversationId,provider,credentialFile:fixture.credentialFile,table:fixture.table,schema:fixture.schema,prefix:provider.toUpperCase()+'_TLS_'});
      for(const call of actual.calls)if(call.result?.connection?.id)qa.owned.push(call.result.connection.id);
      publicWrite(provider+'-actual-tls-model.json',actual);assert(!actual.error,actual.error?.message);assert.equal(actual.result.status,'completed');assert(actual.result.text.includes(fixture.marker));assert(actual.result.text.includes('北京'));assert(actual.calls.some(call=>call.name==='sql_connection_connect'));assert(actual.calls.some(call=>call.name==='sql_objects_search'));assert(actual.calls.some(call=>call.name==='sql_query'));assert(actual.generations.some(g=>g.state==='settled'&&g.inputTokens>0));
      record('Real Agent connects and reads the '+provider+' private-CA database',{answer:actual.result.text,tools:actual.calls.map(call=>call.name)});
    }
  }else if(mode==='ui'||mode==='ui-resume'){
    await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
    if(mode==='ui'){
    await page.locator('.sidebar-new-chat').click();qa.uiId=(await state()).active;
    const assigned=await rpc('workspace_get',{conversationId:qa.uiId});await rpc('workspace_set',{conversationId:qa.uiId,directory:assigned.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:qa.uiId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
    const draft=JSON.parse(fs.readFileSync(path.join(root,'workspace/mysql-tls.json'),'utf8'));
    const fileName='geod-tls-native-'+randomUUID()+'.json',file=path.join(assigned.directory,fileName);
    assert(!fs.existsSync(file));const data=JSON.stringify({...draft,name:'TLS_UI_'+qa.uiId,user:'geod_client',sslRootCert:fs.readFileSync(path.join(root,'private/mysql/wrong-ca.pem'),'utf8')});fs.writeFileSync(file,data);
    qa.uiCredentialFile={file,sha256:createHash('sha256').update(data).digest('hex')};publicWrite('qa-state.json',qa);
    await page.locator('textarea').fill('实际证书连接验收。通过 sql_connection_connect 使用工作区相对连接配置 '+fileName+' 新建连接。如认证或证书失败，使用原生连接设置等待用户填写，不要复用已有连接、使用 shell 或在聊天询问密码和私钥。连接成功后通过 sql_query 查询 regions 的 marker。最终回复实际 MYSQL_TLS_ 开头的完整标记。');await page.locator('textarea').press('Enter');
    }
    const fixture=fixtures.mysql,privateRoot=path.join(root,'private/mysql');
    const dialog=page.locator('.sql-connection-dialog');await dialog.waitFor({timeout:180000});
    assert.equal(await dialog.locator('input[type=password]').inputValue(),'');
    await page.setViewportSize({width:1000,height:720});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});
    const caInput=dialog.locator('input[type=file]').nth(0);await caInput.setInputFiles(path.join(privateRoot,'ca.pem'));await dialog.getByRole('button',{name:'客户端证书 · 双向 TLS',exact:true}).click();
    await dialog.locator('input[type=file]').nth(1).setInputFiles(path.join(privateRoot,'client.pem'));await dialog.locator('input[type=file]').nth(2).setInputFiles(path.join(privateRoot,'client.key'));
    await dialog.locator('input[type=password]').fill(privateStates.mysql.readerPassword);
    await delay(400);await page.screenshot({path:path.join(root,'actual-mtls-auth-dark-zh.png')});
    const bounds=await dialog.boundingBox();assert(bounds&&bounds.width<=1000&&bounds.y>=0&&bounds.y+bounds.height<=721);
    assert(!(await dialog.innerText()).includes(fs.readFileSync(path.join(privateRoot,'client.key'),'utf8')));record('Real Agent opens native TLS correction; CA and client files fit the dark narrow window');
    await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});
    await dialog.getByRole('button',{name:'Test and save',exact:true}).waitFor();assert.equal(await dialog.locator('input[type=password]').inputValue(),privateStates.mysql.readerPassword);
    await page.screenshot({path:path.join(root,'actual-mtls-auth-light-en.png')});record('Actual English and light certificate form preserves the pending secret entry');
    await dialog.getByRole('button',{name:'Test and save',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});
    await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),fixture.marker,{timeout:180000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:30000});
    const chat=(await state()).chats.find(chat=>chat.conversationId===qa.uiId);publicWrite('actual-tls-ui-chat.json',chat);assert(chat.display.some(item=>item.toolName==='sql_query'));
    const owned=(await rpc('sql_connections_list')).connections.filter(c=>c.name==='TLS_UI_'+qa.uiId);assert.equal(owned.length,1);assert(owned[0].clientCertificate&&owned[0].customCa);qa.owned.push(owned[0].id);qa.uiConnectionId=owned[0].id;
    record('Actual AI resumes after native password and mTLS entry and reads the real database',{connection:owned[0]});
  }else{
    const ids=providers.map(provider=>({provider,id:qa[provider].mutualId||qa[provider].connectionId,table:fixtures[provider].table}));
    const prompt='只通过 sql_query 分别读取这些已保存的 TLS 数据库：'+JSON.stringify(ids)+ '，每个查询只 SELECT marker FROM 对应表。最终回复四个实际随机标记。不要连接新数据库、使用 shell 或需要用户输入。';
    const scheduled=await rpc('ai_schedules_create',{conversationId:qa.conversationId,name:'TLS saved connections closed-window QA',prompt,nextRunAt:new Date(Date.now()+18000).toISOString(),repeatSeconds:null,executionId:randomUUID()});qa.schedules.push(scheduled.scheduleId);qa.backgroundScheduleId=scheduled.scheduleId;publicWrite('qa-state.json',qa);
    await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState();});
    await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/@tauri-apps/api/window.js');await getCurrentWindow().close();}).catch(error=>{if(!/closed|destroyed/i.test(String(error)))throw error;});
    record('Saved TLS connections are queued for a real companion Agent after the window closes',{scheduleId:scheduled.scheduleId});
  }
  report.passed=true;
}catch(error){report.error={code:error?.code,message:error?.message||String(error)};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  qa.owned=[...new Set(qa.owned)];publicWrite('qa-state.json',qa);publicWrite(reportName,report);await browser.close();
}
