/** Actual desktop import, model tools, closed-window scheduling and native persistence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const root=path.resolve('artifacts/product-gaps-20261004/legacy-office'),mode=process.argv[2];
assert(['native','model','background','recovery','restart','cleanup'].includes(mode));
const savedFile=path.join(root,'qa-state.json');let saved=fs.existsSync(savedFile)?JSON.parse(fs.readFileSync(savedFile,'utf8')):null;
const reportFile=path.join(root,mode+'-result.json'),report={passed:false,cases:[]};
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'fixtures.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let attempt=0;attempt<100&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,300));}assert(page);
await page.locator('.conversation-account-trigger').waitFor();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2));
const save=()=>write('qa-state.json',saved);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write(mode+'-result.json',report);console.log(JSON.stringify({name,passed:true}));};
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!value.ok)throw value.error;return value.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const input=()=>page.locator('input[type=file][accept*=docx]');
const folder=conversationId=>path.join(process.env.APPDATA,'dev.geod-agent.desktop','chat-attachments',createHash('sha256').update(saved.userId+':'+conversationId).digest('hex').slice(0,32));
const draft=id=>{assert(saved.conversationId&&!saved.baselineChatIds.includes(saved.conversationId));const where=folder(saved.conversationId),record=JSON.parse(fs.readFileSync(path.join(where,id+'.json'),'utf8'));assert.equal(record.attachment.conversationId,saved.conversationId);assert.equal(record.attachment.id,id);const text=fs.readFileSync(path.join(where,id+'.text'),'utf8');assert.equal(sha(path.join(where,id+'.text')),record.attachment.textSha256);assert.equal(sha(path.join(where,id+'.attachment')),record.attachment.sha256);return{...record,text};};
const appearance=async(language,theme,width=1000,height=720)=>{await page.evaluate(async({language,theme})=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language});document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},{language,theme});await page.setViewportSize({width,height});await page.evaluate(()=>document.fonts.ready);await delay(300);};
const select=async id=>{if((await state()).active!==id)await page.locator(`[data-conversation-id="${id}"]`).click();await page.locator('.geod-prompt-input textarea').waitFor();};
try{
  if(mode==='native'){
    assert.equal((await rpc('background_status')).activeAiTurns,0);
    if(!saved){
    const original=await state(),list=await rpc('ai_channels_list');assert.equal(original.chats.length,30);
    saved={userId:original.userId,originalActive:original.active,baselineChatIds:original.chats.map(chat=>chat.conversationId),originalDefault:list.default,appearance:await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}))};
    write('original-conversations.json',original.chats);save();
    await page.locator('.sidebar-new-chat').click();saved.conversationId=(await state()).active;assert(!saved.baselineChatIds.includes(saved.conversationId));save();
    }else{assert(!saved.cleaned,'Resume only the unfinished owned native QA');await select(saved.conversationId);}
    const workspace=await rpc('workspace_get',{conversationId:saved.conversationId});await rpc('workspace_set',{conversationId:saved.conversationId,directory:workspace.directory,permission:'fullAccess'});
    await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
    await appearance('zh-CN','dark',1440,900);
    if(saved.documents?.length){
      await page.waitForFunction(()=>!document.querySelector('.composer-documents [role=status]'),null,{timeout:60000});
      const accepted=new Set(saved.documents.map(record=>record.attachment.id));
      for(const chip of await page.locator('.composer-documents .chat-document-chip').all())if(!accepted.has(await chip.getAttribute('data-attachment-id')))await chip.getByRole('button').click();
      for(const document of saved.documents)assert.deepEqual(draft(document.attachment.id),document);
      const previous=JSON.parse(fs.readFileSync(reportFile,'utf8'));assert(previous.cases[0].passed);report.cases=[previous.cases[0]];
    }else{
    await input().setInputFiles(['beijing-brief.doc','北京旧版说明.doc','beijing-table.xls','beijing-slides.ppt'].map(name=>fixtures.files[name].path));
    await page.locator(`[data-conversation-id="${saved.originalActive}"]`).click();await delay(500);assert.equal(await page.locator('.composer-documents .chat-document-chip').count(),0);
    await select(saved.conversationId);
    await page.waitForFunction(()=>document.querySelectorAll('.composer-documents .chat-document-chip').length===4&&!document.querySelector('.composer-documents [role=status]'),null,{timeout:180000});
    saved.documents=[];
    for(const chip of await page.locator('.composer-documents .chat-document-chip').all()){
      const id=await chip.getAttribute('data-attachment-id'),record=draft(id),name=record.attachment.name;
      assert.equal(record.published,false);assert(!record.attachment.ocrEngine);assert.equal(record.attachment.sha256,fixtures.files[name].sha256);
      const key={'beijing-brief.doc':'en','北京旧版说明.doc':'zh','beijing-table.xls':'xls','beijing-slides.ppt':'ppt'}[name];assert(record.text.includes(fixtures.markers[key]));
      assert(['word','spreadsheet','presentation'].includes(record.attachment.kind));
      if(name==='beijing-table.xls'){assert.equal(record.attachment.units,2);assert(record.text.includes('B9: 3 [formula: 8+9]'));assert(record.attachment.warnings.includes('FORMULAS_NOT_RECALCULATED'));}
      if(name==='beijing-slides.ppt'){assert.equal(record.attachment.units,2);assert(record.text.indexOf('REORDERED_FIRST_SLIDE')<record.text.indexOf('ORIGINAL_FIRST_SLIDE'));}
      saved.documents.push(record);
    }
    save();write('actual-native-imports.json',saved.documents);assert.equal((await rpc('document_attachments_list',{conversationId:saved.conversationId})).length,0);
    pass('Actual Chinese/English DOC, binary XLS and reordered PPT import locally; switching conversations keeps the originating drafts',{documents:saved.documents.map(document=>document.attachment),noPublishedDrafts:true});
    }
    await input().setInputFiles(['beijing-brief.doc','damaged.ppt'].map(name=>fixtures.files[name].path));
    await page.waitForFunction(()=>document.querySelectorAll('.composer-documents .chat-document-chip').length===5&&!document.querySelector('.composer-documents [role=status]'),null,{timeout:60000});
    await page.getByRole('alert').filter({hasText:'文档内容已损坏或无法识别'}).waitFor({timeout:60000});assert.equal(await page.locator('.composer-documents .chat-document-chip').count(),5);
    const originals=new Set(saved.documents.map(record=>record.attachment.id));let recoveredId;
    for(const chip of await page.locator('.composer-documents .chat-document-chip').filter({hasText:'beijing-brief.doc'}).all()){const id=await chip.getAttribute('data-attachment-id');if(!originals.has(id))recoveredId=id;}assert(recoveredId);
    const recovered=page.locator('.composer-documents [data-attachment-id="'+recoveredId+'"]');assert.equal(draft(recoveredId).attachment.kind,'word');
    await recovered.getByRole('button',{name:'移除文档 beijing-brief.doc',exact:true}).click();await delay(200);for(const suffix of ['attachment','text','json'])assert(!fs.existsSync(path.join(folder(saved.conversationId),recoveredId+'.'+suffix)));assert.equal(sha(fixtures.files['beijing-brief.doc'].path),fixtures.files['beijing-brief.doc'].sha256);
    pass('A damaged binary PPT returns a typed error while the preceding successful Word file stays removable and its original stays intact');
    const before=fs.readdirSync(folder(saved.conversationId)).sort();
    for(const [name,code] of [['encrypted.xls','ATTACHMENT_PASSWORD_REQUIRED'],['damaged.doc','ATTACHMENT_DOCUMENT_INVALID'],['damaged.xls','ATTACHMENT_DOCUMENT_INVALID'],['renamed-workbook.doc','ATTACHMENT_DOCUMENT_INVALID']])await assert.rejects(rpc('document_attachment_add',{conversationId:saved.conversationId,name,base64:fs.readFileSync(fixtures.files[name].path).toString('base64')}),error=>error.code===code);
    assert.deepEqual(fs.readdirSync(folder(saved.conversationId)).sort(),before);
    pass('Encrypted XLS, damaged files and a renamed workbook are rejected without orphan native files');
    for(const [language,theme] of [['zh-CN','dark'],['en','light']]){
      await appearance(language,theme);const chips=page.locator('.composer-documents .chat-document-chip');assert.equal(await chips.count(),4);
      const geometry=await page.evaluate(()=>({width:innerWidth,bodyWidth:document.documentElement.scrollWidth,attachments:document.querySelector('.composer-documents .chat-document-attachments').getBoundingClientRect().height,composer:document.querySelector('.geod-prompt-input').getBoundingClientRect().height}));assert.equal(geometry.width,1000);assert(geometry.bodyWidth<=1000);assert(geometry.attachments<=145);assert(geometry.composer<240);
      await page.screenshot({path:path.join(root,'actual-office-drafts-'+language+'-'+theme+'.png')});pass('Actual compact Office attachment metadata is readable in '+language+' / '+theme+' at 1000×720',{geometry});
    }
  }else if(mode==='model'){
    assert(JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).passed);await select(saved.conversationId);await appearance('zh-CN','dark',1440,900);
    const prompt='请分别调用 attachment_read 读取本轮四个文档。只依据实际正文，逐个回复文件名、城市、缩放级别和 OFFICEDATA 开头的完整标记；同时读出 Excel 中 B9 的已保存数值及公式，以及 PowerPoint 的实际幻灯片顺序。只读取这些附件，不下载，不规划，不使用其他工具。';
    assert(Object.values(fixtures.markers).every(marker=>!prompt.includes(marker)));await page.locator('textarea').fill(prompt);await page.locator('textarea').press('Enter');
    const deadline=Date.now()+180000;let chat,final;
    while(Date.now()<deadline){chat=(await state()).chats.find(chat=>chat.conversationId===saved.conversationId);final=chat?.display?.find(item=>item.role==='assistant'&&item.phase==='final');if(final)break;await delay(1000);}
    assert(final,'The real model did not finish');write('actual-foreground-chat.json',chat);const reads=chat.display.filter(item=>item.toolName==='attachment_read');assert(reads.length>=4);
    for(const document of saved.documents){assert(reads.some(item=>JSON.stringify(item).includes(document.attachment.id)));assert(final.content.includes(document.attachment.name));const published=await rpc('document_attachment_read',{conversationId:saved.conversationId,id:document.attachment.id});assert.equal(published.text,document.text);assert.deepEqual(published.attachment.ocrPages,document.attachment.ocrPages);}
    for(const marker of Object.values(fixtures.markers))assert(final.content.includes(marker));assert(/Beijing|北京/.test(final.content));assert(final.content.includes('12'));assert(chat.messages.every(message=>!(message.images?.length)));
    await page.screenshot({path:path.join(root,'actual-office-model-answer.png')});saved.foregroundFinal=final.content;save();
    pass('Real Codex/DeepSeek reads four actual binary Office documents and all unprompted random markers through native attachment tools',{readCount:reads.length,actualAnswer:final.content,visionImageAttachments:0});
    for(const document of saved.documents)await assert.rejects(rpc('document_attachment_read',{conversationId:randomUUID(),id:document.attachment.id}),error=>error.code==='ATTACHMENT_NOT_FOUND');
    pass('Actual published binary Office files remain isolated to their originating conversation');
  }else if(mode==='background'){
    assert(JSON.parse(fs.readFileSync(path.join(root,'model-result.json'),'utf8')).passed);assert.equal((await rpc('background_status')).activeAiTurns,0);
    const ids=saved.documents.map(document=>document.attachment.id).join(', ');
    const schedule=await rpc('ai_schedules_create',{conversationId:saved.conversationId,name:'Actual binary Office background acceptance',prompt:'分别使用 attachment_read 读取已保存四个附件 '+ids+'。最终回复各实际文件名、正文中 OFFICEDATA 开头的完整标记、城市和缩放级别，以及 Excel B9 已保存数值和公式。不运行其他操作。',nextRunAt:new Date(Date.now()+15000).toISOString(),repeatSeconds:null,executionId:randomUUID()});
    saved.scheduleId=schedule.scheduleId;saved.closedAt=new Date().toISOString();save();
    pass('A real scheduled model turn captures the four stored binary Office documents before closing the actual desktop window',{scheduleId:saved.scheduleId});
    await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/@tauri-apps/api/window.js');await getCurrentWindow().close();}).catch(error=>{if(!/closed|disconnected|destroyed/i.test(error.message))throw error;});
  }else if(mode==='recovery'){
    const headless=JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8'));assert(headless.passed);
    await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});const result=await rpc('ai_schedules_run_events',{runId:headless.runId});assert.equal(result.run.state,'succeeded');for(const marker of Object.values(fixtures.markers))assert(result.run.result.text.includes(marker));write('actual-native-background-readback.json',result);
    pass('Reopened actual desktop reads back the successful closed-window model result with native and Office markers');
    for(const document of saved.documents){const actual=await rpc('document_attachment_read',{conversationId:saved.conversationId,id:document.attachment.id});assert.equal(actual.text,document.text);assert.deepEqual(actual.attachment,document.attachment);assert.equal(sha(path.join(folder(saved.conversationId),document.attachment.id+'.attachment')),document.attachment.sha256);}
    saved.forkId=randomUUID();const fork=await rpc('codex_fork',{sourceConversationId:saved.conversationId,conversationId:saved.forkId,imageIds:[],documentIds:saved.documents.map(document=>document.attachment.id)});assert.equal(fork.documents.length,4);
    for(const document of saved.documents){const actual=await rpc('document_attachment_read',{conversationId:saved.forkId,id:document.attachment.id});assert.equal(actual.text,document.text);assert.deepEqual(actual.attachment.ocrPages,document.attachment.ocrPages);assert.equal(actual.attachment.sha256,document.attachment.sha256);}
    save();pass('Actual desktop restart and native Codex fork preserve source bytes, stored Office text, cached cells and slide order',{threadId:fork.threadId,forkId:saved.forkId});
    assert.equal((await rpc('background_status')).activeAiTurns,0);
    saved.backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});save();assert(saved.backup.verified);
    const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8'));for(const record of manifest.records)assert.equal(sha(path.join(saved.backup.path,record.file)),record.sha256);
    for(const document of saved.documents){const entries=manifest.records.filter(record=>record.path.includes(document.attachment.id));assert.equal(entries.length,6);for(const entry of entries){const file=path.join(saved.backup.path,entry.file);if(entry.path.endsWith('.attachment'))assert.equal(sha(file),document.attachment.sha256);if(entry.path.endsWith('.text'))assert.equal(fs.readFileSync(file,'utf8'),document.text);if(entry.path.endsWith('.json')){const actual=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(actual.attachment.ocrPages,document.attachment.ocrPages);assert(actual.published);}}}
    pass('Actual full verified backup preserves both conversations’ original binary Office files, extracted Office text and original binary metadata',{backupPath:saved.backup.path,verifiedRecords:manifest.records.length,ownedAttachmentRecords:24});
  }else if(mode==='restart'){
    assert(JSON.parse(fs.readFileSync(path.join(root,'recovery-result.json'),'utf8')).passed);
    for(const conversationId of [saved.conversationId,saved.forkId])for(const document of saved.documents){
      const actual=await rpc('document_attachment_read',{conversationId,id:document.attachment.id});assert.equal(actual.text,document.text);assert.equal(actual.attachment.sha256,document.attachment.sha256);assert.deepEqual(actual.attachment.ocrPages,document.attachment.ocrPages);assert.equal(actual.attachment.ocrEngine,document.attachment.ocrEngine);
    }
    const schedules=await rpc('ai_schedules_list',{conversationId:saved.conversationId});assert(!schedules.schedules.find(schedule=>schedule.scheduleId===saved.scheduleId).enabled);
    const previous=JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')),run=await rpc('ai_schedules_run_events',{runId:previous.runId});assert.equal(run.run.state,'succeeded');for(const marker of Object.values(fixtures.markers))assert(run.run.result.text.includes(marker));
    const manifest=JSON.parse(fs.readFileSync(path.join(saved.backup.path,'manifest.json'),'utf8'));for(const record of manifest.records)assert.equal(sha(path.join(saved.backup.path,record.file)),record.sha256);
    pass('Complete desktop and companion restart keeps both conversations’ Office/source bytes, the disabled schedule, actual result and all backup hashes',{verifiedRecords:manifest.records.length});
  }else if(mode==='cleanup'){
    assert(JSON.parse(fs.readFileSync(path.join(root,'restart-result.json'),'utf8')).passed);
    assert(JSON.parse(fs.readFileSync(path.join(root,'recovery-result.json'),'utf8')).passed);assert.equal((await rpc('background_status')).activeAiTurns,0);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});
    const original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8')),before=await state(),qa=before.chats.find(chat=>chat.conversationId===saved.conversationId);if(qa)write('archived-qa-chat.json',qa);
    await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId);if(saved.baselineChatIds.includes(saved.conversationId))throw new Error('Refusing original record deletion');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(chat=>chat.conversationId!==saved.conversationId)));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);await flushLocalState();if(saved.appearance.language)setLanguagePreferences(JSON.parse(saved.appearance.language));else{setLanguagePreferences({language:'system',replyLanguage:'auto'});localStorage.removeItem('geod-agent-language-v1');}document.documentElement.dataset.theme=saved.appearance.theme;document.documentElement.style.colorScheme=saved.appearance.theme;},saved);
    await page.setViewportSize({width:saved.appearance.width,height:saved.appearance.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
    const restored=await state(),byId=new Map(restored.chats.map(chat=>[chat.conversationId,chat]));assert.equal(restored.chats.length,original.length);assert.equal(restored.active,saved.originalActive);for(const chat of original)assert.deepEqual(byId.get(chat.conversationId),chat);assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);const status=await rpc('ai_schedules_list',{conversationId:saved.conversationId});assert(!status.schedules.find(schedule=>schedule.scheduleId===saved.scheduleId).enabled);
    for(const file of Object.values(fixtures.files))assert.equal(sha(file.path),file.sha256);
    pass('Owned QA sidebar record is archived; its schedule stays off, all 30 original conversations/defaults and original fixture bytes match',{originalConversations:original.length});
    saved.cleaned=true;save();
  }
  report.passed=true;
}catch(error){report.error={code:error.code,message:error.message,stack:error.stack};const failures=path.join(root,'harness-failures.json'),previous=fs.existsSync(failures)?JSON.parse(fs.readFileSync(failures,'utf8')):[];previous.push({mode,time:new Date().toISOString(),error:report.error,completed:report.cases.length});write('harness-failures.json',previous);console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{write(mode+'-result.json',report);await browser.close();}
