/** Real native storage + Codex document tools + actual composer and queue. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const playwright='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(playwright).href);
const output=path.resolve('artifacts/product-gaps-20261004/documents'),workspace=path.join(output,'workspace');
const markers=JSON.parse(fs.readFileSync(path.join(output,'fixture-markers.json'),'utf8'));
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
await page.locator('.conversation-account-trigger').waitFor();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(e){return{error:{code:e?.code,message:e?.message??String(e)}};}},{command,args});if(value.error)throw Object.assign(new Error(value.error.message),{code:value.error.code});return value.value;};
const conversationId=randomUUID(),forkId=randomUUID();let uiId,scheduleId,original,report={passed:false,cases:[]};
function record(name,details={}){report.cases.push({name,passed:true,...details});fs.writeFileSync(path.join(output,'native-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));}
async function rejects(command,args,code){let failure;try{await rpc(command,args);}catch(error){failure=error;}assert.equal(failure?.code,code,failure?.message);return failure.code;}
async function turn(id,input,documents=[]){
  const value=await page.evaluate(async p=>{
    const {api}=await import('/src/api.ts'),{runCodexTurn}=await import('/src/codex-client.ts'),tools=[],generations=[];
    const result=await runCodexTurn(crypto.randomUUID(),p.id,p.input,[],{onEvent:()=>{},onModel:()=>{},onGeneration:g=>generations.push({generationId:g.generationId,state:g.state,inputTokens:g.inputTokens,outputTokens:g.outputTokens}),onRequest:async()=>({decision:'decline'}),execute:async call=>{
      const args=JSON.parse(call.function.arguments);let result;
      if(call.function.name==='attachment_list')result=await api.documentAttachmentsList(p.id);
      else if(call.function.name==='attachment_read')result=await api.documentAttachmentRead(p.id,args.id,args.offset,args.limit);
      else return{result:{error:'QA_DOCUMENT_TOOLS_ONLY'}};
      tools.push({name:call.function.name,arguments:args,result});return{result};
    }},[],p.documents);
    return{result,tools,generations};
  },{id,input,documents});
  assert.equal(value.result.status,'completed');assert(value.generations.every(g=>g.state==='settled'&&g.inputTokens>0));return value;
}
async function chatState(){return page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});}
try{
  assert.equal(await page.locator('.conversation-running-dot').count(),0);
  const initial=await rpc('background_status');assert.equal(initial.activeAiTurns,0);assert.equal(initial.activeDownloads,0);assert.equal(initial.activeCommands,0);
  original={...(await chatState()),...(await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})))};
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const documents=[];
  for(const name of ['影像说明.pdf','范围说明.docx','数据范围.xlsx','区域说明.pptx','参考说明.txt'])documents.push(await rpc('document_attachment_add',{conversationId,name,base64:fs.readFileSync(path.join(workspace,name)).toString('base64')}));
  assert.deepEqual(await rpc('document_attachments_list',{conversationId}),[]);
  await rejects('document_attachment_read',{conversationId,id:documents[0].id},'ATTACHMENT_NOT_FOUND');
  await rejects('document_attachment_read',{conversationId:randomUUID(),id:documents[0].id},'ATTACHMENT_NOT_FOUND');
  await rejects('document_attachment_add',{conversationId,name:'execute.ps1',base64:Buffer.from('not executed').toString('base64')},'ATTACHMENT_FORMAT');
  await rejects('document_attachment_add',{conversationId,name:'加密.pdf',base64:fs.readFileSync(path.join(workspace,'加密.pdf')).toString('base64')},'ATTACHMENT_PASSWORD_REQUIRED');
  const empty=await rpc('document_attachment_add',{conversationId,name:'扫描或空白.pdf',base64:fs.readFileSync(path.join(workspace,'扫描或空白.pdf')).toString('base64')});assert.equal(empty.characters,0);assert(empty.warnings.includes('SCANNED_OR_EMPTY_PDF'));
  record('Actual native parsing, unpublished draft isolation, cross-conversation denial and honest file errors',{documents,empty});
  const input='实际附件读取验收。请使用 attachment_read 读取本轮全部附件。需要读到尾部；有 nextOffset 时继续读取。最终只列出文档内容里的全部 DOC_ 开头随机标记，不运行命令、不使用其他工具。';
  const model=await turn(conversationId,input+'\n本轮附件 ID：'+JSON.stringify(documents.map(file=>({id:file.id,name:file.name}))),documents);
  for(const marker of Object.values(markers))assert(model.result.text.includes(marker),model.result.text);
  assert(model.tools.some(tool=>tool.name==='attachment_read'&&tool.arguments.offset>0),'Long text was not paged');
  fs.writeFileSync(path.join(output,'actual-model-read.json'),JSON.stringify(model,null,2));
  record('Actual Codex/DeepSeek reads PDF, Word tables, sheets, reordered slides, notes and paged text',{threadId:model.result.threadId,toolCalls:model.tools.length,actualAnswer:model.result.text,generations:model.generations});
  await rejects('document_attachment_read',{conversationId,id:documents[0].id,limit:0},'ATTACHMENT_INPUT');
  const userId=original.userId,root=path.join(process.env.APPDATA,'dev.geod-agent.desktop','chat-attachments',createHash('sha256').update(`${userId}:${conversationId}`).digest('hex').slice(0,32));
  const textPath=path.join(root,documents[0].id+'.text'),savedText=fs.readFileSync(textPath);
  try{fs.appendFileSync(textPath,'altered fixture');await rejects('document_attachment_read',{conversationId,id:documents[0].id},'ATTACHMENT_INVALID');}finally{fs.writeFileSync(textPath,savedText);}
  record('Actual stored text integrity and read bounds enforced');
  await rpc('workspace_set',{conversationId:forkId,directory:workspace,permission:'fullAccess'});
  const fork=await rpc('codex_fork',{sourceConversationId:conversationId,conversationId:forkId,imageIds:[],documentIds:documents.map(file=>file.id)});assert.notEqual(fork.threadId,model.result.threadId);assert.equal(fork.documents.length,documents.length);
  const forkText=await rpc('document_attachment_read',{conversationId:forkId,id:documents[1].id});assert(forkText.text.includes(markers.word));
  const forkModel=await turn(forkId,`请重新调用 attachment_read 读取 ID ${documents[1].id} 的 Word 文档。只回复正文内的 DOC_ 随机标记。`);assert(forkModel.result.text.includes(markers.word));assert(forkModel.tools.some(tool=>tool.name==='attachment_read'));
  fs.writeFileSync(path.join(output,'actual-fork-read.json'),JSON.stringify(forkModel,null,2));record('Native fork copies scoped documents and real model rereads them',{threadId:fork.threadId,actualAnswer:forkModel.result.text});
  const schedule=await rpc('ai_schedules_create',{conversationId,name:'文档附件后台验收',prompt:'使用 attachment_list 找到范围说明.docx，再用 attachment_read 读取实际正文，最后只回复 DOC_ 开头的随机标记。不要使用其他工具。',nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});scheduleId=schedule.scheduleId;
  let scheduled;const until=Date.now()+180000;
  while(Date.now()<until){const overview=await rpc('ai_schedules_list',{conversationId}),run=overview.runs.find(run=>run.scheduleId===scheduleId);if(run&&!['queued','running'].includes(run.state)){scheduled=await rpc('ai_schedules_run_events',{runId:run.runId});break;}await new Promise(r=>setTimeout(r,1000));}
  assert.equal(scheduled?.run.state,'succeeded',JSON.stringify(scheduled?.run));assert(JSON.stringify(scheduled.events).includes(markers.word));fs.writeFileSync(path.join(output,'actual-background-read.json'),JSON.stringify(scheduled,null,2));record('Actual companion schedule reads published documents',{run:scheduled.run});
  // Actual composer uploads during an existing turn; attachment message queues
  // even in steer mode so the original turn cannot read unpublished drafts.
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.locator('.sidebar-new-chat').click();
  await page.waitForFunction(async old=>{const {localStateStore}=await import('/src/local-state.ts'),{accountChatStore}=await import('/src/pending-generations.ts'),{api}=await import('/src/api.ts');const auth=await api.authStatus();return accountChatStore(localStateStore,auth.userId).getItem('geod-agent-active-conversation-0.1')!==old;},original.active);
  uiId=(await chatState()).active;await rpc('ai_model_select',{conversationId:uiId,channelId:'hosted',modelId:'hosted'});await page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
  await page.locator('textarea').fill("界面附件排队验收：请先实际运行 powershell.exe -NoProfile -Command \"Start-Sleep -Seconds 12; Write-Output 'DOC_QUEUE_PARENT_END'\"，最后只回复实际输出标记。");await page.locator('textarea').press('Enter');
  await page.locator('.composer-followup-trigger').waitFor({timeout:30000});await page.locator('.composer-followup-trigger').click();await page.getByRole('button',{name:'补充指令',exact:false}).click();
  await page.locator('input[type=file][accept*=docx]').setInputFiles(path.join(workspace,'范围说明.docx'));
  await page.locator('.composer-documents .chat-document-chip').waitFor({timeout:60000});
  const uiDrafts=(await chatState()).chats.find(chat=>chat.conversationId===uiId);assert(uiDrafts);
  assert.deepEqual(await rpc('document_attachments_list',{conversationId:uiId}),[]);
  await page.locator('textarea').fill('读取刚附加的 Word 文档，调用 attachment_read，只回复实际正文内 DOC_ 开头的随机标记。');await page.locator('textarea').press('Enter');
  await page.locator('.message-queue-item').waitFor({timeout:5000});const queued=(await chatState()).chats.find(chat=>chat.conversationId===uiId)?.queuedInputs;assert.equal(queued?.[0].documents.length,1);
  record('Actual file picker pipeline and attachment queue preserve unpublished draft');
  await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),markers.word,{timeout:180000});
  await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:30000});
  const uiChat=(await chatState()).chats.find(chat=>chat.conversationId===uiId);assert(uiChat.display.some(item=>item.toolName==='attachment_read'));assert(uiChat.display.some(item=>item.role==='user'&&item.documents?.length===1));assert(!uiChat.queuedInputs?.length);
  fs.writeFileSync(path.join(output,'actual-ui-chat.json'),JSON.stringify(uiChat,null,2));
  await page.setViewportSize({width:1000,height:720});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await page.screenshot({path:path.join(output,'document-chat-dark-zh.png')});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});await page.screenshot({path:path.join(output,'document-chat-light-en.png')});
  record('Actual composer sends queued document; real model answer and native tool result persist',{conversationId:uiId,answer:markers.word});
  const uiState=await page.evaluate(async()=>{const {snapshotLocalRecords}=await import('/src/local-state.ts');return snapshotLocalRecords();});
  const backup=await rpc('desktop_backup_create',{uiState}),manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));
  assert.equal(manifest.chatAttachmentsIncluded,true);
  const owned=manifest.records.filter(record=>record.path.startsWith('chat-attachments/'+path.basename(root)+'/'));assert(owned.length>=documents.length*3);
  for(const record of owned){const data=fs.readFileSync(path.join(backup.path,record.file));assert.equal(createHash('sha256').update(data).digest('hex'),record.sha256);}
  record('Full native backup contains original documents, extracted text and ownership records',{backup,documentRecords:owned.length});
  assert.equal(errors.length,0,errors.join('\n'));report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false}).catch(()=>{});
  if(original&&uiId){
    await page.evaluate(async p=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const store=accountChatStore(localStateStore,p.original.userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(chat=>chat.conversationId!==p.uiId)));store.setItem('geod-agent-active-conversation-0.1',p.original.active);await flushLocalState();},{original,uiId}).catch(()=>{});
    await page.reload();await page.locator('.conversation-account-trigger').waitFor();const restored=await chatState();assert(original.chats.every(chat=>restored.chats.some(next=>next.conversationId===chat.conversationId)),'Original conversations changed');assert.equal(restored.active,original.active);
  }
  if(original){await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},original).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  fs.writeFileSync(path.join(output,'native-result.json'),JSON.stringify(report,null,2));await browser.close();
}
