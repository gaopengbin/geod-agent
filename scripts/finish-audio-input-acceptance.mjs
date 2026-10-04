/** Native restart, cancellation, original media backup and real model follow-up. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/audio-inputs');
const saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
assert(page);await page.locator('.conversation-account-trigger').waitFor();
const report={passed:false,cases:[],audioUploadedToServer:false};let original,conversationId,newForkId;
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2));
const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const record=(name,details={})=>{report.cases.push({name,passed:true,...details});write('finish-result.json',report);console.log(JSON.stringify({name,passed:true}));};
async function state(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});}
function verifyBackup(backup,id,expectedAudio,expectedText,expectMachine){
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));
  assert(!manifest.records.some(record=>record.path.includes('audio-models')));
  const entries=manifest.records.filter(record=>record.path.includes(id));
  for(const entry of entries)assert.equal(hash(fs.readFileSync(path.join(backup.path,entry.file))),entry.sha256);
  const audio=entries.filter(entry=>entry.path.endsWith('.attachment')),texts=entries.filter(entry=>entry.path.endsWith('.text'));
  assert.equal(audio.length,2);assert.equal(texts.length,2);
  for(const entry of audio)assert.equal(entry.sha256,expectedAudio);
  for(const entry of texts)assert.equal(fs.readFileSync(path.join(backup.path,entry.file),'utf8'),expectedText);
  if(expectMachine){const machine=entries.filter(entry=>entry.path.endsWith('.transcript'));assert.equal(machine.length,2);for(const entry of machine)assert.notEqual(entry.sha256,hash(expectedText));}
  return{records:entries.length,audioSha256:expectedAudio,textSha256:hash(expectedText),modelCacheExcluded:true};
}
try{
  original={...(await state()),...(await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})))};
  assert.deepEqual(new Set(original.chats.map(chat=>chat.conversationId)),new Set(saved.originalChatIds));
  const settings=await rpc('audio_settings_get');assert(settings.localOnly);assert(settings.models.find(model=>model.id==='base').available);
  for(const id of [saved.conversationId,saved.forkId]){const result=await rpc('document_attachment_read',{conversationId:id,id:saved.audioId});assert.equal(result.text,saved.corrected);const list=await rpc('document_attachments_list',{conversationId:id}),audio=list.find(file=>file.id===saved.audioId);assert.equal(audio.sha256,saved.originalAudioSha256);assert.equal(audio.transcriptEdited,true);assert(!audio.warnings.some(warning=>['MACHINE_TRANSCRIPTION','TRANSCRIPTION_EDITED'].includes(warning)));}
  record('Actual desktop restart preserves model settings, audio and edited transcripts in both native conversations',{settings});
  record('Existing complete backup retains original audio and edited text for source and fork',verifyBackup(saved.backup,saved.audioId,saved.originalAudioSha256,saved.corrected,false));
  await assert.rejects(rpc('document_attachment_discard',{conversationId:saved.conversationId,id:saved.audioId}),error=>error.code==='ATTACHMENT_ALREADY_SENT');
  const raw=fs.readFileSync(path.join(root,'workspace/beijing-chinese.wav'));
  const wave=await page.evaluate(async base64=>{const {decodeAudioFile}=await import('/src/audio-attachments.tsx'),bytes=Uint8Array.from(atob(base64),letter=>letter.charCodeAt(0)),wav=await decodeAudioFile(new File([bytes],'beijing-chinese.wav'));return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(new Blob([wav]));});},raw.toString('base64'));
  const nativeConversation=randomUUID(),baseArgs={conversationId:nativeConversation,name:'beijing-chinese.wav',base64:raw.toString('base64'),wavBase64:wave};
  const requestId=randomUUID();await rpc('audio_transcription_cancel',{conversationId:nativeConversation,requestId});
  await assert.rejects(rpc('audio_attachment_add',{...baseArgs,requestId}),error=>error.code==='AUDIO_CANCELLED');
  const runningId=randomUUID();await page.evaluate(args=>{window.__audioFinish=window.__TAURI_INTERNALS__.invoke('audio_attachment_add',args).then(value=>({ok:true,value}),error=>({ok:false,error}));}, {...baseArgs,requestId:runningId});
  const normalizedFile=path.join(process.env.LOCALAPPDATA,'dev.geod-agent.desktop/audio-models',`transcribe-${runningId}`,'input.wav');
  const deadline=Date.now()+20000;while(!fs.existsSync(normalizedFile)&&Date.now()<deadline)await delay(20);assert(fs.existsSync(normalizedFile),'Native inference did not start');
  await rpc('audio_transcription_cancel',{conversationId:nativeConversation,requestId:runningId});
  const cancelled=await page.evaluate(()=>window.__audioFinish);assert.equal(cancelled.ok,false);assert.equal(cancelled.error.code,'AUDIO_CANCELLED');assert(!fs.existsSync(path.dirname(normalizedFile)));
  record('Actual native cancellation handles requests before IPC registration and during CPU inference without late attachments');
  const removable=await rpc('audio_attachment_add',{...baseArgs,requestId:randomUUID()});
  await assert.rejects(rpc('document_attachment_discard',{conversationId:randomUUID(),id:removable.id}),error=>error.code==='ATTACHMENT_NOT_FOUND');
  await rpc('document_attachment_discard',{conversationId:nativeConversation,id:removable.id});await assert.rejects(rpc('audio_attachment_draft',{conversationId:nativeConversation,id:removable.id}),error=>error.code==='ATTACHMENT_NOT_FOUND');assert.equal(hash(raw),removable.sha256);
  record('Draft removal is scoped to its conversation and sent audio remains immutable',{originalFilePreserved:true});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});await page.setViewportSize({width:1440,height:900});
  await page.locator('.sidebar-new-chat').click();conversationId=(await state()).active;
  const workspace=await rpc('workspace_get',{conversationId});await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
  await page.locator('input[type=file][accept*=mp3]').setInputFiles(path.join(root,'workspace/beijing-english.mp3'));
  await page.locator(`[data-conversation-id="${original.active}"]`).click();await delay(1800);assert.equal((await state()).active,original.active);assert.equal(await page.locator('.composer-documents .chat-document-chip').count(),0);
  await page.locator(`[data-conversation-id="${conversationId}"]`).click();const chip=page.locator('.composer-documents .chat-document-chip').filter({hasText:'beijing-english.mp3'});await chip.waitFor({timeout:60000});
  const audioId=await chip.getAttribute('data-attachment-id'),draft=await rpc('audio_attachment_draft',{conversationId,id:audioId});assert(draft.text.includes('Beijing')&&draft.text.includes('12'));assert.equal(draft.attachment.transcriptEdited,false);assert.deepEqual(draft.attachment.warnings,[]);
  record('Actual conversation switch keeps asynchronous audio in its originating draft',{conversationId,audioId});
  await chip.getByRole('button',{name:/Review transcript/}).click();const editor=page.locator('.audio-transcript-dialog');await editor.locator('textarea:not([disabled])').waitFor();
  const marker='AUDIO_FINAL_'+randomUUID().replaceAll('-','').toUpperCase(),corrected=draft.text+'\nUser correction marker: '+marker;
  await editor.locator('textarea').fill(corrected);await editor.getByRole('button',{name:'Save transcript',exact:true}).click();await editor.waitFor({state:'hidden'});
  const edited=await rpc('audio_attachment_draft',{conversationId,id:audioId});assert.equal(edited.attachment.transcriptEdited,true);assert.deepEqual(edited.attachment.warnings,[]);
  await page.locator('textarea').fill('请用 attachment_read 读取本轮音频转写。告诉我其中提到的城市和缩放级别，并附上 AUDIO_FINAL_ 开头的完整随机标记。只读取附件，不运行其他操作。');await page.locator('textarea').press('Enter');
  await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),marker,{timeout:180000});await delay(1000);
  const chat=(await state()).chats.find(chat=>chat.conversationId===conversationId),final=chat.display.find(item=>item.role==='assistant'&&item.phase==='final'&&item.content.includes(marker));assert(final);assert(/Beijing|北京/.test(final.content)&&final.content.includes('12'));assert(!final.content.includes('TRANSCRIPTION_EDITED'));assert(chat.display.some(item=>item.toolName==='attachment_read'));write('actual-final-metadata-chat.json',chat);
  await page.evaluate(()=>document.fonts.ready);await delay(800);await page.screenshot({path:path.join(root,'actual-final-audio-chat.png')});
  record('Actual Codex/DeepSeek reads an edited transcript with normal metadata and reports its real content',{conversationId,audioId,marker});
  newForkId=randomUUID();const fork=await rpc('codex_fork',{sourceConversationId:conversationId,conversationId:newForkId,imageIds:[],documentIds:[audioId]});assert.equal(fork.documents[0].sha256,draft.attachment.sha256);assert.equal((await rpc('document_attachment_read',{conversationId:newForkId,id:audioId})).text,corrected);
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords());});
  write('final-backup-pending.json',{backup,conversationId,forkId:newForkId,audioId,corrected,originalAudioSha256:draft.attachment.sha256});
  const details=verifyBackup(backup,audioId,draft.attachment.sha256,corrected,true);write('final-backup.json',{backup,conversationId,forkId:newForkId,audioId,...details});
  record('New full backup and native fork preserve machine transcript, edited text and original media',{backup,...details});report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(original){await page.evaluate(async({original,conversationId})=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStateStore,original.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>chat.conversationId!==conversationId)));store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();},{original:{userId:original.userId,active:original.active},conversationId}).catch(()=>{});await page.reload();await page.locator('.conversation-account-trigger').waitFor();await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{language:original.language,theme:original.theme}).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  write('finish-result.json',report);await browser.close();
}
