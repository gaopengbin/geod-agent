/** Actual desktop codecs, model download/cancel, transcription editor and model tools. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/audio-inputs');
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2));
const resume=process.argv.includes('--resume');
const report=resume?JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')):{passed:false,cases:[],audioUploadedToServer:false};delete report.error;let original,conversationId,uiId,scheduleId,forkId;
const record=(name,details={})=>{const value={name,passed:true,...details},existing=report.cases.findIndex(item=>item.name===name);if(existing>=0)report.cases[existing]=value;else report.cases.push(value);write('native-result.json',report);console.log(JSON.stringify({name,passed:true}));};
async function chatState(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});}
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const audioInput=()=>page.locator('input[type=file][accept*=mp3]');
try{
  original={...(await chatState()),...(await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})))};
  const initial=await rpc('audio_settings_get');assert(initial.localOnly);if(!resume)write('settings-before.json',initial);
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.locator('.sidebar-new-chat').click();conversationId=(await chatState()).active;assert.notEqual(conversationId,original.active);
  const workspace=await rpc('workspace_get',{conversationId});await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
  let audioId,draft,marker,corrected;
  if(resume){
    const actual=JSON.parse(fs.readFileSync(path.join(root,'actual-ui-audio-chat.json'),'utf8'));conversationId=actual.conversationId;audioId=actual.messages.flatMap(message=>message.documents??[]).find(file=>file.kind==='audio').id;draft={attachment:actual.messages.flatMap(message=>message.documents??[]).find(file=>file.id===audioId)};
    corrected=(await rpc('document_attachment_read',{conversationId,id:audioId})).text;marker=corrected.match(/AUDIO_[A-F0-9]{32}/)[0];assert(actual.display.some(item=>item.toolName==='attachment_read'));assert(actual.display.some(item=>item.role==='assistant'&&item.phase==='final'&&item.content.includes(marker)));
    uiId=(await chatState()).active;
  }else{
  await audioInput().setInputFiles(path.join(root,'workspace/beijing-english.mp3'));
  const setup=page.locator('.audio-setup-dialog');await setup.waitFor({timeout:30000});
  await page.setViewportSize({width:1000,height:720});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await delay(400);await page.screenshot({path:path.join(root,'audio-setup-dark-zh.png')});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});await delay(400);await page.screenshot({path:path.join(root,'audio-setup-light-en.png')});assert.equal(await setup.getByRole('heading',{name:'Local audio transcription',exact:true}).count(),1);
  await setup.getByRole('combobox',{name:'Speech model'}).click();await page.getByRole('option',{name:/Lightweight/}).click();await setup.getByRole('button',{name:'Download model',exact:true}).click();
  await page.waitForFunction(async()=>Boolean((await window.__TAURI_INTERNALS__.invoke('audio_settings_get')).downloading),null,{timeout:10000});await setup.getByRole('button',{name:'Cancel download',exact:true}).click();
  await setup.getByRole('button',{name:'Download model',exact:true}).waitFor();await page.waitForFunction(async()=>!(await window.__TAURI_INTERNALS__.invoke('audio_settings_get')).downloading,null,{timeout:30000});
  const afterCancel=await rpc('audio_settings_get');assert(!afterCancel.models.find(model=>model.id==='tiny').available);record('Actual bilingual audio setup downloads and cancels a real model',{settings:afterCancel});
  await setup.getByRole('combobox',{name:'Speech model'}).click();await page.getByRole('option',{name:/Standard model/}).click();await setup.getByRole('button',{name:'Download model',exact:true}).click();await setup.getByRole('button',{name:'Save and continue',exact:true}).waitFor({timeout:180000});await setup.getByRole('button',{name:'Save and continue',exact:true}).click();await setup.waitFor({state:'hidden'});
  const chip=page.locator('.composer-documents .chat-document-chip').filter({hasText:'beijing-english.mp3'});await chip.waitFor({timeout:60000});audioId=await chip.getAttribute('data-attachment-id');assert(audioId);
  draft=await rpc('audio_attachment_draft',{conversationId,id:audioId});assert(draft.text.includes('Beijing')&&draft.text.includes('12'));assert.equal(draft.attachment.sha256,createHash('sha256').update(fs.readFileSync(path.join(root,'workspace/beijing-english.mp3'))).digest('hex'));assert.equal((await rpc('document_attachments_list',{conversationId})).length,0);
  record('Actual MP3 decoder and native CPU model recover authored audio while keeping drafts unpublished',{attachment:draft.attachment,actualTranscript:draft.text});
  await chip.getByRole('button',{name:/Review transcript/}).click();const editor=page.locator('.audio-transcript-dialog');await editor.locator('textarea:not([disabled])').waitFor();marker='AUDIO_'+randomUUID().replaceAll('-','').toUpperCase();corrected=draft.text+'\nUser correction marker: '+marker;
  await editor.locator('textarea').fill(corrected);await delay(400);await page.screenshot({path:path.join(root,'audio-transcript-light-en.png')});await editor.getByRole('button',{name:'Save transcript',exact:true}).click();await editor.waitFor({state:'hidden'});
  const edited=await rpc('audio_attachment_draft',{conversationId,id:audioId});assert.equal(edited.text,corrected);assert.equal(edited.attachment.sha256,draft.attachment.sha256);assert(edited.attachment.transcriptEdited);assert(!edited.attachment.warnings.includes('TRANSCRIPTION_EDITED'));
  record('Actual transcript editor preserves the original audio and saves user corrections',{marker,attachment:edited.attachment});
  await page.locator('textarea').fill('实际音频输入验收。请只使用 attachment_read 读取本轮音频转写，最终回复其中的城市、缩放级别和 AUDIO_ 开头的完整随机标记。不要下载、规划、运行命令或使用其他工具。');await page.locator('textarea').press('Enter');
  await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),marker,{timeout:180000});await delay(1000);
  const chat=(await chatState()).chats.find(item=>item.conversationId===conversationId);assert(chat.display.some(item=>item.toolName==='attachment_read'));assert(chat.display.some(item=>item.role==='assistant'&&item.phase==='final'&&item.content.includes(marker)));write('actual-ui-audio-chat.json',chat);await page.screenshot({path:path.join(root,'actual-audio-chat-light-en.png')});
  }
  const published=await rpc('document_attachment_read',{conversationId,id:audioId});assert.equal(published.text,corrected);
  await assert.rejects(rpc('audio_attachment_edit',{conversationId,id:audioId,text:'Must not overwrite the sent transcript'}),error=>error.code==='ATTACHMENT_ALREADY_SENT');
  await assert.rejects(rpc('document_attachment_read',{conversationId:randomUUID(),id:audioId}),error=>error.code==='ATTACHMENT_NOT_FOUND');
  record('Real Codex/DeepSeek reads corrected audio through the attachment tool with conversation isolation',{conversationId,audioId,marker});
  await audioInput().setInputFiles(['beijing-chinese.wav','beijing-chinese.flac','beijing-english.m4a'].map(name=>path.join(root,'workspace',name)));
  await page.waitForFunction(()=>document.querySelectorAll('.composer-documents .chat-document-chip').length===3&&!document.querySelector('.composer-audio-status'),null,{timeout:60000});
  const batch=[];for(const element of await page.locator('.composer-documents .chat-document-chip').all()){const id=await element.getAttribute('data-attachment-id');batch.push(await rpc('audio_attachment_draft',{conversationId:uiId??conversationId,id}));}
  for(const entry of batch)assert(entry.text.includes(entry.attachment.name.includes('chinese')?'北京':'Beijing'));write('actual-format-transcripts.json',batch);record('Actual WAV, FLAC and M4A batch files decode and transcribe locally',{formats:batch.map(entry=>entry.attachment.extension)});
  await audioInput().setInputFiles({name:'damaged.mp3',mimeType:'audio/mpeg',buffer:Buffer.from('Not an audio file')});await page.getByRole('alert').filter({hasText:/Unable to decode|无法解码/}).waitFor({timeout:30000});assert.equal(await page.locator('.composer-documents .chat-document-chip').count(),3);
  record('Unreadable audio returns a recoverable error without losing other attachments');
  const schedule=await rpc('ai_schedules_create',{conversationId,name:'Actual audio background QA',prompt:'仅使用 attachment_read 读取附件 '+audioId+'，最终只回复实际正文中 AUDIO_ 开头的完整随机标记。不要调用其他工具。',nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});scheduleId=schedule.scheduleId;
  let result;const deadline=Date.now()+180000;while(Date.now()<deadline){const status=await rpc('ai_schedules_list',{conversationId}),run=status.runs.find(run=>run.scheduleId===scheduleId);if(run&&!['queued','running'].includes(run.state)){result=await rpc('ai_schedules_run_events',{runId:run.runId});break;}await delay(1000);}
  assert.equal(result?.run.state,'succeeded');assert(JSON.stringify(result.events).includes(marker));write('actual-background-audio.json',result);record('Actual companion and model read the stored audio transcript in the background',{run:result.run});
  forkId=randomUUID();const forked=await rpc('codex_fork',{sourceConversationId:conversationId,conversationId:forkId,imageIds:[],documentIds:[audioId]});assert.equal(forked.documents[0].sha256,draft.attachment.sha256);assert.equal((await rpc('document_attachment_read',{conversationId:forkId,id:audioId})).text,corrected);
  record('Actual native conversation fork retains audio bytes and corrected text',{forkId,threadId:forked.threadId});
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});
  write('audio-backup.json',backup);write('restart-state.json',{conversationId,forkId,audioId,marker,corrected,originalAudioSha256:draft.attachment.sha256,backup,originalChatIds:original.chats.map(chat=>chat.conversationId)});record('Actual complete backup includes audio records for restart verification',{backup});
  report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};const file=path.join(root,'harness-failures.json'),previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];previous.push({time:new Date().toISOString(),error:report.error,completedCases:report.cases.length});fs.writeFileSync(file,JSON.stringify(previous,null,2));console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false}).catch(()=>{});
  if(original&&conversationId){await page.evaluate(async value=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStateStore,value.original.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>![value.conversationId,value.uiId].includes(chat.conversationId))));store.setItem('geod-agent-active-conversation-0.1',value.original.active);await flushLocalState();},{original:{userId:original.userId,active:original.active},conversationId,uiId}).catch(()=>{});await page.reload();await page.locator('.conversation-account-trigger').waitFor();}
  if(original){await page.evaluate(async value=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(value.language)setLanguagePreferences(JSON.parse(value.language));document.documentElement.dataset.theme=value.theme;document.documentElement.style.colorScheme=value.theme;},{language:original.language,theme:original.theme}).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  write('native-result.json',report);await browser.close();
}
