/** Real packaged WebView, native tools and model; no source imports or UI mocks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output=path.resolve(process.argv[2]),mode=process.argv[3];
assert(output.startsWith(path.resolve('artifacts')+path.sep));
assert(['init','inputs','model','model-check','backup','background','restart','cleanup','stop'].includes(mode));
const root=path.resolve('artifacts/product-gaps-20261004/integrated-release'),workspace=path.join(root,'workspace');
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'fixtures.json'),'utf8'));
const postgis=JSON.parse(fs.readFileSync(path.join(root,'postgis-ready.json'),'utf8'));
const privateState=JSON.parse(fs.readFileSync(path.join(root,'private/postgis/state.json'),'utf8'));
const passwords=JSON.parse(fs.readFileSync(path.join(root,'private/document-passwords.json'),'utf8'));
const privateValues=[...Object.values(passwords),...['password','readerPassword','keyPassword'].map(k=>privateState[k]).filter(Boolean),
 ...fs.readdirSync(path.join(root,'private/postgis')).filter(f=>f.endsWith('.key')).map(f=>fs.readFileSync(path.join(root,'private/postgis',f),'utf8'))];
const safe=value=>privateValues.every(secret=>!value.includes(secret)&&!value.includes(JSON.stringify(secret).slice(1,-1)));
const write=(name,value)=>{const text=JSON.stringify(value,null,2);assert(safe(text),'Private fixture material must never enter public evidence');fs.writeFileSync(path.join(output,name),text);};
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stateFile=path.join(output,'integrated-qa-state.json');let saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
const save=()=>write('integrated-qa-state.json',saved);
const previousReport=path.join(output,'integrated-'+mode+'.json');
const resumedReport=mode==='inputs'&&fs.existsSync(previousReport)?JSON.parse(fs.readFileSync(previousReport,'utf8')):null;
if(resumedReport&&!resumedReport.passed)fs.copyFileSync(previousReport,path.join(output,'integrated-inputs-harness-picker-failure.json'));
const report={passed:false,cases:resumedReport?.cases??[],rendererErrors:[],installed:false,published:false,cleanWindowsVerified:false};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write('integrated-'+mode+'.json',report);console.log(JSON.stringify({name,passed:true}));};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9234');
let page;
for(let n=0;n<100&&!page;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));if(!page)await delay(200);}
assert(page);await page.locator('.conversation-account-trigger').waitFor({timeout:30000});
page.on('pageerror',e=>report.rendererErrors.push(e.message));
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(value.error)throw value.error;return value.value;};
const records=()=>page.evaluate(async()=>{await window.__GEOD_LOCAL_STATE__?.flush();return new Promise((resolve,reject)=>{const opened=indexedDB.open('geod-ui-state-v1',1);opened.onerror=()=>reject(opened.error);opened.onsuccess=()=>{const db=opened.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();const combined=new Map(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]));keys.result.forEach((key,i)=>combined.set(String(key),values.result[i]));resolve([...combined]);};tx.onabort=()=>{db.close();reject(tx.error)};};});});
const chats=async()=>Object.fromEntries(await records());
const chatState=async()=>{const all=await chats(),key=Object.keys(all).find(k=>k.startsWith('geod-agent-conversations-0.1:account:'));return{active:all['geod-agent-active-conversation-0.1:account:'+key?.split(':account:')[1]],chats:key?JSON.parse(all[key]):[]};};
const actualChat=async()=>(await chatState()).chats.find(c=>c.conversationId===saved.conversationId);
const allConnections=async()=>[...(await rpc('data_connections_list')),...(await rpc('sql_connections_list')).connections];
const reject=async(command,args,code)=>{let error;try{await rpc(command,args)}catch(value){error=value}assert.equal(error?.code,code,error?.message);};
const picker=()=>page.locator('input[type=file][accept*=docx]');
const chip=name=>page.locator('.composer-documents .chat-document-chip').filter({hasText:name});
const documents=async()=>{const values=[];for(const node of await page.locator('.composer-documents .chat-document-chip').all()){const id=await node.getAttribute('data-attachment-id');values.push({id,text:await node.innerText()});}return values;};
try{
 if(mode==='init'){
  assert(!saved,'Do not replace an existing isolated acceptance');assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-payload.json'),'utf8')).passed);
  assert.equal((await rpc('desktop_settings_get')).development,false);const version=await rpc('plugin:app|version');assert.equal(version,'0.2.0');assert.equal((await rpc('auth_status')).state,'connected');
  assert.equal((await allConnections()).length,0);
  const previousInit=path.join(output,'integrated-init.json'),resuming=fs.existsSync(previousInit)&&!JSON.parse(fs.readFileSync(previousInit,'utf8')).passed;
  const initialChats=(await chatState()).chats;assert(initialChats.length<=(resuming?2:1)&&initialChats.every(chat=>chat.messages.length===0));
  if(resuming)fs.copyFileSync(previousInit,path.join(output,'integrated-init-harness-snapshot-failure.json'));
  await page.evaluate(()=>localStorage.setItem('geod-agent-language-v1',JSON.stringify({language:'en',replyLanguage:'auto'})));await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');if(!resuming)await page.locator('.sidebar-new-chat').click();await page.locator('.geod-prompt-input textarea').waitFor();
  let state;const stateDeadline=Date.now()+15000;while(Date.now()<stateDeadline){state=await chatState();if(state.active&&state.chats.some(chat=>chat.conversationId===state.active))break;await delay(150);}
  assert(state.active&&state.chats.some(chat=>chat.conversationId===state.active),'A real sidebar action must commit the QA conversation');
  saved={conversationId:state.active,connections:[],documents:[],version};save();
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});
  const bound=await rpc('workspace_get',{conversationId:saved.conversationId});await rpc('workspace_set',{conversationId:saved.conversationId,directory:bound.directory,permission:'fullAccess'});
  saved.workspace=bound.directory;saved.credentialPrefix='.geod-release-qa-'+randomUUID();saved.credentialFolder=path.join(bound.directory,saved.credentialPrefix);assert(!fs.existsSync(saved.credentialFolder));fs.mkdirSync(saved.credentialFolder);save();
  for(const name of ['postgis-encrypted.json','release.sqlite'])fs.copyFileSync(path.join(workspace,name),path.join(saved.credentialFolder,name));
  saved.workspaceFiles=['postgis-encrypted.json','release.sqlite'].map(name=>({name,sha256:sha(path.join(saved.credentialFolder,name))}));save();
  pass('Actual portable release has fresh application profiles, English UI and a genuine workspace',{version,development:false});
  const draft=JSON.parse(fs.readFileSync(path.join(workspace,'postgis-encrypted.json'),'utf8'));
  await reject('data_connection_save',{draft:{...draft,sslClientKeyPassword:null}},'INPUT_TLS_KEY_PASSWORD_REQUIRED');
  await reject('data_connection_save',{draft:{...draft,sslClientKeyPassword:'INCORRECT_QA_VALUE'}},'INPUT_TLS_KEY_PASSWORD_INCORRECT');assert.equal((await allConnections()).length,0);
  pass('Packaged Python and cryptography reject missing and incorrect encrypted client-key passwords without saving a connection');
  const connected=await rpc('data_connection_save',{draft});assert(connected.connection&&!connected.error);saved.connections.push({id:connected.connection.id,kind:'postgis',name:connected.connection.name,native:true});save();
  const query=await rpc('data_layer_inspect',{connectionId:connected.connection.id,layer:'public.regions.geom',limit:1,selection:{}});assert(JSON.stringify(query).includes(postgis.marker));write('integrated-native-postgis-query.json',query);
  pass('Packaged pgEdge and encrypted client key authenticate to actual PostGIS and read its random marker',{connectionId:connected.connection.id});
  const sqlite=await rpc('sql_connection_connect',{conversationId:saved.conversationId,request:{kind:'sqlite',name:'Integrated release SQLite',relativePath:saved.credentialPrefix+'/release.sqlite'}});assert(sqlite.connection&&!sqlite.error);saved.connections.push({id:sqlite.connection.id,kind:'sqlite',name:sqlite.connection.name});save();
  const sqliteQuery=await rpc('sql_query',{connectionId:sqlite.connection.id,sql:'SELECT marker FROM release_markers'});assert(JSON.stringify(sqliteQuery).includes(fixtures.markers.sqlite));write('integrated-native-sqlite-query.json',sqliteQuery);
  pass('Packaged DBHub and bundled Node read an actual SQLite database',{connectionId:sqlite.connection.id,mcp:sqlite.mcp});
 }else{
  if(mode!=='stop'){assert(saved&&!saved.cleaned);const state=await chatState();if(state.active!==saved.conversationId)await page.locator(`[data-conversation-id="${saved.conversationId}"]`).click();}
  if(mode==='inputs'){
   for(const name of fixtures.inputs){
    if(await chip(name).count())continue;
    assert.equal(sha(path.join(workspace,name)),fixtures.files[name].sha256);
    if(name.endsWith('.mp3')){
     const initial=await rpc('audio_settings_get');if(!saved.audioInitial){saved.audioInitial=initial;save();assert(initial.models.every(model=>!model.available),'The isolated profile must not inherit development audio models');}
     await page.locator('input[type=file][accept*=mp3]').setInputFiles(path.join(workspace,name));const setup=page.locator('.audio-setup-dialog');await setup.waitFor({timeout:30000});
     await page.screenshot({path:path.join(output,'integrated-audio-first-use.png')});
     await setup.getByRole('combobox',{name:'Speech model'}).click();await page.getByRole('option',{name:/Standard model/}).click();await setup.getByRole('button',{name:'Download model',exact:true}).click();
     await setup.getByRole('button',{name:'Save and continue',exact:true}).waitFor({timeout:900000});await setup.getByRole('button',{name:'Save and continue',exact:true}).click();await setup.waitFor({state:'hidden'});
     await chip(name).waitFor({timeout:120000});const id=await chip(name).getAttribute('data-attachment-id');const draft=await rpc('audio_attachment_draft',{conversationId:saved.conversationId,id});assert(/Beijing/i.test(draft.text)&&draft.text.includes('12'));assert.equal(draft.attachment.sha256,fixtures.files[name].sha256);
     write('integrated-actual-audio-transcript.json',draft);pass('Fresh packaged audio setup downloads its optional model and really transcribes the authored MP3',{actualTranscript:draft.text,audioUploadedToServer:false});
     await chip(name).getByRole('button',{name:/Review transcript/}).click();const editor=page.locator('.audio-transcript-dialog');await editor.locator('textarea:not([disabled])').waitFor();
     const edited=draft.text+'\nUser correction marker: '+fixtures.markers.audio;await editor.locator('textarea').fill(edited);await editor.getByRole('button',{name:'Save transcript',exact:true}).click();await editor.waitFor({state:'hidden'});
     assert.equal((await rpc('audio_attachment_draft',{conversationId:saved.conversationId,id})).text,edited);pass('Actual packaged transcript editor preserves audio bytes and records an explicit user correction',{markerIsUserCorrection:true});
    }else{
     await picker().setInputFiles(path.join(workspace,name));
     if(passwords[name]){
      const input=page.locator('#document-password');await input.waitFor({timeout:60000});assert.equal(await input.getAttribute('type'),'password');assert(await input.evaluate(el=>el===document.activeElement));
      if(name.endsWith('.pdf')){await input.fill('INCORRECT_QA_VALUE');await input.press('Enter');await page.getByRole('alert').filter({hasText:'Incorrect document password'}).waitFor({timeout:60000});assert.equal(await input.inputValue(),'');assert(await input.evaluate(el=>el===document.activeElement));await page.screenshot({path:path.join(output,'integrated-password-retry.png')});}
      await input.fill(passwords[name]);await input.press('Enter');
     }
     await chip(name).waitFor({timeout:120000});
    }
    saved.documents=await documents();save();pass('Actual packaged file picker imports '+name,{sha256:fixtures.files[name].sha256});
   }
   const chips=await documents();assert.equal(chips.length,7);assert(chips.every(value=>value.id));saved.documents=fixtures.inputs.map(name=>{const value=chips.find(value=>value.text.includes(name));assert(value);return{name,id:value.id,sha256:fixtures.files[name].sha256}});save();
   assert.equal((await rpc('document_attachments_list',{conversationId:saved.conversationId})).length,0);await page.screenshot({path:path.join(output,'integrated-seven-inputs.png')});
   pass('All seven real file types fit the packaged composer as unpublished attachments');
  }else if(mode==='model'||mode==='model-check'){
   assert.equal(saved.documents.length,7);const sqlite=saved.connections.find(value=>value.kind==='sqlite');assert(sqlite);
   const prompt='实际发行候选验收：请逐个用 attachment_read 读取本轮全部七个附件的正文，读取扫描件、旧 Office 和音频的实际文本，有 nextOffset 就继续。然后调用 data_connection_connect，用工作区配置 '+saved.credentialPrefix+'/postgis-encrypted.json 新建 PostGIS 连接，不复用已有连接；用 data_layer_inspect 读 public.regions.geom 的 marker。用 sql_query 读取 SQLite 连接 '+sqlite.id+' 的 release_markers.marker。最后只列实际文件名/数据库名和全部完整随机标记，标记以 PACKDATA、OFFICEDATA、MAPDATA 或 POSTGIS_KEY_ 开头。不要使用命令或文件工具，也不要展示认证内容。';
   assert([...Object.values(fixtures.markers),postgis.marker].every(marker=>!prompt.includes(marker)));
   if(mode==='model'){
    assert(!saved.modelSubmitted,'Inspect an existing submitted real request rather than paying to retry');saved.modelSubmitted=true;save();await page.locator('.geod-prompt-input textarea').fill(prompt);await page.locator('.geod-prompt-input textarea').press('Enter');
    await page.waitForFunction(()=>!!document.querySelector('.conversation-running-dot'),null,{timeout:30000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:420000});
   }else assert.equal((await rpc('background_status')).activeAiTurns,0);
   const chat=await actualChat();write('integrated-actual-model-chat.json',chat);const answer=chat.messages.filter(message=>message.role==='assistant').at(-1)?.content;
   for(const marker of [...Object.values(fixtures.markers),postgis.marker])assert(answer?.includes(marker),'Actual marker is absent: '+marker);
   assert(chat.display.filter(item=>item.toolName==='attachment_read').length>=7);assert(chat.display.some(item=>item.toolName==='data_connection_connect'));assert(chat.display.some(item=>item.toolName==='sql_query'));
   const connections=await allConnections();assert.equal(connections.length,3);const modelConnection=connections.find(value=>!saved.connections.some(old=>old.id===value.id));assert(modelConnection?.port===postgis.port);saved.connections.push({id:modelConnection.id,kind:'postgis',name:modelConnection.name,native:false});save();
   const files=await rpc('document_attachments_list',{conversationId:saved.conversationId});assert.equal(files.length,7);
   for(const file of saved.documents){const content=await rpc('document_attachment_read',{conversationId:saved.conversationId,id:file.id});assert(content.complete);assert.equal(content.attachment.sha256,file.sha256);file.textSha256=content.attachment.textSha256;}save();
   await page.screenshot({path:path.join(output,'integrated-actual-model-answer.png')});
   pass('Genuine packaged Codex/DeepSeek reads seven attachments and connects/queries two databases through actual native tools',{actualAnswer:answer,attachmentToolCalls:chat.display.filter(item=>item.toolName==='attachment_read').length});
  }else if(mode==='backup'){
   assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-model'+(fs.existsSync(path.join(output,'integrated-model-check.json'))?'-check':'')+'.json'),'utf8')).passed);
   const uiState={schemaVersion:1,entries:(await records()).filter(([key])=>key.startsWith('geod'))};saved.backup=await rpc('desktop_backup_create',{uiState});save();
   const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8'));for(const record of manifest.records)assert.equal(sha(path.join(saved.backup.path,record.file)),record.sha256);assert.equal(sha(path.join(saved.backup.path,manifest.uiState.file)),manifest.uiState.sha256);
   for(const file of saved.documents){for(const [suffix,digest]of [['attachment',file.sha256],['text',file.textSha256]]){const record=manifest.records.find(record=>record.path.startsWith('chat-attachments/')&&record.path.endsWith('/'+file.id+'.'+suffix));assert(record);assert.equal(record.sha256,digest);}}
   for(const connection of saved.connections.filter(connection=>connection.kind==='postgis'))assert(manifest.records.some(record=>record.path.startsWith('data-inputs/')&&record.path.endsWith('/'+connection.id+'.client-tls')));
   write('integrated-before-restart-chat.json',await actualChat());pass('Actual packaged complete backup retains all seven original inputs/texts and system-protected database keys, with every SHA verified',{backup:saved.backup,records:manifest.records.length});
  }else if(mode==='background'){
   assert(!saved.scheduleId);assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-backup.json'),'utf8')).passed);const ids=saved.documents.map(file=>({id:file.id,name:file.name}));const connections=saved.connections.filter(value=>value.kind==='sqlite'||!value.native).map(value=>({id:value.id,kind:value.kind}));
   const prompt='实际发行后台验收：用 attachment_read 读这些已保存附件 '+JSON.stringify(ids)+'；用 data_layer_inspect（PostGIS 的 public.regions.geom）和 sql_query（SQLite 的 SELECT marker FROM release_markers）读这些已保存连接 '+JSON.stringify(connections)+'。最后只列实际文本中的全部完整随机标记，包括音频里用户编辑的标记。不连接新数据库，不运行命令，不读取文件。';
   assert([...Object.values(fixtures.markers),postgis.marker].every(marker=>!prompt.includes(marker)));
   const schedule=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Actual packaged attachments and encrypted databases',prompt,nextRunAt:new Date(Date.now()+14000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;save();await records();
   await rpc('plugin:window|close').catch(e=>{if(!String(e).includes('closed'))throw e});pass('The real packaged window closes before the companion reads saved inputs and databases',{scheduleId:saved.scheduleId});
  }else if(mode==='restart'){
   assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-headless.json'),'utf8')).passed);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});
   for(const file of saved.documents){const content=await rpc('document_attachment_read',{conversationId:saved.conversationId,id:file.id});assert(content.complete);assert.equal(content.attachment.sha256,file.sha256);assert.equal(content.attachment.textSha256,file.textSha256);}
   for(const connection of saved.connections){const query=connection.kind==='sqlite'?await rpc('sql_query',{connectionId:connection.id,sql:'SELECT marker FROM release_markers'}):await rpc('data_layer_inspect',{connectionId:connection.id,layer:'public.regions.geom',limit:1,selection:{}});assert(JSON.stringify(query).includes(connection.kind==='sqlite'?fixtures.markers.sqlite:postgis.marker));}
   assert.deepEqual(await actualChat(),JSON.parse(fs.readFileSync(path.join(output,'integrated-before-restart-chat.json'),'utf8')));pass('Complete packaged foreground/companion restart preserves exact chat, all seven inputs and three authenticated database connections');
  }else if(mode==='cleanup'){
   assert(JSON.parse(fs.readFileSync(path.join(output,'integrated-restart.json'),'utf8')).passed);assert.equal((await rpc('background_status')).activeAiTurns,0);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});
   for(const connection of saved.connections)await rpc(connection.kind==='postgis'?'data_connection_remove':'sql_connection_remove',{connectionId:connection.id});assert.equal((await allConnections()).length,0);saved.cleaned=true;save();
   pass('Only this isolated acceptance\u2019s three connections are removed and its own schedule is disabled');
  }else if(mode==='stop'){
   const status=await rpc('background_status');assert.equal(status.activeAiTurns,0);assert.equal(status.activeDownloads,0);assert.equal(status.activeCommands,0);await records();assert.equal((await rpc('background_stop')).stopped,true);await rpc('plugin:window|close').catch(e=>{if(!String(e).includes('closed'))throw e});pass('Actual candidate window and companion are requested to stop normally');
  }
 }
 assert.equal(report.rendererErrors.length,0,report.rendererErrors.join('\n'));report.passed=true;write('integrated-'+mode+'.json',report);
}catch(error){
 const message=error.message??JSON.stringify(error);report.error={code:error.code,message:safe(message)?message:'Private fixture diagnostics withheld'};write('integrated-'+mode+'.json',report);console.error(JSON.stringify(report.error));await page.screenshot({path:path.join(output,'integrated-'+mode+'-failure.png')}).catch(()=>{});process.exitCode=1;
}finally{await browser.close().catch(()=>{})}
