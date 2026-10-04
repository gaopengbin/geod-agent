/** Real desktop/native encrypted-key acceptance. Passwords stay in local RPC. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/database-keys'),mode=process.argv[2],provider=process.argv[3];
assert(['native','model','model-check','ui','ui-resume','ui-visual','background','background-retry','recovery','recovery-backup','restart','cleanup'].includes(mode));
const stateFile=path.join(root,'qa-state.json');let saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
const report={passed:false,cases:[],rendererErrors:[]},delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const secretValues=[];
for(const name of ['postgis','mysql','mariadb','oracle']){
 const file=path.join(root,'private',name,'state.json');if(fs.existsSync(file))for(const field of ['password','readerPassword','keyPassword']){const value=JSON.parse(fs.readFileSync(file,'utf8'))[field];if(value)secretValues.push(value);}
 const directory=path.join(root,'private',name);if(fs.existsSync(directory))for(const file of fs.readdirSync(directory)){if(file.endsWith('.key'))secretValues.push(fs.readFileSync(path.join(directory,file),'utf8'));}
}
const write=(file,value)=>{const text=JSON.stringify(value,null,2);assert(secretValues.every(secret=>!text.includes(secret)&&!text.includes(JSON.stringify(secret).slice(1,-1))),'Private password or key entered public evidence');fs.writeFileSync(path.join(root,file),text);};
const save=()=>write('qa-state.json',saved);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await delay(300);}
assert(page);await page.locator('.conversation-account-trigger').waitFor();
page.on('pageerror',e=>report.rendererErrors.push(e.message));page.on('console',message=>{if(message.type()==='error')report.rendererErrors.push(message.text())});
const rpc=async(command,args={})=>{const response=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(response.error)throw response.error;return response.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const select=async id=>{if((await state()).active!==id)await page.locator(`[data-conversation-id="${id}"]`).click();await page.locator('.geod-prompt-input textarea').waitFor();};
const language=async value=>page.evaluate(async language=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language});},value);
const theme=async value=>{if(await page.evaluate(()=>document.documentElement.dataset.theme)===value)return;await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:/^(深色外观|浅色外观|Dark appearance|Light appearance)$/,exact:true}).click();await delay(300);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),value);};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write((provider?provider+'-':'')+mode+'-result.json',report);console.log(JSON.stringify({name,passed:true}));};
const reject=async(command,args,code)=>{let error;try{await rpc(command,args)}catch(e){error=e}assert.equal(error?.code,code,error?.message);};
const listIds=async()=>([...(await rpc('data_connections_list')),...(await rpc('sql_connections_list')).connections]).map(value=>value.id).sort();
const publicConnections=async()=>{
 const spatial=await rpc('data_connections_list'),sql=(await rpc('sql_connections_list')).connections;
 const fixtures=['postgis','mysql','mariadb','oracle'].map(name=>JSON.parse(fs.readFileSync(path.join(root,name+'-ready.json'),'utf8')));
 return [...spatial,...sql].filter(c=>!saved.baselineConnectionIds.includes(c.id)).map(c=>{const fixture=fixtures.find(f=>c.port===f.port&&c.database===f.database);assert(fixture,'Unexpected new database connection');return {id:c.id,name:c.name,provider:fixture.provider};});
};
try{
 if(!saved){
  assert.equal(mode,'native');assert.equal((await rpc('background_status')).activeAiTurns,0);const original=await state();assert.equal(original.chats.length,30);write('original-conversations.json',original.chats);
  saved={userId:original.userId,originalActive:original.active,baselineChatIds:original.chats.map(c=>c.conversationId),baselineConnectionIds:await listIds(),originalDefault:(await rpc('ai_channels_list')).default,settings:await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})),qaConversationIds:[],connections:[]};save();
  await page.locator('.sidebar-new-chat').click();saved.conversationId=(await state()).active;assert(!saved.baselineChatIds.includes(saved.conversationId));saved.qaConversationIds.push(saved.conversationId);save();
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
 }else{assert(!saved.cleaned);await select(saved.conversationId);}
 if(!saved.credentialFolder){
  const workspace=await rpc('workspace_get',{conversationId:saved.conversationId});saved.workspace=workspace.directory;saved.credentialPrefix='.geod-key-qa-'+randomUUID();saved.credentialFolder=path.join(saved.workspace,saved.credentialPrefix);
  assert(!fs.existsSync(saved.credentialFolder));fs.mkdirSync(saved.credentialFolder);save();
 }
 for(const name of ['postgis','mysql','mariadb','oracle']){
  const fixture=path.join(root,name+'-ready.json');if(!fs.existsSync(fixture))continue;
  const relative=JSON.parse(fs.readFileSync(fixture,'utf8')).credentialFile;assert(path.basename(relative)===relative);fs.copyFileSync(path.join(root,'workspace',relative),path.join(saved.credentialFolder,relative));
 }
 if(mode==='native'){
  assert(['postgis','mysql','mariadb','oracle'].includes(provider));const fixture=JSON.parse(fs.readFileSync(path.join(root,provider+'-ready.json'),'utf8')),draft=JSON.parse(fs.readFileSync(path.join(root,'workspace',fixture.credentialFile),'utf8'));
  const command=provider==='postgis'?'data_connection_save':'sql_connection_save',args=value=>provider==='postgis'?{draft:value}:{conversationId:saved.conversationId,draft:value};
  const before=await listIds();await reject(command,args({...draft,sslClientKeyPassword:null}),'INPUT_TLS_KEY_PASSWORD_REQUIRED');await reject(command,args({...draft,sslClientKeyPassword:'INCORRECT_QA_VALUE'}),'INPUT_TLS_KEY_PASSWORD_INCORRECT');assert.deepEqual(await listIds(),before);
  pass('Actual '+provider+' missing/incorrect encrypted-key passwords leave no saved connection');
  const mismatch=JSON.parse(fs.readFileSync(path.join(root,'private/parser/inputs.json'),'utf8'))['ec-pkcs8'].certificate;
  await reject(command,args({...draft,sslClientCert:mismatch}),'INPUT_TLS_INVALID');assert.deepEqual(await listIds(),before);pass('Actual '+provider+' decrypted key/certificate mismatch is rejected before connection');
  const result=await rpc(command,args(draft));assert(result.connection&&!result.error,result.error?.message);const id=result.connection.id;assert(!saved.baselineConnectionIds.includes(id));saved.connections.push({id,provider,name:result.connection.name});save();
  const query=provider==='postgis'?await rpc('data_layer_inspect',{connectionId:id,layer:'public.regions.geom',limit:1,selection:{}}):await rpc('sql_query',{connectionId:id,sql:'SELECT marker FROM '+fixture.table});assert(JSON.stringify(query).includes(fixture.marker));
  write(provider+'-actual-encrypted-query.json',query);pass('Actual '+provider+' encrypted client key connects and reads the random database marker',{connectionId:id,keyFormat:fixture.keyFormat});
  const original=fs.readFileSync(path.join(root,'private',provider,'client.key'),'utf8'),plain=await rpc(command,args({...draft,sslClientKey:original,sslClientKeyPassword:null}));assert(plain.connection&&!plain.error,plain.error?.message);saved.connections.push({id:plain.connection.id,provider,name:plain.connection.name});save();
  const remove=provider==='postgis'?'data_connection_remove':'sql_connection_remove';for(const connection of saved.connections.filter(c=>c.provider===provider))await rpc(remove,{connectionId:connection.id});saved.connections=saved.connections.filter(c=>c.provider!==provider);save();assert.deepEqual(await listIds(),before);pass('Actual '+provider+' unencrypted-key compatibility and owned connection cleanup');
 }else if(mode==='model'||mode==='model-check'){
  const providers=['postgis','mysql','mariadb','oracle'],fixtures=providers.map(name=>JSON.parse(fs.readFileSync(path.join(root,name+'-ready.json'),'utf8')));
  const prompt='实际数据库连接验收：分别通过 data_connection_connect 或 sql_connection_connect 使用以下工作区连接配置文件：'+fixtures.map(f=>saved.credentialPrefix+'/'+f.credentialFile).join('、')+'。再用数据库工具分别读取 regions 表的 marker 字段，PostGIS 可用 data_layer_inspect；Oracle 的表为 GEOD_FIXTURE.REGIONS。最后只列四个实际数据库的完整随机标记。不要通过命令或文件工具读取连接配置，也不要展示任何密码、证书或私钥。';
  assert(fixtures.every(f=>!prompt.includes(f.marker)));if(mode==='model'){await page.locator('textarea').fill(prompt);await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>!!document.querySelector('.conversation-running-dot'),null,{timeout:30000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:300000});}
  else{assert.equal((await rpc('background_status')).activeAiTurns,0);}
  const chat=(await state()).chats.find(c=>c.conversationId===saved.conversationId),answer=chat.messages.filter(m=>m.role==='assistant').at(-1)?.content;
  saved.connections=await publicConnections();save();write('actual-model-chat.json',chat);
  for(const fixture of fixtures)assert(answer?.includes(fixture.marker),answer);assert.equal(saved.connections.length,4);assert(chat.display.filter(item=>['data_connection_connect','sql_connection_connect'].includes(item.toolName)).length>=4);
  await page.screenshot({path:path.join(root,'actual-model-answer.png')});pass('Real Codex/DeepSeek connects four encrypted-key databases and reads all four markers without receiving their private keys');
 }else if(mode==='ui'||mode==='ui-resume'||mode==='ui-visual'){
  assert(JSON.parse(fs.readFileSync(path.join(root,'model-check-result.json'),'utf8')).passed);assert.equal((await rpc('background_status')).activeAiTurns,0);
  const privateRoot=path.join(root,'private/postgis'),privateState=JSON.parse(fs.readFileSync(path.join(privateRoot,'state.json'),'utf8')),draft=JSON.parse(fs.readFileSync(path.join(root,'workspace/postgis-encrypted.json'),'utf8'));
  if(mode==='ui'){
  const missing={...draft,name:'PostGIS UI key acceptance',sslClientKeyPassword:null};fs.writeFileSync(path.join(saved.credentialFolder,'postgis-missing-key-password.json'),JSON.stringify(missing));saved.missingCredentialFile=saved.credentialPrefix+'/postgis-missing-key-password.json';save();
  await language('zh-CN');await theme('dark');await page.setViewportSize({width:1000,height:720});
  const prompt='本机密码交互验收：明确调用 data_connection_connect，用配置 '+saved.missingCredentialFile+' 新建连接，不复用已有连接。需要本机认证时等我填写，然后用 data_layer_inspect 读取 regions 的实际 marker 字段。不要运行命令或使用文件读取工具，不要展示认证内容。';
  await page.locator('textarea').fill(prompt);await page.locator('textarea').press('Enter');const dialog=page.locator('.data-input-dialog');await dialog.getByRole('heading',{name:'数据库认证',exact:true}).waitFor({timeout:90000});
  await dialog.locator('.data-input-client-tls input[type=file][accept=".pem,.crt,.cer"]').setInputFiles(path.join(privateRoot,'client.pem'));
  await dialog.locator('.data-input-client-tls input[type=file][accept=".pem,.key"]').setInputFiles(path.join(privateRoot,'client-encrypted.key'));
  const input=dialog.getByLabel('客户端私钥密码',{exact:true});await input.fill('INCORRECT_QA_VALUE');await dialog.getByRole('button',{name:'连接并继续',exact:true}).click();
  await dialog.getByText('客户端私钥密码不正确，请重试',{exact:true}).waitFor({timeout:30000});assert.equal(await input.inputValue(),'');assert(await input.evaluate(el=>el===document.activeElement));
  const layout=await dialog.evaluate(el=>({width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth}));assert(layout.width<=522&&!layout.overflow);
  await page.screenshot({path:path.join(root,'actual-key-retry-dark-zh.png')});pass('Actual Agent authentication shows an encrypted-key password field and clears/refocuses an incorrect password',{layout});
  await input.fill(privateState.keyPassword);await dialog.getByRole('button',{name:'连接并继续',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:180000});
  const chat=(await state()).chats.find(c=>c.conversationId===saved.conversationId),answer=chat.messages.filter(m=>m.role==='assistant').at(-1)?.content;assert(answer?.includes(privateState.marker),answer);write('actual-ui-model-chat.json',chat);saved.uiConnectionIds=(await publicConnections()).filter(c=>!saved.connections.some(previous=>previous.id===c.id)).map(c=>c.id);assert.equal(saved.uiConnectionIds.length,1);save();
  pass('The real Agent resumes after local password entry and reads the actual PostGIS marker',{actualAnswer:answer});
  }else{assert.equal(saved.uiConnectionIds.length,1);assert(fs.existsSync(path.join(root,'actual-ui-model-chat.json')));if(mode==='ui-resume'){report.cases=JSON.parse(fs.readFileSync(path.join(root,'ui-result.json'),'utf8')).cases;assert.equal(report.cases.length,2);}}
  // English/light uses the same actual settings form without sending another paid turn.
  await language('en');await theme('light');if(!await page.getByText('Add data boundary',{exact:true}).count())await page.getByRole('button',{name:'Add to prompt',exact:true}).click();await page.getByText('Add data boundary',{exact:true}).click();
  await page.locator('.data-input-tabs').getByRole('button',{name:'Database',exact:true}).click();await page.getByRole('button',{name:'Add PostgreSQL / PostGIS',exact:true}).click();
  const settings=page.locator('.data-input-dialog');await settings.getByRole('button',{name:'Client certificate · mutual TLS',exact:true}).click();
  await settings.locator('.data-input-client-tls input[type=file][accept=".pem,.crt,.cer"]').setInputFiles(path.join(privateRoot,'client.pem'));await settings.locator('.data-input-client-tls input[type=file][accept=".pem,.key"]').setInputFiles(path.join(privateRoot,'client-encrypted.key'));
  await settings.getByLabel('Client private key password',{exact:true}).waitFor();assert.equal(await settings.getByLabel('Client private key password',{exact:true}).getAttribute('type'),'password');assert(!/[\u3400-\u9fff]/u.test(await settings.locator('.data-input-ssl').innerText()));await settings.getByLabel('Client private key password',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'actual-key-settings-light-en.png')});
  await settings.getByRole('button',{name:'Remove client private key',exact:true}).click();assert.equal(await settings.getByLabel('Client private key password',{exact:true}).count(),0);await settings.getByRole('button',{name:'Close data input',exact:true}).click();
  await language('zh-CN');await theme('dark');await page.setViewportSize({width:1440,height:900});pass('Actual English/light settings read the encrypted file locally and hide the password field when the key is removed');
 }else if(mode==='background'){
  for(const stage of ['model-check','ui-resume','ui-visual'])assert(JSON.parse(fs.readFileSync(path.join(root,stage+'-result.json'),'utf8')).passed);
  assert.equal((await rpc('background_status')).activeAiTurns,0);assert(!saved.scheduleIds?.length,'Preserve existing background acceptance runs');
  const fixtures=['postgis','mysql','mariadb','oracle'].map(name=>JSON.parse(fs.readFileSync(path.join(root,name+'-ready.json'),'utf8')));
  const connections=saved.connections.map(c=>({...c,table:fixtures.find(f=>f.provider===c.provider).table}));
  const prompt='实际后台数据库读取验收：只使用 data_layer_inspect（PostGIS 的 public.regions.geom）和 sql_query（其他库 SELECT marker FROM 指定表）读取这些已经保存的连接 '+JSON.stringify(connections)+'。最后只列各数据库的实际完整随机标记。不连接新数据库，不读取文件，不运行命令。';
  assert(fixtures.every(f=>!prompt.includes(f.marker)));saved.scheduleIds=[];
  const read=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Encrypted database keys closed-window read',prompt,nextRunAt:new Date(Date.now()+18000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.readScheduleId=read.scheduleId;saved.scheduleIds.push(read.scheduleId);save();
  const missingPrompt='实际本机认证后台验收：明确调用 data_connection_connect，使用配置 '+saved.missingCredentialFile+' 新建连接，不复用已有连接。遇到 USER_INPUT_REQUIRED 或缺少私钥密码时停止并告知需要本机输入，不要查询或读取文件，不要运行命令。';
  const missing=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Encrypted key requires local input',prompt:missingPrompt,nextRunAt:new Date(Date.now()+22000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.missingScheduleId=missing.scheduleId;saved.scheduleIds.push(missing.scheduleId);save();
  await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState()});
  await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close()}).catch(e=>{if(!e.message.includes('closed'))throw e});
  pass('The actual desktop closes before saved encrypted-key reads and a missing-password challenge run in the companion');
 }else if(mode==='background-retry'){
  assert.equal((await rpc('background_status')).activeAiTurns,0);assert(saved.scheduleIds.length===2);assert(fs.existsSync(path.join(root,'background-structured-input-state-failure.json')));
  for(const scheduleId of saved.scheduleIds)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false});
  const previous=(await rpc('ai_schedules_list',{conversationId:saved.conversationId})).schedules.find(s=>s.scheduleId===saved.missingScheduleId);assert(previous?.prompt);
  saved.previousMissingScheduleId=saved.missingScheduleId;
  const missing=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Encrypted key required input corrected state',prompt:previous.prompt,nextRunAt:new Date(Date.now()+14000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.missingScheduleId=missing.scheduleId;saved.scheduleIds.push(missing.scheduleId);save();
  await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState()});
  await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close()}).catch(e=>{if(!e.message.includes('closed'))throw e});
  pass('A fresh actual closed-window missing-key-password run checks the corrected scheduler state; the prior failure stays preserved');
 }else if(mode==='recovery'||mode==='recovery-backup'){
  assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);assert.equal((await rpc('background_status')).activeAiTurns,0);
  for(const scheduleId of saved.scheduleIds)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false});
  if(mode==='recovery'){
  assert(!saved.forkId,'Preserve the existing native fork');saved.forkId=randomUUID();save();
  const workspace=await rpc('workspace_get',{conversationId:saved.conversationId});await rpc('workspace_set',{conversationId:saved.forkId,directory:workspace.directory,permission:workspace.permission});
  const fork=await rpc('codex_fork',{sourceConversationId:saved.conversationId,conversationId:saved.forkId,imageIds:[],documentIds:[]});assert(fork.threadId&&fork.sourceThreadId&&fork.threadId!==fork.sourceThreadId);saved.fork=fork;save();
  write('actual-native-fork.json',fork);write('before-restart-ui-chat.json',(await state()).chats.find(c=>c.conversationId===saved.conversationId));
  pass('The actual native conversation fork preserves the genuine model and database-tool history',{fork});
  }else{assert(saved.fork?.threadId&&saved.fork.threadId!==saved.fork.sourceThreadId);}
  const uiState=await page.evaluate(async()=>{const {snapshotLocalRecords,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();return snapshotLocalRecords()});saved.backup=await rpc('desktop_backup_create',{uiState});save();
  const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8')),sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for(const record of manifest.records)assert.equal(sha(path.join(saved.backup.path,record.file)),record.sha256);
  assert.equal(sha(path.join(saved.backup.path,manifest.uiState.file)),manifest.uiState.sha256);
  const tls=manifest.records.filter(r=>(r.path.startsWith('data-inputs/')||r.path.startsWith('sql-inputs/'))&&r.path.endsWith('.client-tls'));
  for(const id of [...saved.connections.map(c=>c.id),...saved.uiConnectionIds]){const record=tls.find(r=>r.path.endsWith('/'+id+'.client-tls'));assert(record,'Owned protected client identity is absent from the backup');assert.equal(sha(path.join(process.env.APPDATA,'dev.geod-agent.desktop',record.path)),record.sha256);}
  const history=manifest.records.filter(r=>r.path.startsWith('codex-runtime/')&&r.path.endsWith('.jsonl'));assert(history.length);
  pass('Complete native backup verifies every SHA and retains system-protected client keys, original conversations and real engine history',{backup:saved.backup,records:manifest.records.length,protectedTlsRecords:tls.length});
 }else if(mode==='restart'){
  const schedules=(await rpc('ai_schedules_list',{conversationId:saved.conversationId})).schedules;
  for(const id of saved.scheduleIds)assert.equal(schedules.find(s=>s.scheduleId===id)?.enabled,false);
  for(const connection of saved.connections){
   const fixture=JSON.parse(fs.readFileSync(path.join(root,connection.provider+'-ready.json'),'utf8'));
   let value;
   if(connection.provider==='postgis'){
    const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8')),record=manifest.records.find(r=>r.path.startsWith('data-inputs/')&&r.path.endsWith('/'+connection.id+'.client-tls'));assert(record);assert(/^[a-f0-9-]{36}$/u.test(connection.id));
    const file=path.join(process.env.APPDATA,'dev.geod-agent.desktop',record.path),source=path.join(saved.backup.path,record.file),held=file+'.qa-before-restore-'+randomUUID();assert(!fs.existsSync(held));
    const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');assert.equal(sha(file),record.sha256);assert.equal(sha(source),record.sha256);
    fs.renameSync(file,held);
    try{fs.copyFileSync(source,file);value=await rpc('data_layer_inspect',{connectionId:connection.id,layer:'public.regions.geom',limit:1,selection:{}});assert(JSON.stringify(value).includes(fixture.marker));}
    finally{if(fs.existsSync(file))fs.unlinkSync(file);fs.renameSync(held,file);}
    assert.equal(sha(file),record.sha256);pass('After complete process restart, an actual client-key blob copied from the complete backup authenticates to PostGIS; the original file is restored byte for byte');
   }else{value=await rpc('sql_query',{connectionId:connection.id,sql:'SELECT marker FROM '+fixture.table});}
   assert(JSON.stringify(value).includes(fixture.marker));write(connection.provider+'-actual-restart-query.json',value);
  }
  assert.deepEqual((await state()).chats.find(c=>c.conversationId===saved.conversationId),JSON.parse(fs.readFileSync(path.join(root,'before-restart-ui-chat.json'),'utf8')));
  pass('Full native desktop/companion restart rereads all four system-protected encrypted-key connections without another password',{actualQueries:4});
 }else{
  assert(JSON.parse(fs.readFileSync(path.join(root,'restart-result.json'),'utf8')).passed);assert.equal((await rpc('background_status')).activeAiTurns,0);
  for(const scheduleId of saved.scheduleIds)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false});
  const owned=[...saved.connections,...saved.uiConnectionIds.map(id=>({id,provider:'postgis'}))];assert.equal(new Set(owned.map(c=>c.id)).size,5);
  for(const c of owned){assert(!saved.baselineConnectionIds.includes(c.id));await rpc(c.provider==='postgis'?'data_connection_remove':'sql_connection_remove',{connectionId:c.id});}assert.deepEqual(await listIds(),saved.baselineConnectionIds);
  await rpc('ai_model_select',{conversationId:'default',...saved.originalDefault});write('actual-owned-ui-conversations.json',(await state()).chats.filter(c=>saved.qaConversationIds.includes(c.conversationId)));
  await theme(saved.settings.theme);await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId),owned=new Set(saved.qaConversationIds);if(saved.qaConversationIds.some(id=>saved.baselineChatIds.includes(id)))throw new Error('Refusing to remove original chats');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(c=>!owned.has(c.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);if(saved.settings.language)setLanguagePreferences(JSON.parse(saved.settings.language));await flushLocalState();},saved);
  await page.setViewportSize({width:saved.settings.width,height:saved.settings.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  const restored=await state(),original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8'));assert.equal(restored.chats.length,30);assert.equal(restored.active,saved.originalActive);const map=new Map(restored.chats.map(c=>[c.conversationId,c]));for(const c of original)assert.deepEqual(map.get(c.conversationId),c);assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);
  saved.cleaned=true;save();pass('Only the five owned database connections and one owned sidebar chat are removed; all thirty original chats and four original connection IDs remain exact');
 }
 assert.equal(report.rendererErrors.length,0,report.rendererErrors.join('\n'));report.passed=true;write((provider?provider+'-':'')+mode+'-result.json',report);
}catch(e){report.error={code:e.code,message:e.message||JSON.stringify(e),stack:e.stack};write((provider?provider+'-':'')+mode+'-result.json',report);console.error(JSON.stringify(report.error));await page.screenshot({path:path.join(root,(provider?provider+'-':'')+mode+'-failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser.close().catch(()=>{})}
