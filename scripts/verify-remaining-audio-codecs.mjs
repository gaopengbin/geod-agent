/** Real WebView codecs, native offline inference and real Agent attachment reads. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const root=path.resolve('artifacts/product-gaps-20261004/audio-codecs');
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'fixtures.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('.conversation-account-trigger').waitFor();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2));
const rpc=async(command,args={})=>{const response=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!response.ok)throw response.error;return response.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const report={passed:false,cases:[],originalAudioUploaded:false};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write('result.json',report);console.log(JSON.stringify({name,passed:true}));};
let original,conversationId,settings,selection,appearance;
try{
  assert.equal((await rpc('background_status')).activeAiTurns,0);
  original=await state();selection=(await rpc('ai_channels_list')).default;
  settings=await rpc('audio_settings_get');assert(settings.models.find(model=>model.id==='base').available);
  appearance=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}));
  write('original-conversations.json',original.chats);write('settings-before.json',{settings,selection,appearance,active:original.active});
  await rpc('audio_settings_set',{model:'base',language:'en'});
  await page.locator('.sidebar-new-chat').click();conversationId=(await state()).active;assert(!original.chats.some(chat=>chat.conversationId===conversationId));
  write('qa-state.json',{conversationId,originalActive:original.active,userId:original.userId});
  const workspace=await rpc('workspace_get',{conversationId});await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});
  await rpc('ai_model_select',{conversationId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
  await page.locator('textarea').waitFor();
  await page.locator('input[type=file][accept*=mp3]').setInputFiles(fixtures.files.map(file=>file.path));
  await page.waitForFunction(()=>document.querySelectorAll('.composer-documents .chat-document-chip').length===4&&!document.querySelector('.composer-audio-status'),null,{timeout:180000});
  const entries=[];
  for(const fixture of fixtures.files){
    const chip=page.locator('.composer-documents .chat-document-chip').filter({hasText:fixture.name});assert.equal(await chip.count(),1);
    const id=await chip.getAttribute('data-attachment-id'),draft=await rpc('audio_attachment_draft',{conversationId,id});
    assert.equal(draft.attachment.sha256,fixture.sha256);assert.equal(draft.attachment.extension,fixture.extension);assert.equal(draft.attachment.kind,'audio');assert.equal(draft.attachment.transcriptEdited,false);
    assert(/Beijing/i.test(draft.text)&&/12|twelve/i.test(draft.text));
    assert.equal(createHash('sha256').update(fs.readFileSync(fixture.path)).digest('hex'),fixture.sha256);
    entries.push({fixture,attachment:draft.attachment,transcript:draft.text});
    pass('Actual '+fixture.extension.toUpperCase()+' decodes in Windows WebView and transcribes on the local CPU',{attachment:draft.attachment,text:draft.text});
  }
  assert.equal((await rpc('document_attachments_list',{conversationId})).length,0);
  write('actual-transcripts.json',entries);await page.screenshot({path:path.join(root,'actual-four-format-drafts.png')});
  await page.locator('textarea').fill('这是实际音频格式验收。请分别调用 attachment_read 读取本轮四个音频附件的转写，最终逐个给出实际文件名、提到的城市和缩放级别。只读取这些附件，不下载、不规划，不使用其他工具。');
  await page.locator('textarea').press('Enter');
  const deadline=Date.now()+180000;let chat,final;
  while(Date.now()<deadline){chat=(await state()).chats.find(chat=>chat.conversationId===conversationId);final=chat?.display?.find(item=>item.role==='assistant'&&item.phase==='final');if(final)break;await delay(1000);}
  assert(final,'Real model did not finish');
  write('actual-model-chat.json',chat);
  const reads=chat.display.filter(item=>item.toolName==='attachment_read');assert(reads.length>=4);
  for(const entry of entries){assert(final.content.includes(entry.fixture.name));assert(reads.some(item=>JSON.stringify(item).includes(entry.attachment.id)));const published=await rpc('document_attachment_read',{conversationId,id:entry.attachment.id});assert.equal(published.text,entry.transcript);}
  assert(/Beijing|北京/.test(final.content)&&/12|十二|twelve/.test(final.content));
  await page.screenshot({path:path.join(root,'actual-real-model-four-format-answer.png')});
  pass('Real Codex and DeepSeek read all four transcripts through actual attachment tools',{conversationId,readCount:reads.length,final:final.content});
  await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  for(const entry of entries){assert.equal((await rpc('document_attachment_read',{conversationId,id:entry.attachment.id})).text,entry.transcript);await assert.rejects(rpc('document_attachment_read',{conversationId:randomUUID(),id:entry.attachment.id}),error=>error.code==='ATTACHMENT_NOT_FOUND');}
  pass('Four published transcripts survive WebView reload and remain isolated to their conversation');
  report.passed=true;
}catch(error){report.error={code:error.code,message:error.message,stack:error.stack};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(settings)await rpc('audio_settings_set',{model:settings.model,language:settings.language}).catch(error=>{report.restoreError=error;process.exitCode=1;});
  if(original&&conversationId){
    const actual=(await state()).chats.find(chat=>chat.conversationId===conversationId);if(actual)write('archived-qa-chat.json',actual);
    await page.evaluate(async({original,conversationId,appearance})=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,original.userId);if(original.chats.some(chat=>chat.conversationId===conversationId))throw new Error('Refusing original conversation removal');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(chat=>chat.conversationId!==conversationId)));store.setItem('geod-agent-active-conversation-0.1',original.active);await flushLocalState();if(appearance.language)setLanguagePreferences(JSON.parse(appearance.language));else{setLanguagePreferences({language:'system',replyLanguage:'auto'});localStorage.removeItem('geod-agent-language-v1');}document.documentElement.dataset.theme=appearance.theme;document.documentElement.style.colorScheme=appearance.theme;},{original,conversationId,appearance});
    await page.reload();await page.locator('.conversation-account-trigger').waitFor();
    const restored=await state(),byId=new Map(restored.chats.map(chat=>[chat.conversationId,chat]));assert.equal(restored.chats.length,original.chats.length);assert.equal(restored.active,original.active);for(const expected of original.chats)assert.deepEqual(byId.get(expected.conversationId),expected);assert.deepEqual((await rpc('ai_channels_list')).default,selection);const current=await rpc('audio_settings_get');assert.equal(current.model,settings.model);assert.equal(current.language,settings.language);
    pass('Owned QA sidebar record is archived and removed; original conversations, active selection and audio settings match',{originalConversations:original.chats.length});
  }
  write('result.json',report);await browser.close();
}
