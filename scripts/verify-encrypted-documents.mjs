/** Real desktop password entry, native storage, model reading and restart. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/encrypted-documents'),mode=process.argv[2];
assert(['native','model','background','recovery','visual','restart','cleanup'].includes(mode));
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'fixtures.json'),'utf8'));
const passwords=fs.existsSync(path.join(root,'private-passwords.json'))?JSON.parse(fs.readFileSync(path.join(root,'private-passwords.json'),'utf8')):{};
let saved=fs.existsSync(path.join(root,'qa-state.json'))?JSON.parse(fs.readFileSync(path.join(root,'qa-state.json'),'utf8')):null;
const report={passed:false,cases:[],rendererErrors:[]};
if(mode==='native'&&fs.existsSync(path.join(root,'native-result.json')))report.cases=JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).cases??[];
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2));
const save=()=>write('qa-state.json',saved),delay=ms=>new Promise(r=>setTimeout(r,ms));
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write(mode+'-result.json',report);console.log(JSON.stringify({name,passed:true}));};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await delay(300);}assert(page);
await page.locator('.conversation-account-trigger').waitFor();
page.on('pageerror',e=>report.rendererErrors.push(e.message));
page.on('console',message=>{if(message.type()==='error')report.rendererErrors.push(message.text())});
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw r.error;return r.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const picker=()=>page.locator('input[type=file][accept*=docx]');
const folder=id=>path.join(process.env.APPDATA,'dev.geod-agent.desktop','chat-attachments',createHash('sha256').update(saved.userId+':'+id).digest('hex').slice(0,32));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const select=async id=>{if((await state()).active!==id)await page.locator(`[data-conversation-id="${id}"]`).click();await page.locator('.geod-prompt-input textarea').waitFor();};
const language=async value=>page.evaluate(async language=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language});},value);
const theme=async value=>{if(await page.evaluate(()=>document.documentElement.dataset.theme)===value)return;await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:/^(深色外观|浅色外观|Dark appearance|Light appearance)$/,exact:true}).click();await delay(500);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),value);};
const keys=Object.values(fixtures.markers);
async function idle(count){await page.waitForFunction(count=>document.querySelectorAll('.composer-documents .chat-document-chip').length===count&&!document.querySelector('.composer-documents [role=status]'),count,{timeout:180000});}
async function unlock(name,count){
  await picker().setInputFiles(path.join(root,'workspace',name));await page.locator('#document-password').waitFor({timeout:60000});
  assert(await page.locator('#document-password').evaluate(input=>input===document.activeElement));
  assert.equal(await page.locator('#document-password').getAttribute('type'),'password');
  await page.locator('#document-password').fill(passwords[name]);await page.locator('#document-password').press('Enter');await idle(count);
}
async function reject(command,args,code){let error;try{await rpc(command,args)}catch(e){error=e}assert.equal(error?.code,code,JSON.stringify(error));}
try{
 if(mode==='native'){
  assert.equal((await rpc('background_status')).activeAiTurns,0);
  if(await page.locator('#document-password').count()){await page.locator('#document-password').press('Escape');await idle(await page.locator('.composer-documents .chat-document-chip').count());}
  if(!saved){
   const original=await state();assert.equal(original.chats.length,30);write('original-conversations.json',original.chats);
   saved={userId:original.userId,originalActive:original.active,baselineChatIds:original.chats.map(c=>c.conversationId),originalDefault:(await rpc('ai_channels_list')).default,settings:await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})),documents:[],qaConversationIds:[]};save();
   await page.locator('.sidebar-new-chat').click();saved.conversationId=(await state()).active;assert(!saved.baselineChatIds.includes(saved.conversationId));saved.qaConversationIds.push(saved.conversationId);save();
  }else{assert(!saved.cleaned);await select(saved.conversationId);}
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
  await language('zh-CN');await theme('dark');await page.setViewportSize({width:1000,height:720});
  // A native failure must clean all files created by the failed import.
  if(!saved.contractVerified){
   const id=randomUUID(),payload=fs.readFileSync(path.join(root,'workspace','agile.docx')).toString('base64');saved.contractId=id;save();
   await reject('document_attachment_add',{conversationId:id,name:'agile.docx',base64:payload},'ATTACHMENT_PASSWORD_REQUIRED');
   await reject('document_attachment_add',{conversationId:id,name:'agile.docx',base64:payload,password:'INCORRECT_QA_VALUE'},'ATTACHMENT_PASSWORD_INCORRECT');
   await reject('document_attachment_add',{conversationId:id,name:'agile.docx',base64:payload,password:'x'.repeat(4097)},'ATTACHMENT_PASSWORD_INPUT');
   assert.deepEqual(fs.readdirSync(folder(id)),[]);
   await reject('document_attachment_add',{conversationId:id,name:'cfb-mode.docx',base64:fs.readFileSync(path.join(root,'workspace/cfb-mode.docx')).toString('base64')},'ATTACHMENT_PASSWORD_UNSUPPORTED');
   await reject('document_attachment_add',{conversationId:id,name:'damaged-integrity.docx',base64:fs.readFileSync(path.join(root,'workspace/damaged-integrity.docx')).toString('base64'),password:passwords['damaged-integrity.docx']},'ATTACHMENT_DOCUMENT_INVALID');
   assert.deepEqual(fs.readdirSync(folder(id)),[]);saved.contractVerified=true;save();pass('Actual native password errors, unsupported cipher and tampered payload leave no partial attachment');
  }
  if(!saved.cancelVerified){
   await picker().setInputFiles(['pdf-AES-256.pdf','plain.docx'].map(name=>path.join(root,'workspace',name)));
   await page.locator('#document-password').waitFor({timeout:60000});assert(await page.locator('#document-password').evaluate(input=>input===document.activeElement));
   await page.screenshot({path:path.join(root,'actual-password-dark-zh.png')});await page.locator('#document-password').press('Escape');await idle(0);
   assert.deepEqual(await rpc('document_attachments_list',{conversationId:saved.conversationId}),[]);
   assert(!fs.existsSync(folder(saved.conversationId))||fs.readdirSync(folder(saved.conversationId)).length===0);saved.cancelVerified=true;save();pass('Real password dialog autofocus and Escape cancel the remaining batch without a draft');
  }
  if(!saved.retryVerified){
   await language('en');await theme('light');await picker().setInputFiles(path.join(root,'workspace/pdf-AES-256.pdf'));await page.locator('#document-password').waitFor({timeout:60000});
   await page.locator('#document-password').fill('INCORRECT_QA_VALUE');await page.locator('#document-password').press('Enter');await page.getByRole('alert').filter({hasText:'Incorrect document password'}).waitFor({timeout:60000});
   assert.equal(await page.locator('#document-password').inputValue(),'');assert(await page.locator('#document-password').evaluate(input=>input===document.activeElement));
   const layout=await page.locator('.document-password-dialog').evaluate(el=>({width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth,text:el.textContent}));assert(layout.width<=442&&!layout.overflow);assert(!/[\u3400-\u9fff]/u.test(layout.text));
   await page.screenshot({path:path.join(root,'actual-password-retry-light-en.png')});await page.locator('#document-password').fill(passwords['pdf-AES-256.pdf']);await page.locator('#document-password').press('Enter');await idle(1);
   saved.retryVerified=true;save();pass('Actual English/light password retry clears the incorrect value, keeps focus and imports the encrypted PDF',{layout});
  }
  await language('zh-CN');await theme('dark');await page.setViewportSize({width:1440,height:900});
  if(!saved.switchVerified){
   await picker().setInputFiles(path.join(root,'workspace/agile.xlsx'));await page.locator('.sidebar-new-chat').click();saved.switchId=(await state()).active;assert(saved.switchId!==saved.conversationId&&!saved.baselineChatIds.includes(saved.switchId));saved.qaConversationIds.push(saved.switchId);save();
   await delay(3000);assert.equal(await page.locator('#document-password').count(),0);assert.equal(await page.locator('.composer-documents .chat-document-chip').count(),0);
   assert(!fs.existsSync(folder(saved.switchId))||fs.readdirSync(folder(saved.switchId)).length===0);await select(saved.conversationId);await idle(1);
   assert.equal(await page.locator('#document-password').count(),0);saved.switchVerified=true;save();pass('Switching the actual conversation during import cancels only the originating pending password request');
  }
  const names=['pdf-AES-256.pdf','agile.docx','agile.xlsx','agile.pptx','binary.doc','binary.xls','binary.ppt','scan-aes256.pdf'];
  const currentNames=await page.locator('.composer-documents .chat-document-chip strong').allTextContents();
  for(const name of names){if(currentNames.includes(name))continue;await unlock(name,await page.locator('.composer-documents .chat-document-chip').count()+1);}
  saved.documents=[];
  for(const chip of await page.locator('.composer-documents .chat-document-chip').all()){
   const id=await chip.getAttribute('data-attachment-id'),record=JSON.parse(fs.readFileSync(path.join(folder(saved.conversationId),id+'.json'),'utf8'));
   const file=record.attachment,source=fixtures.files[file.name];assert(source);assert.equal(record.published,false);assert.equal(sha(path.join(folder(saved.conversationId),id+'.attachment')),source.sha256);assert.equal(sha(path.join(folder(saved.conversationId),id+'.text')),file.textSha256);
   const text=fs.readFileSync(path.join(folder(saved.conversationId),id+'.text'),'utf8');assert(file.name==='scan-aes256.pdf'?text.includes(fixtures.scanMarker):keys.some(key=>text.includes(key)));saved.documents.push(file);
  }
  assert.equal(saved.documents.length,8);assert.deepEqual(await rpc('document_attachments_list',{conversationId:saved.conversationId}),[]);save();write('actual-native-attachments.json',saved.documents);
  await page.screenshot({path:path.join(root,'actual-encrypted-composer-dark.png')});pass('Actual file picker reads encrypted PDF, DOCX/XLSX/PPTX, DOC/XLS/PPT and encrypted scan locally; all original encrypted bytes remain hashed',{documents:saved.documents});
 }else if(mode==='model'){
  await select(saved.conversationId);assert.equal(await page.locator('.composer-documents .chat-document-chip').count(),8);
  const usageBefore=await rpc('agent_usage');assert.equal(usageBefore.quotaEnforced,false);
  const prompt='实际附件读取验收：请分别使用 attachment_read 读取本轮全部 8 个附件的正文；演示文稿备注也要读取。最后只列各实际文件名和内容中的完整随机标记（CRYPTDATA 或 MAPDATA 开头），有 nextOffset 时继续读取。不运行命令、不使用其他工具。';
  assert(keys.every(key=>!prompt.includes(key))&&!prompt.includes(fixtures.scanMarker));await page.locator('textarea').fill(prompt);await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot')&&document.querySelectorAll('.geod-message-body').length>0,null,{timeout:240000});
  const chat=(await state()).chats.find(c=>c.conversationId===saved.conversationId);assert(chat);const answer=chat.messages.filter(m=>m.role==='assistant').at(-1)?.content;
  for(const marker of [...keys,fixtures.scanMarker])assert(answer?.includes(marker),answer);assert(chat.display.filter(item=>item.toolName==='attachment_read').length>=8);
  const published=await rpc('document_attachments_list',{conversationId:saved.conversationId});assert.equal(published.length,8);
  for(const file of saved.documents){const read=await rpc('document_attachment_read',{conversationId:saved.conversationId,id:file.id});assert(read.text&&read.complete);}
  const usageAfter=await rpc('agent_usage');assert(usageAfter.committedTokens>usageBefore.committedTokens);saved.foregroundTokens=usageAfter.committedTokens-usageBefore.committedTokens;save();
  write('actual-model-chat.json',chat);await page.screenshot({path:path.join(root,'actual-model-answer.png')});pass('Real Codex/DeepSeek answer reads all eight actual encrypted attachments through native tools without receiving any password',{actualAnswer:answer,toolCalls:chat.display.filter(item=>item.toolName==='attachment_read').length,actualSettledTokens:saved.foregroundTokens});
 }else if(mode==='background'){
  assert(JSON.parse(fs.readFileSync(path.join(root,'model-result.json'),'utf8')).passed);
  const ids=saved.documents.map(d=>({id:d.id,name:d.name}));const prompt='实际后台附件读取验收：调用 attachment_read 读取已保存附件 '+JSON.stringify(ids)+'。最终只列出实际正文中的 CRYPTDATA 和 MAPDATA 完整随机标记，包括演示文稿备注。不要运行其他操作。';
  assert(keys.every(key=>!prompt.includes(key))&&!prompt.includes(fixtures.scanMarker));
  const schedule=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Encrypted document closed-window acceptance',prompt,nextRunAt:new Date(Date.now()+15000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;save();
  await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState()});
  await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close()}).catch(e=>{if(!e.message.includes('closed'))throw e});
  pass('The actual desktop closes before its scheduled read; the companion needs only stored extracted text');
 }else if(mode==='recovery'){
  assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});assert.equal((await rpc('background_status')).activeAiTurns,0);
  saved.forkId=randomUUID();const workspace=await rpc('workspace_get',{conversationId:saved.conversationId});await rpc('workspace_set',{conversationId:saved.forkId,directory:workspace.directory,permission:workspace.permission});
  const fork=await rpc('codex_fork',{sourceConversationId:saved.conversationId,conversationId:saved.forkId,imageIds:[],documentIds:saved.documents.map(d=>d.id)});assert.equal(fork.documents.length,8);saved.forkThreadId=fork.threadId;save();
  for(const file of saved.documents){const original=await rpc('document_attachment_read',{conversationId:saved.conversationId,id:file.id}),copy=await rpc('document_attachment_read',{conversationId:saved.forkId,id:file.id});assert.equal(copy.text,original.text);assert.equal(sha(path.join(folder(saved.forkId),file.id+'.attachment')),file.sha256);}
  pass('Native conversation fork copies the encrypted originals and exact extracted text without a password');
  const uiState=await page.evaluate(async()=>{const {snapshotLocalRecords,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();return snapshotLocalRecords()});saved.backup=await rpc('desktop_backup_create',{uiState});save();
  const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8'));let owned=0;
  for(const record of manifest.records){assert.equal(sha(path.join(saved.backup.path,record.file)),record.sha256);if([saved.conversationId,saved.forkId].some(id=>record.path.startsWith('chat-attachments/'+path.basename(folder(id))+'/')))owned++;}
  assert.equal(owned,48);pass('Complete native backup verifies every record and includes both sets of eight original/text/ownership triples',{backup:saved.backup,records:manifest.records.length,ownedAttachmentRecords:owned});
 }else if(mode==='visual'){
  await select(saved.conversationId);await language('zh-CN');await theme('dark');await page.setViewportSize({width:1000,height:720});
  await picker().setInputFiles(path.join(root,'workspace/agile.docx'));await page.locator('#document-password').waitFor({timeout:60000});
  const layout=await page.locator('.document-password-dialog').evaluate(el=>({width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth}));
  assert(layout.width<=442&&!layout.overflow);assert(await page.locator('#document-password').evaluate(input=>input===document.activeElement));
  await page.screenshot({path:path.join(root,'actual-password-dark-zh.png')});await page.locator('#document-password').press('Escape');await idle(0);
  assert.equal((await rpc('document_attachments_list',{conversationId:saved.conversationId})).length,8);
  assert.equal(fs.readdirSync(folder(saved.conversationId)).length,24);
  await page.setViewportSize({width:1440,height:900});pass('Final Chinese/dark password dialog stays compact at 1000 pixels and cancellation preserves the eight published attachments',{layout});
 }else if(mode==='restart'){
  const overview=await rpc('ai_schedules_list',{conversationId:saved.conversationId});assert.equal(overview.schedules.find(s=>s.scheduleId===saved.scheduleId)?.enabled,false);
  let reads=0;for(const id of [saved.conversationId,saved.forkId]){assert.equal((await rpc('document_attachments_list',{conversationId:id})).length,8);for(const file of saved.documents){const read=await rpc('document_attachment_read',{conversationId:id,id:file.id});assert(read.text&&read.complete);assert.equal(sha(path.join(folder(id),file.id+'.attachment')),file.sha256);assert.equal(sha(path.join(folder(id),file.id+'.text')),file.textSha256);reads++;}}
  const chat=(await state()).chats.find(c=>c.conversationId===saved.conversationId),before=JSON.parse(fs.readFileSync(path.join(root,'actual-model-chat.json'),'utf8'));assert.deepEqual(chat,before);
  pass('Full native desktop and companion restart reread all sixteen stored attachments and preserve the real model transcript',{reads});
 }else{
  assert.equal((await rpc('background_status')).activeAiTurns,0);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});await rpc('ai_model_select',{conversationId:'default',...saved.originalDefault});
  write('actual-owned-ui-conversations.json',(await state()).chats.filter(c=>saved.qaConversationIds.includes(c.conversationId)));
  await language('zh-CN');await theme(saved.settings.theme);
  await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId),owned=new Set(saved.qaConversationIds);if(saved.qaConversationIds.some(id=>saved.baselineChatIds.includes(id)))throw new Error('Refusing to remove original chats');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(c=>!owned.has(c.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);await flushLocalState();if(saved.settings.language)setLanguagePreferences(JSON.parse(saved.settings.language));},saved);
  await page.setViewportSize({width:saved.settings.width,height:saved.settings.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  const restored=await state(),original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8'));assert.equal(restored.chats.length,30);assert.equal(restored.active,saved.originalActive);const map=new Map(restored.chats.map(c=>[c.conversationId,c]));for(const chat of original)assert.deepEqual(map.get(chat.conversationId),chat);assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);saved.cleaned=true;save();
  pass('Only the two owned acceptance chats are archived from the sidebar; all thirty original conversations and settings remain exact');
 }
 assert.equal(report.rendererErrors.length,0,'Renderer errors: '+report.rendererErrors.join('\n'));report.passed=true;write(mode+'-result.json',report);
}catch(e){report.error={code:e.code,message:e.message||JSON.stringify(e),stack:e.stack};write(mode+'-result.json',report);const file=path.join(root,'harness-failures.json'),failures=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];failures.push({mode,time:new Date().toISOString(),error:report.error,completed:report.cases.length});write('harness-failures.json',failures);console.error(JSON.stringify(report.error));await page.screenshot({path:path.join(root,mode+'-failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser.close().catch(()=>{})}
