/** Actual native catalogue, production UI and real sponsored model acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const root=path.resolve('artifacts/product-gaps-20261004/sponsored-channels'),mode=process.argv[2];
assert(['native','model'].includes(mode));
const stateFile=path.join(root,'restart-state.json'),reportFile=path.join(root,mode+'-result.json');
let saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
const report={passed:false,cases:[]};
const save=()=>fs.writeFileSync(stateFile,JSON.stringify(saved,null,2));
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,200));}
assert(page);
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!value.ok)throw value.error;return value.value;};
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(check,label,ms=30000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,400));}throw new Error('Timeout '+label);};
const notify=()=>page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
const Database=createRequire(path.resolve('services/geod-agent-model-gateway/server.mjs'))('better-sqlite3');
const rows=()=>{const db=new Database(path.join(root,'gateway.sqlite'),{readonly:true});try{return db.prepare('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,cached_input_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code FROM model_generations ORDER BY created_at').all();}finally{db.close()}};
const actualRows=()=>rows().filter(row=>row.conversation_id===saved.conversationId);

try{
 await page.locator('.conversation-account-trigger').waitFor();
 if(mode==='native'){
  assert(!saved||(process.argv.includes('--resume-native')&&!saved.conversationId),'Inspect and finish the recorded sponsorship state before another native setup');
  const original=await state(),originalList=await rpc('ai_channels_list');assert.equal(original.chats.length,30);
  if(!saved){fs.writeFileSync(path.join(root,'original-conversations.json'),JSON.stringify(original.chats,null,2));saved={userId:original.userId,originalActive:original.active,baselineChatIds:original.chats.map(c=>c.conversationId),originalDefault:originalList.default,qaConversationIds:[],settings:await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}))};save();}
  else {assert.deepEqual(originalList.default,saved.originalDefault);fs.copyFileSync(reportFile,path.join(root,'native-initial-failed-result.json'));}
  const catalogue=await rpc('ai_sponsors_refresh',{force:true});assert.equal(catalogue.sponsors.length,3);assert(!catalogue.sponsors.some(s=>s.id==='qa-hidden'));assert(!JSON.stringify(catalogue).includes('apiKey'));assert(!JSON.stringify(catalogue).includes('baseUrl'));assert(catalogue.sponsors.every(s=>s.billingScope==='sponsored'));
  saved.sponsor=catalogue.sponsors.find(s=>s.id==='qa-sponsored');assert(!saved.sponsor.usage.quotaEnforced);assert.equal(saved.sponsor.usage.remainingTokens,null);save();
  pass('Actual authenticated gateway catalogue hides the other account route and keys, while ordinary sponsored testing remains unlimited',{visibleProviders:catalogue.sponsors.map(s=>s.id)});
  await assert.rejects(rpc('ai_model_select',{conversationId:'default',channelId:'sponsor:qa-disabled',modelId:'deepseek-flash'}),e=>e.code==='SPONSOR_DISABLED');
  await assert.rejects(rpc('ai_model_select',{conversationId:'default',channelId:'sponsor:qa-hidden',modelId:'deepseek-flash'}),e=>e.code==='SPONSOR_UNAVAILABLE');
  await assert.rejects(rpc('ai_model_select',{conversationId:'default',channelId:'sponsor:qa-sponsored',modelId:'missing'}),e=>e.code==='SPONSOR_MODEL_MISSING');
  await assert.rejects(rpc('ai_sponsor_open_website',{id:'qa-hidden'}),e=>e.code==='SPONSOR_WEBSITE_UNAVAILABLE');
  assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);
  pass('Missing, disabled and unknown sponsored capabilities return typed native errors without changing the original selection');
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'});await page.setViewportSize({width:1000,height:720});
  const section=page.locator('.ai-channels-page');if(!await section.isVisible()){await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'模型与渠道',exact:true}).click();}
  await section.waitFor({state:'visible'});await page.getByRole('button',{name:'刷新赞助渠道',exact:true}).click();await wait(()=>page.locator('.ai-sponsor-row').count().then(n=>n===3),'Real sponsorship rows');await wait(()=>page.getByRole('button',{name:'刷新赞助渠道',exact:true}).isEnabled(),'Catalogue refresh completes');
  for(const [theme,language]of [['dark','zh-CN'],['light','en']]){
   await page.evaluate(async({theme,language})=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language});document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme},{theme,language});
   const button=page.locator('.ai-sponsor-row').first().locator('button').last();await wait(()=>button.isEnabled(),'Real default action is enabled');await button.focus();await page.waitForTimeout(450);
   const layout=await section.evaluate(el=>{const luminance=c=>{const v=c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]};const controls=[...el.querySelectorAll('.ai-sponsor-row button:not(:disabled)')].map(button=>{let parent=button,bg;while(parent){bg=getComputedStyle(parent).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)'&&bg!=='transparent')break;parent=parent.parentElement}const fg=getComputedStyle(button).color,a=luminance(fg),b=luminance(bg);return{text:button.textContent.trim(),contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}});return{documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,keyboardFocus:el.contains(document.activeElement),controls}});
   assert(layout.documentWidth<=layout.viewport);assert(layout.keyboardFocus);assert(layout.controls.every(c=>c.contrast>=4.5),JSON.stringify(layout));
   await page.screenshot({path:path.join(root,'actual-sponsored-channels-'+theme+'-'+language+'-1000.png')});pass('Actual '+theme+' '+language+' sponsorship UI has no horizontal overflow and readable focused actions',layout);
  }
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'});
  await page.locator('.ai-sponsor-row').first().getByRole('button',{name:'设为默认',exact:true}).click();await wait(async()=>((await rpc('ai_channels_list')).default.channelId==='sponsor:qa-sponsored'),'Real sponsored default');
  await page.getByRole('button',{name:'返回对话',exact:true}).click();const before=new Set((await state()).chats.map(c=>c.conversationId));await page.locator('.sidebar-new-chat').click();
  saved.conversationId=await wait(async()=>(await state()).chats.find(c=>!before.has(c.conversationId))?.conversationId,'Owned QA conversation');saved.qaConversationIds=[saved.conversationId];save();
  const workspace=await rpc('workspace_get',{conversationId:saved.conversationId});await rpc('workspace_set',{conversationId:saved.conversationId,directory:workspace.directory,permission:'fullAccess'});
  assert.equal((await rpc('ai_model_selection',{conversationId:saved.conversationId})).channelId,'sponsor:qa-sponsored');
  await rpc('ai_model_select',{conversationId:'default',...saved.originalDefault});
  saved.marker='SPONSOR_'+randomUUID().replaceAll('-','')+'.geojson';saved.markerFile=path.join(workspace.directory,saved.marker);
  const data=JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{kind:'sponsorship acceptance'},geometry:{type:'Polygon',coordinates:[[[116,39],[116.001,39],[116.001,39.001],[116,39]]]}}]});
  fs.writeFileSync(saved.markerFile,data,{flag:'wx'});saved.markerSha=createHash('sha256').update(data).digest('hex');save();
  await page.reload();await page.locator('.conversation-account-trigger').waitFor();await wait(()=>page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled(),'Connected sponsored composer');
  assert((await page.locator('.prompt-input-model-trigger').textContent()).includes('赞助'));
  pass('Production default creates a sponsored conversation, and the compact composer identifies sponsorship without a key form',{conversationId:saved.conversationId});
  report.passed=true;fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
 }else{
  assert(saved);assert(JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).passed);
  const id=saved.conversationId;assert.equal((await state()).active,id);assert(!(await rpc('background_status')).activeAiTurns);
  await rpc('ai_model_select',{conversationId:id,channelId:'sponsor:qa-limited',modelId:'deepseek-flash'});
  const quota=await page.evaluate(async id=>{const {runCodexTurn}=await import('/src/codex-client.ts');try{await runCodexTurn(crypto.randomUUID(),id,'仅回复赞助额度边界验收',[],{onEvent:()=>{},onModel:()=>{},onGeneration:()=>{},onRequest:async()=>({decision:'decline'}),execute:async()=>({result:{error:'Unexpected tool'}})});return{unexpectedSuccess:true}}catch(error){return{message:error.message,code:error.code}}},id);
  fs.writeFileSync(path.join(root,'actual-limited-native-error.json'),JSON.stringify(quota,null,2));assert(!quota.unexpectedSuccess);assert(quota.message.includes('赞助')&&quota.message.includes('额度'),JSON.stringify(quota));assert.equal(actualRows().length,0);
  pass('Actual Codex sponsor request reaches the enforced QA budget and fails before any upstream generation, with no hosted fallback',{error:quota});
  await rpc('ai_model_select',{conversationId:id,channelId:'sponsor:qa-sponsored',modelId:'deepseek-flash'});await notify();await wait(()=>page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled(),'Ready real-model composer');
  const prompt='只调用一次 workspace_gis_files_list，读取当前工作区实际的 GeoJSON 文件名。最终只回复实际列表中 SPONSOR_ 开头的完整文件名，不使用其他工具，不运行命令。';assert(!prompt.includes(saved.marker));saved.modelPrompt=prompt;save();
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await wait(()=>actualRows().find(row=>row.state==='streaming'),'Real upstream generation starts',60000);
  await rpc('ai_model_select',{conversationId:id,channelId:'hosted',modelId:'hosted'});saved.selectionChangedDuringTurn=true;save();
  const chat=await wait(async()=>{const value=(await state()).chats.find(c=>c.conversationId===id);return value&&!value.pendingId&&value.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?value:null},'Actual sponsored model tool response',230000);
  fs.writeFileSync(path.join(root,'actual-foreground-chat.json'),JSON.stringify(chat,null,2));assert(chat.messages.at(-1).content.includes(saved.marker));assert(chat.display.some(item=>item.toolName==='workspace_gis_files_list'&&item.toolStatus==='success'));assert(chat.codexContext.inputTokens>0);
  const generations=actualRows();assert(generations.length>=2);assert(generations.every(r=>r.state==='settled'&&r.funding_scope==='sponsored'&&r.sponsor_id==='qa-sponsored'&&r.sponsor_revision===saved.sponsor.revision&&r.model==='deepseek-flash'&&r.upstream_request_id));
  fs.writeFileSync(path.join(root,'actual-foreground-ledger.json'),JSON.stringify(generations,null,2));await page.screenshot({path:path.join(root,'actual-sponsored-model-dark-1000.png')});
  pass('Actual Codex and DeepSeek read an unprompted workspace filename; every tool round keeps the captured sponsor after changing the saved conversation selection',{actualAnswer:chat.messages.at(-1).content,generations:generations.length,inputTokens:generations.reduce((sum,r)=>sum+r.input_tokens,0)});
  await rpc('ai_model_select',{conversationId:id,channelId:'sponsor:qa-sponsored',modelId:'deepseek-flash'});
  const schedule=await rpc('ai_schedules_create',{conversationId:id,name:'Actual sponsored closed-window QA',prompt,nextRunAt:new Date(Date.now()+9000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;save();
  await rpc('ai_model_select',{conversationId:id,channelId:'hosted',modelId:'hosted'});assert.equal((await rpc('background_status')).activeAiTurns,0);
  await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState()});
  await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close()}).catch(e=>{if(!e.message.includes('closed'))throw e});
  pass('Owned scheduled turn captures sponsorship before switching the conversation; actual desktop closes before it is due',{scheduleId:saved.scheduleId});report.passed=true;fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
 }
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(reportFile,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,mode+'-failure.png')}).catch(()=>{});throw error;}
finally{await browser.close().catch(()=>{})}
