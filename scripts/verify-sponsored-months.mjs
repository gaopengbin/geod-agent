/** Calendar-month sponsorship through the actual native app, UI and model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const root=path.resolve('artifacts/product-gaps-20261004/sponsored-months');
const mode=process.argv[2];assert(['native','model','prepare','finish','cleanup','restored'].includes(mode));
const stateFile=path.join(root,'restart-state.json'),reportFile=path.join(root,mode+'-result.json');
let saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
const report=mode==='native'&&process.argv.includes('--resume-conversation')?JSON.parse(fs.readFileSync(reportFile,'utf8')):{passed:false,cases:[],rendererErrors:[]};
if(process.argv.includes('--resume-conversation')){fs.copyFileSync(reportFile,path.join(root,'native-workspace-initial-failed-result.json'));delete report.error;report.passed=false}
if(mode==='finish'&&fs.existsSync(reportFile)&&!fs.existsSync(path.join(root,'finish-initial-failed-result.json')))fs.copyFileSync(reportFile,path.join(root,'finish-initial-failed-result.json'));
if(mode==='restored'&&fs.existsSync(reportFile)&&!fs.existsSync(path.join(root,'restored-initial-failed-result.json')))fs.copyFileSync(reportFile,path.join(root,'restored-initial-failed-result.json'));
report.failedResponses=[];
const write=(file,value)=>fs.writeFileSync(path.join(root,file),JSON.stringify(value,null,2));
const save=()=>write('restart-state.json',saved);
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});write(mode+'-result.json',report);console.log(JSON.stringify({name,passed:true}));};
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const Database=createRequire(path.resolve('services/geod-agent-model-gateway/server.mjs'))('better-sqlite3');
const ledger=()=>{const db=new Database(path.join(root,'gateway.sqlite'),{readonly:true});try{return db.prepare('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,cached_input_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code,created_at FROM model_generations ORDER BY created_at,generation_id').all()}finally{db.close()}};
const channelFile=path.join(process.env.APPDATA,'dev.geod-agent.desktop/ai-channels/channels.sqlite');
const changeCache=change=>{const db=new Database(channelFile);try{const row=db.prepare('SELECT body FROM sponsored_catalog WHERE owner=?').get(saved.userId);assert(row);const body=JSON.parse(row.body);change(body);db.prepare('UPDATE sponsored_catalog SET body=?,updated_at=? WHERE owner=?').run(JSON.stringify(body),new Date().toISOString(),saved.userId)}finally{db.close()}};
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,200));}assert(page);
page.on('console',message=>{if(message.type()==='error')report.rendererErrors.push({message:message.text(),location:message.location()})});page.on('pageerror',error=>report.rendererErrors.push({message:error.message}));
page.on('response',response=>{if(response.status()>=400){const url=new URL(response.url());url.search='';url.hash='';report.failedResponses.push({url:url.href,status:response.status()})}});
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!value.ok)throw value.error;return value.value;};
const local=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]')};});
const wait=async(check,label,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,350));}throw new Error('Timeout '+label);};
const notify=()=>page.evaluate(()=>window.dispatchEvent(new Event('geod:ai-channels-changed')));
const language=async value=>{await page.evaluate(async language=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language})},value);await page.waitForTimeout(150)};
const theme=async value=>{if(await page.evaluate(()=>document.documentElement.dataset.theme)!==value){await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:value==='light'?/^(浅色外观|Light appearance)$/:/^(深色外观|Dark appearance)$/,exact:true}).click();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,value)}};
const channels=async()=>{if(!await page.locator('.ai-channels-page').isVisible()){await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:/^(模型与渠道|Models & Channels)$/,exact:true}).click();}await page.locator('.ai-channels-page').waitFor();await wait(()=>page.locator('.ai-sponsor-row').count().then(n=>n===3),'Owned sponsored rows')};
const returnChat=()=>page.getByRole('button',{name:/^(返回对话|Back to conversation)$/,exact:true}).click();
const windows=()=>{const start=new Date();start.setUTCDate(1);start.setUTCHours(0,0,0,0);const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);return{start:start.toISOString(),end:end.toISOString()}};
const oldWindow=()=>{const end=new Date(windows().start),start=new Date(end);start.setUTCMonth(start.getUTCMonth()-1);return{start:start.toISOString(),end:end.toISOString()}};
const month=usage=>{const current=windows();assert.equal(usage.budgetPeriod,'month');assert.equal(usage.periodStart,current.start);assert.equal(usage.periodEnd,current.end);assert.equal(usage.priorReservedTokens,0)};
try{
 if(process.argv.includes('--reload'))await page.reload();
 await page.locator('.conversation-account-trigger').waitFor();
 if(mode==='native'){
  assert(!saved||(process.argv.includes('--resume-native')&&!saved.conversationId)||(process.argv.includes('--resume-conversation')&&saved.conversationId&&!saved.marker),'Do not overwrite an existing acceptance state');
  if(!saved?.conversationId){
  const original=await local(),list=await rpc('ai_channels_list');assert.equal(original.chats.length,30);
  if(!saved){write('original-conversations.json',original.chats);saved={userId:original.userId,originalActive:original.active,originalDefault:list.default,baselineChatIds:original.chats.map(c=>c.conversationId),qaConversationIds:[],settings:await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}))};save()}
  else{assert.deepEqual(list.default,saved.originalDefault);fs.copyFileSync(reportFile,path.join(root,'native-initial-failed-result.json'))}
  const catalogue=await rpc('ai_sponsors_refresh',{force:true});assert.equal(catalogue.sponsors.length,3);assert(!catalogue.sponsors.some(s=>s.id==='qa-hidden'));assert(!JSON.stringify(catalogue).includes('apiKey'));catalogue.sponsors.forEach(s=>month(s.usage));
  saved.sponsor=catalogue.sponsors.find(s=>s.id==='qa-sponsored');assert(!saved.sponsor.usage.quotaEnforced);assert.equal(saved.sponsor.usage.remainingTokens,null);save();
  const hosted=await rpc('agent_usage');assert.equal(hosted.quotaEnforced,false);assert.equal(hosted.committedTokens,0);
  pass('Actual account-owned monthly catalogue uses authoritative UTC bounds and leaves ordinary testing unlimited',{sponsors:catalogue.sponsors.map(s=>s.id),usage:saved.sponsor.usage,hosted});
  const expired=oldWindow();changeCache(body=>body.sponsors.forEach(s=>Object.assign(s.usage,{periodStart:expired.start,periodEnd:expired.end,committedTokens:919191})));
  const refreshed=await rpc('ai_sponsors_refresh',{force:false});refreshed.sponsors.forEach(s=>{month(s.usage);assert.equal(s.usage.committedTokens,0)});
  pass('A simulated expired month bypasses the native five-minute cache and fetches real authoritative usage',{simulatedPeriod:expired,returnedPeriod:refreshed.sponsors[0].usage.periodStart});
  await language('zh-CN');await theme('dark');await page.setViewportSize({width:1000,height:720});await channels();
  changeCache(body=>body.sponsors.forEach(s=>Object.assign(s.usage,{periodStart:expired.start,periodEnd:expired.end,committedTokens:919191})));
  await notify();await wait(async()=>{const list=await rpc('ai_channels_list');return list.sponsors.every(s=>s.usage.periodStart===windows().start)&&!(await page.locator('.ai-sponsor-row').first().textContent()).includes('919')},'Real page automatic calendar refresh');
  pass('The open production channel page replaces an expired month automatically without another click',{simulatedCacheExpiry:true});
  for(const [appearance,locale]of [['dark','zh-CN'],['light','en']]){
   await language(locale);await theme(appearance);await wait(()=>page.locator('.ai-sponsor-row').first().textContent().then(text=>text.includes('UTC')&&(locale==='en'?text.includes('Used this month'):text.includes('本月已用'))),'Localized monthly usage');
   const button=page.locator('.ai-sponsor-row').first().getByRole('button',{name:/^(设为默认|Set as default)$/,exact:true});await button.focus();await page.waitForTimeout(500);
   const layout=await page.locator('.ai-channels-page').evaluate(el=>{const luminance=c=>{const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]};const controls=[...el.querySelectorAll('.ai-sponsor-row button:not(:disabled)')].map(button=>{let parent=button,bg;while(parent){bg=getComputedStyle(parent).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)'&&bg!=='transparent')break;parent=parent.parentElement}const fg=getComputedStyle(button).color,a=luminance(fg),b=luminance(bg);return{text:button.textContent.trim(),contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}});return{documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,keyboardFocus:el.contains(document.activeElement),controls}});
   assert(layout.documentWidth<=layout.viewport);assert(layout.keyboardFocus);assert(layout.controls.every(c=>c.contrast>=4.5),JSON.stringify(layout));
   await page.screenshot({path:path.join(root,'actual-month-'+appearance+'-'+locale+'-1000.png')});pass('Actual '+appearance+' '+locale+' monthly usage is readable and fits a narrow window',layout);
  }
  await language('zh-CN');await theme('dark');await returnChat();const before=new Set((await local()).chats.map(c=>c.conversationId));await page.locator('.sidebar-new-chat').click();
  saved.conversationId=await wait(async()=>(await local()).chats.find(c=>!before.has(c.conversationId))?.conversationId,'Owned QA conversation');saved.qaConversationIds=[saved.conversationId];save();
  }
  const workspace=await rpc('workspace_get',{conversationId:saved.conversationId});saved.workspace=workspace.directory;await rpc('workspace_set',{conversationId:saved.conversationId,directory:workspace.directory,permission:'fullAccess'});
  saved.marker='MONTH_'+randomUUID().replaceAll('-','')+'.geojson';saved.markerFile=path.join(saved.workspace,saved.marker);fs.writeFileSync(saved.markerFile,JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{kind:'monthly sponsor acceptance'},geometry:{type:'Polygon',coordinates:[[[116,39],[116.001,39],[116.001,39.001],[116,39]]]}}]}),{flag:'wx'});saved.markerSha=sha(saved.markerFile);save();
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'sponsor:qa-sponsored',modelId:'deepseek-flash'});await notify();await page.reload();await page.locator('.conversation-account-trigger').waitFor();await wait(()=>page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled(),'Monthly sponsored composer');
  assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);pass('Only the owned QA conversation selects sponsorship; the original default remains unchanged');
 }else if(mode==='model'){
  assert(saved);assert(JSON.parse(fs.readFileSync(path.join(root,'native-result.json'),'utf8')).passed);
  const id=saved.conversationId;assert.equal((await local()).active,id);assert.equal((await rpc('background_status')).activeAiTurns,0);
  await rpc('ai_model_select',{conversationId:id,channelId:'sponsor:qa-limited',modelId:'deepseek-flash'});
  const error=await page.evaluate(async id=>{const {runCodexTurn}=await import('/src/codex-client.ts');try{await runCodexTurn(crypto.randomUUID(),id,'仅回复月度额度边界验收',[],{onEvent:()=>{},onModel:()=>{},onGeneration:()=>{},onRequest:async()=>({decision:'decline'}),execute:async()=>({result:{error:'Unexpected tool'}})});return{unexpectedSuccess:true}}catch(error){return{message:error.message,code:error.code}}},id);
  write('actual-month-quota-error.json',error);assert(!error.unexpectedSuccess);assert(error.message.includes('赞助')&&error.message.includes('额度'),JSON.stringify(error));assert.equal(ledger().length,0);pass('The 32-token monthly QA channel refuses before the real provider and does not fall back to hosted',{error});
  await rpc('ai_model_select',{conversationId:id,channelId:'sponsor:qa-sponsored',modelId:'deepseek-flash'});await notify();
  const prompt='只调用一次 workspace_boundaries_list，读取当前工作区实际的 GeoJSON 边界文件名。最终只回复实际列表中 MONTH_ 开头的完整文件名，不使用其他工具，不运行命令。';assert(!prompt.includes(saved.marker));saved.modelPrompt=prompt;save();
  await wait(()=>page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled(),'Sponsored composer');await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const chat=await wait(async()=>{const value=(await local()).chats.find(c=>c.conversationId===id);return value&&!value.pendingId&&value.messages.at(-1)?.role==='assistant'&&!await page.getByRole('button',{name:'停止回复',exact:true}).count()?value:null},'Actual monthly sponsored model tool response',240000);
  write('actual-foreground-chat.json',chat);assert(chat.messages.at(-1).content.includes(saved.marker));assert(chat.display.some(i=>i.toolName==='workspace_boundaries_list'&&i.toolStatus==='success'));
  const actual=ledger();assert(actual.length>=2);assert(actual.every(r=>r.state==='settled'&&r.funding_scope==='sponsored'&&r.sponsor_id==='qa-sponsored'&&r.sponsor_revision===saved.sponsor.revision&&r.upstream_request_id));write('actual-foreground-ledger.json',actual);await page.screenshot({path:path.join(root,'actual-month-model-dark-1000.png')});
  pass('Actual Codex and DeepSeek read the random filename through the tool and settle in the current sponsor month',{generations:actual.length,actualAnswer:chat.messages.at(-1).content,tokens:actual.reduce((n,r)=>n+r.input_tokens+r.output_tokens,0)});
  const schedule=await rpc('ai_schedules_create',{conversationId:id,name:'Calendar sponsorship closed-window acceptance',prompt,nextRunAt:new Date(Date.now()+12000).toISOString(),repeatSeconds:null,executionId:randomUUID()});saved.scheduleId=schedule.scheduleId;save();
  await rpc('ai_model_select',{conversationId:id,channelId:'hosted',modelId:'hosted'});await page.evaluate(async()=>{const {flushLocalState}=await import('/src/local-state.ts');await flushLocalState()});
  await page.evaluate(async()=>{const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close()}).catch(error=>{if(!error.message.includes('closed'))throw error});
  pass('Actual desktop closes before the scheduled turn; the saved route retains its monthly sponsor snapshot',{scheduleId:saved.scheduleId});
 }else if(mode==='prepare'){
  assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});assert.equal((await rpc('background_status')).activeAiTurns,0);
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'sponsor:qa-sponsored',modelId:'deepseek-flash'});
  const catalogue=await rpc('ai_sponsors_refresh',{force:true}),sponsor=catalogue.sponsors.find(s=>s.id==='qa-sponsored'),actual=ledger(),total=actual.reduce((n,r)=>n+r.input_tokens+r.output_tokens,0);month(sponsor.usage);assert.equal(sponsor.usage.committedTokens,total);assert.equal(sponsor.usage.reservedTokens,0);
  const usage=await rpc('agent_usage');assert.equal(usage.committedTokens,0);assert.equal(usage.reservedTokens,0);saved.preRestart={catalogue,actual,usage};save();pass('Current-month usage equals every actual foreground and headless provider receipt; hosted usage remains zero',{actualTokens:total,generations:actual.length});
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords())});assert(backup.verified);saved.backup=backup;save();
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));for(const record of manifest.records)assert.equal(sha(path.join(backup.path,record.file)),record.sha256);
  const record=manifest.records.find(r=>r.path==='ai-channels/channels.sqlite');assert(record);const db=new Database(path.join(backup.path,record.file),{readonly:true});try{const cached=JSON.parse(db.prepare('SELECT body FROM sponsored_catalog WHERE owner=?').get(saved.userId).body);assert.deepEqual(cached.sponsors,catalogue.sponsors);assert.equal(db.prepare('SELECT channel FROM selections WHERE owner=? AND conversation=?').get(saved.userId,saved.conversationId).channel,'sponsor:qa-sponsored')}finally{db.close()}
  pass('Full verified backup preserves exact calendar-month metadata and original provider history',{records:manifest.records.length,backupPath:backup.path});
 }else if(mode==='finish'){
  assert.deepEqual(ledger(),saved.preRestart.actual);const list=await rpc('ai_channels_list');assert.deepEqual(list.sponsors,saved.preRestart.catalogue.sponsors);assert.equal((await rpc('ai_model_selection',{conversationId:saved.conversationId})).channelId,'sponsor:qa-sponsored');assert.deepEqual(list.default,saved.originalDefault);
  const refreshed=await rpc('ai_sponsors_refresh',{force:true});assert.deepEqual(refreshed.sponsors,saved.preRestart.catalogue.sponsors);pass('Full native desktop and gateway restart preserve monthly totals, cached boundaries and account selections');
  await language('zh-CN');await theme('dark');await channels();await wait(()=>page.locator('.ai-sponsor-row').first().textContent().then(text=>text.includes('本月已用')&&text.includes('UTC')),'Restored month UI');await page.screenshot({path:path.join(root,'actual-month-restart-ui-dark-1000.png')});await returnChat();pass('Real restarted UI displays authoritative monthly use and the next UTC refresh');
 }else if(mode==='cleanup'){
  assert.equal((await rpc('background_status')).activeAiTurns,0);await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});await rpc('ai_model_select',{conversationId:'default',...saved.originalDefault});
  const archive=(await local()).chats.filter(c=>saved.qaConversationIds.includes(c.conversationId));write('actual-qa-conversations.json',archive);assert.equal(sha(saved.markerFile),saved.markerSha);fs.unlinkSync(saved.markerFile);
  await language('zh-CN');await theme(saved.settings.theme);
  await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId),owned=new Set(saved.qaConversationIds);for(const id of owned)if(saved.baselineChatIds.includes(id))throw new Error('Refusing to remove an original conversation');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(c=>!owned.has(c.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);await flushLocalState();if(saved.settings.language)setLanguagePreferences(JSON.parse(saved.settings.language));else{setLanguagePreferences({language:'system',replyLanguage:'auto'});localStorage.removeItem('geod-agent-language-v1')}},saved);
  await page.setViewportSize({width:saved.settings.width,height:saved.settings.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();const restored=await local(),original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8'));assert.equal(restored.chats.length,30);assert.equal(restored.active,saved.originalActive);const map=new Map(restored.chats.map(c=>[c.conversationId,c]));for(const expected of original)assert.deepEqual(map.get(expected.conversationId),expected);assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);pass('The owned fixture and sidebar chat are removed; all 30 original chats, theme, language and selections are restored');
 }else{
  const catalogue=await rpc('ai_sponsors_refresh',{force:true});assert.equal(catalogue.sponsors.length,0);await notify();const list=await rpc('ai_channels_list');assert.equal(list.sponsors.length,0);assert.deepEqual(list.default,saved.originalDefault);
  await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:/^(模型与渠道|Models & Channels)$/,exact:true}).click();await page.locator('.ai-channels-page').waitFor();await wait(()=>page.locator('.ai-sponsors-empty').textContent().then(text=>/当前账号暂无赞助渠道|No sponsored channels/.test(text)),'Actual empty legacy sponsorship page');assert.equal(await page.locator('.ai-sponsor-row').count(),0);await page.screenshot({path:path.join(root,'actual-restored-legacy-channels.png')});await returnChat();
  const actual=await local(),original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8'));assert.equal(actual.chats.length,30);assert.equal(actual.active,saved.originalActive);const map=new Map(actual.chats.map(c=>[c.conversationId,c]));for(const expected of original)assert.deepEqual(map.get(expected.conversationId),expected);
  const settings=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme}));assert.equal(settings.language,saved.settings.language);assert.equal(settings.theme,saved.settings.theme);assert(!fs.existsSync(saved.markerFile));assert.equal((await rpc('background_status')).activeAiTurns,0);
  pass('The ordinary development gateway clears QA sponsorship; original chats, default and preferences remain exact');
 }
 assert.equal(report.rendererErrors.length,0,'Actual renderer emitted errors');report.passed=true;write(mode+'-result.json',report);
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};write(mode+'-result.json',report);await page.screenshot({path:path.join(root,mode+'-failure.png')}).catch(()=>{});throw error}
finally{await browser.close().catch(()=>{})}
