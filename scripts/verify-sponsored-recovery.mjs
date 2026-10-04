/** Back up/restart actual sponsor records; then archive only the owned QA conversation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/sponsored-channels'),mode=process.argv[2];assert(['prepare','finish','cleanup'].includes(mode));
const file=path.join(root,'recovery-result.json'),savedFile=path.join(root,'restart-state.json'),saved=JSON.parse(fs.readFileSync(savedFile,'utf8'));
const report=mode==='prepare'?{passed:false,cases:[]}:JSON.parse(fs.readFileSync(file,'utf8'));
assert(JSON.parse(fs.readFileSync(path.join(root,'headless-result.json'),'utf8')).passed);
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;for(let i=0;i<100&&!page;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,200));}assert(page);
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!value.ok)throw value.error;return value.value;};
const save=()=>fs.writeFileSync(savedFile,JSON.stringify(saved,null,2)),pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const Database=createRequire(path.resolve('services/geod-agent-model-gateway/server.mjs'))('better-sqlite3');
const rows=()=>{const db=new Database(path.join(root,'gateway.sqlite'),{readonly:true});try{return db.prepare('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,cached_input_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code FROM model_generations ORDER BY created_at').all()}finally{db.close()}};
try{
 await page.locator('.conversation-account-trigger').waitFor();await rpc('ai_schedules_set_enabled',{scheduleId:saved.scheduleId,enabled:false});assert.equal((await rpc('background_status')).activeAiTurns,0);
 if(mode==='prepare'){
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'sponsor:qa-sponsored',modelId:'deepseek-flash'});
  const catalogue=await rpc('ai_sponsors_refresh',{force:true}),sponsor=catalogue.sponsors.find(s=>s.id==='qa-sponsored'),actual=rows(),total=actual.reduce((n,r)=>n+r.input_tokens+r.output_tokens,0);
  assert.equal(sponsor.usage.committedTokens,total);assert.equal(sponsor.usage.reservedTokens,0);assert.equal(sponsor.usage.remainingTokens,null);const usage=await rpc('agent_usage');assert.equal(usage.committedTokens,0);assert.equal(usage.reservedTokens,0);
  const generation=await rpc('agent_generation_get',{generationId:actual.at(-1).generation_id});assert.equal(generation.billingScope,'sponsored');assert.equal(generation.result.content,saved.marker);
  saved.preRestart={catalogue,actual,usage,generation};save();
  pass('Actual sponsored totals match provider input/output usage exactly and hosted committed/reserved usage stays zero',{actualTokens:total,generations:actual.length});
  const backup=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{snapshotLocalRecords}=await import('/src/local-state.ts');return api.desktopBackupCreate(await snapshotLocalRecords())});assert(backup.verified);saved.backup=backup;save();
  const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));for(const record of manifest.records)assert.equal(sha(path.join(backup.path,record.file)),record.sha256);
  const record=manifest.records.find(r=>r.path==='ai-channels/channels.sqlite');assert(record);const db=new Database(path.join(backup.path,record.file),{readonly:true});
  try{const cached=JSON.parse(db.prepare('SELECT body FROM sponsored_catalog WHERE owner=?').get(saved.userId).body);assert.deepEqual(cached.sponsors,catalogue.sponsors);assert.equal(db.prepare('SELECT channel FROM selections WHERE owner=? AND conversation=?').get(saved.userId,saved.conversationId).channel,'sponsor:qa-sponsored');assert(!db.prepare('SELECT owner FROM sponsored_catalog WHERE owner=?').get('different-qa-account'));}finally{db.close()}
  pass('Actual full backup preserves exact owned public sponsor metadata and selection without a client provider key',{records:manifest.records.length,backupPath:backup.path});
 }else if(mode==='finish'){
  assert.deepEqual(rows(),saved.preRestart.actual);
  const catalogue=(await rpc('ai_channels_list')).sponsors;assert.deepEqual(catalogue,saved.preRestart.catalogue.sponsors);assert.equal((await rpc('ai_model_selection',{conversationId:saved.conversationId})).channelId,'sponsor:qa-sponsored');
  const generation=await rpc('agent_generation_get',{generationId:saved.preRestart.generation.generationId});assert.deepEqual(generation,saved.preRestart.generation);
  pass('Full desktop, companion and isolated gateway restart preserve sponsored selection, public cache, actual usage and the encrypted generation result');
  const failure=await page.evaluate(async id=>{const {api}=await import('/src/api.ts');try{const result=await api.codexTurn(crypto.randomUUID(),id,'仅回复赞助配置版本验收',[],()=>{});return{unexpectedResult:result}}catch(error){return{code:error.code,message:error.message}}},saved.conversationId);
  assert.equal(failure.code,'SPONSOR_CHANGED',JSON.stringify(failure));assert.deepEqual(rows(),saved.preRestart.actual);fs.writeFileSync(path.join(root,'actual-stale-route-error.json'),JSON.stringify(failure,null,2));
  pass('Actual engine rejects a changed server sponsor revision before upstream submission, retaining the precise error and never falling back to hosted',{error:failure});
  const current=await rpc('ai_sponsors_refresh',{force:true});assert.notEqual(current.sponsors.find(s=>s.id==='qa-sponsored').revision,saved.sponsor.revision);
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'});await page.setViewportSize({width:1000,height:720});await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'模型与渠道',exact:true}).click();
  const pageText=page.locator('.ai-channels-page');await pageText.waitFor({state:'visible'});
  for(const [theme,language]of [['dark','zh-CN'],['light','en']]){
   await page.evaluate(async({theme,language})=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language});document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme},{theme,language});await page.waitForTimeout(450);
   const content=await pageText.textContent();assert(content.includes(language==='en'?'32 tokens available':'可用 32 token'));assert(!content.includes('0K tokens available'));if(language==='en')assert(content.includes('Unlimited quota')&&!content.includes('不限额度'));
   await page.screenshot({path:path.join(root,'actual-sponsored-channels-final-'+theme+'-'+language+'-1000.png')});
  }
  await page.getByRole('button',{name:'Back to conversation',exact:true}).click();pass('Actual final English and Chinese UI display a 32-token QA balance precisely and localize unlimited sponsorship correctly');
 }else{
  const catalogue=await rpc('ai_sponsors_refresh',{force:true});assert.equal(catalogue.sponsors.length,0);assert.equal((await rpc('background_status')).activeAiTurns,0);await rpc('ai_model_select',{conversationId:'default',...saved.originalDefault});
  const archive=await page.evaluate(async userId=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();return JSON.parse(accountChatStore(localStateStore,userId).getItem(CHAT_LIST_KEY)||'[]')},saved.userId);fs.writeFileSync(path.join(root,'actual-qa-conversations.json'),JSON.stringify(archive.filter(c=>saved.qaConversationIds.includes(c.conversationId)),null,2));
  assert.equal(sha(saved.markerFile),saved.markerSha);fs.unlinkSync(saved.markerFile);
  await page.evaluate(async saved=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{setLanguagePreferences}=await import('/src/i18n.ts');const store=accountChatStore(localStateStore,saved.userId),owned=new Set(saved.qaConversationIds);for(const id of owned)if(saved.baselineChatIds.includes(id))throw new Error('Refusing to remove an original conversation');store.setItem(CHAT_LIST_KEY,JSON.stringify(JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').filter(c=>!owned.has(c.conversationId))));store.setItem('geod-agent-active-conversation-0.1',saved.originalActive);await flushLocalState();if(saved.settings.language)setLanguagePreferences(JSON.parse(saved.settings.language));else{setLanguagePreferences({language:'system',replyLanguage:'auto'});localStorage.removeItem('geod-agent-language-v1');}document.documentElement.dataset.theme=saved.settings.theme;document.documentElement.style.colorScheme=saved.settings.theme},saved);await page.setViewportSize({width:saved.settings.width,height:saved.settings.height});await page.reload();await page.locator('.conversation-account-trigger').waitFor();
  const restored=await page.evaluate(async userId=>{const {localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const store=accountChatStore(localStateStore,userId);return{chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]'),active:store.getItem('geod-agent-active-conversation-0.1')}},saved.userId),original=JSON.parse(fs.readFileSync(path.join(root,'original-conversations.json'),'utf8'));
  assert.equal(restored.chats.length,30);assert.equal(restored.active,saved.originalActive);const byId=new Map(restored.chats.map(c=>[c.conversationId,c]));for(const expected of original)assert.deepEqual(byId.get(expected.conversationId),expected);assert.deepEqual((await rpc('ai_channels_list')).default,saved.originalDefault);
  assert((await rpc('ai_schedules_list',{conversationId:saved.conversationId})).schedules.filter(s=>s.scheduleId===saved.scheduleId).every(s=>!s.enabled));
  pass('Owned QA catalogue and sidebar records are cleared, the schedule stays off, and all 30 original conversations plus default/active selection match');report.passed=true;
 }
 fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'recovery-'+mode+'-failure.png')}).catch(()=>{});throw error;}
finally{await browser.close()}
