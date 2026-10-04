/** Actual Tauri/Codex/vault tests. Answers originate from real DeepSeek. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),playwright='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(playwright).href);
const output=path.resolve('artifacts/product-gaps-20261004/native-providers');fs.mkdirSync(output,{recursive:true});
const base=process.env.GEOD_NATIVE_FIXTURE_BASE,key=process.env.GEOD_NATIVE_FIXTURE_KEY;
delete process.env.GEOD_NATIVE_FIXTURE_KEY;
assert(base&&key,'Process-only fixture settings required');
let browser,page,original,report={passed:false,officialClaudeOrGeminiProviderVerified:false,actualModel:'DeepSeek via local native-protocol conversion fixture',cases:[]};
const fixtures=[],scheduleIds=[];
function record(name,details={}){report.cases.push({name,passed:true,...details});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));}
async function connect(){
  const until=Date.now()+45000;
  while(Date.now()<until){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9233');page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page){await page.locator('.conversation-account-trigger').waitFor({timeout:15000});return;}}catch{}await browser?.close().catch(()=>{});await new Promise(r=>setTimeout(r,750));}throw new Error('Native desktop did not become ready');
}
const rpc=async(command,args={})=>{const value=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{error:{code:error.code,message:error.message??String(error)}};}},{command,args});if(value.error)throw Object.assign(new Error(value.error.message),{code:value.error.code});return value.value;};
async function turn(fixture,input,allowTool){
  const value=await page.evaluate(async p=>{
    const {api}=await import('/src/api.ts'),{runCodexTurn}=await import('/src/codex-client.ts');
    const runId=crypto.randomUUID(),tools=[],generations=[],deltas=[];
    const result=await runCodexTurn(runId,p.id,p.input,[],{
      onModel:()=>{},onEvent:e=>{if(e.type==='event'&&e.method.includes('delta'))deltas.push(e.method);},
      onGeneration:g=>generations.push({generationId:g.generationId,model:g.model,selectedModel:g.selectedModel,channelId:g.channelId,channelRevision:g.channelRevision,billingScope:g.billingScope,state:g.state,inputTokens:g.inputTokens,outputTokens:g.outputTokens,cachedInputTokens:g.cachedInputTokens,reasoningTokens:g.reasoningTokens}),
      onRequest:async()=>({decision:'decline'}),execute:async call=>{
        if(!p.allowTool||call.function.name!=='workspace_gis_files_list')return{result:{error:'QA_EXACT_TOOL_ONLY'}};
        const files=await api.workspaceGisFilesList(p.id);tools.push({name:call.function.name,files});return{result:{files}};
      }
    });
    return{runId,result,tools,generations,streamingDeltas:deltas.length,receipt:await window.__TAURI_INTERNALS__.invoke('billing_run_snapshot',{runId})};
  },{id:fixture.id,input,allowTool});
  fs.writeFileSync(path.join(output,`${fixture.protocol}-${allowTool?'tools':'resumed'}.json`),JSON.stringify(value,null,2));
  assert.equal(value.result.status,'completed');assert(value.result.text.includes(fixture.file),value.result.text);
  assert(value.generations.length>0&&value.generations.every(g=>g.state==='settled'&&g.billingScope==='personal'&&g.channelId===fixture.profile.id&&g.selectedModel==='deepseek-flash'&&g.inputTokens>0&&g.outputTokens>0));
  assert(value.streamingDeltas>0);
  if(allowTool){assert.equal(value.tools.length,1);assert(value.tools[0].files.some(file=>file.includes(fixture.file)));assert(value.generations.length>=2);}
  else assert.equal(value.tools.length,0);
  return value;
}
async function choose(label,option){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();}
try{
  await connect();
  assert.equal(await page.locator('.conversation-running-dot').count(),0);
  const background=await rpc('background_status');assert.equal(background.activeAiTurns,0);assert.equal(background.activeDownloads,0);assert.equal(background.activeCommands,0);
  original=await page.evaluate(async()=>{const {localStateEntries}=await import('/src/local-state.ts');return{language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight,activeChats:localStateEntries().filter(([key])=>key.includes('geod-agent-active-conversation-0.1'))};});
  for(const protocol of ['anthropic','gemini']){
    const id=randomUUID(),file=`native-${protocol}-${randomUUID()}.geojson`,directory=path.join(output,protocol);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,file),JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{verification:'real native workspace input'},geometry:{type:'Polygon',coordinates:[[[116,39],[116.01,39],[116.01,39.01],[116,39.01],[116,39]]]}}]}));
    const profile=await rpc('ai_channel_save',{draft:{name:`原生协议验收 · ${protocol}`,baseUrl:`${base}/${protocol}/v1${protocol==='gemini'?'beta':''}`,protocol,apiKey:key,enabled:true,models:[{id:'deepseek-flash',name:'实际 DeepSeek · 本机协议转换',contextWindow:128000,maxOutputTokens:4096,inputModalities:['text'],thinking:'enabled'}]}});
    const fixture={id,file,directory,profile,protocol};fixtures.push(fixture);assert(!JSON.stringify(profile).includes(key));
    const catalogue=await rpc('ai_channel_models',{channelId:profile.id});assert(catalogue.models.some(model=>model.id==='deepseek-flash'));
    await rpc('workspace_set',{conversationId:id,directory,permission:'fullAccess'});await rpc('ai_model_select',{conversationId:id,channelId:profile.id,modelId:'deepseek-flash'});
    const first=await turn(fixture,'这是接入验收。仅调用一次 workspace_gis_files_list，最终只回复它实际返回的 GeoJSON 文件名，不运行命令、不读其他工具。',true);
    fixture.threadId=first.result.threadId;
    record(`${protocol}: actual Codex tool loop, native vault/authentication and settled personal usage`,{conversationId:id,threadId:fixture.threadId,catalogue,usage:first.generations,tool:first.tools[0],actualAnswer:first.result.text});
  }
  // Both engine hosts and the desktop process really close. The HTTP fixture
  // keeps its signature registry so changed/lost state is rejected on reopen.
  await browser.close();
  await exec(process.execPath,['scripts/prepare-native-rebuild.mjs',playwright],{cwd:process.cwd(),windowsHide:true,maxBuffer:1024*1024});
  await exec('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{cwd:process.cwd(),windowsHide:true,maxBuffer:1024*1024});
  await connect();
  for(const fixture of fixtures){
    const resumed=await turn(fixture,'不要调用工具，回忆这个会话刚刚通过工具实际查到的 GeoJSON 文件名，只返回该文件名。',false);
    assert.equal(resumed.result.threadId,fixture.threadId);
    record(`${fixture.protocol}: real desktop restart resumes native signed history`,{conversationId:fixture.id,threadId:resumed.result.threadId,actualAnswer:resumed.result.text,usage:resumed.generations});
    const schedule=await rpc('ai_schedules_create',{conversationId:fixture.id,name:`原生协议后台验收 · ${fixture.protocol}`,prompt:'仅调用一次 workspace_gis_files_list，最终只回复它实际返回的 GeoJSON 文件名。不要运行命令，不使用其他工具。',nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});
    scheduleIds.push(schedule.scheduleId);
    const until=Date.now()+180000;let completed;
    while(Date.now()<until){const overview=await rpc('ai_schedules_list',{conversationId:fixture.id});const run=overview.runs.find(run=>run.scheduleId===schedule.scheduleId);if(run&&!['queued','running'].includes(run.state)){completed=await rpc('ai_schedules_run_events',{runId:run.runId});break;}await new Promise(r=>setTimeout(r,1000));}
    assert(completed,'Background native provider turn timed out');assert.equal(completed.run.state,'succeeded',JSON.stringify(completed.run));
    assert(JSON.stringify(completed.events).includes(fixture.file),'Background model did not retain actual workspace result');
    const generations=completed.events.filter(event=>event.type==='generationResult').map(event=>event.generation);assert(generations.length>=2);assert(generations.every(g=>g.billingScope==='personal'&&g.channelId===fixture.profile.id&&g.selectedModel==='deepseek-flash'));
    fs.writeFileSync(path.join(output,`${fixture.protocol}-background.json`),JSON.stringify(completed,null,2));
    record(`${fixture.protocol}: actual scheduled companion tool loop`,{run:completed.run,generations:generations.map(g=>({generationId:g.generationId,model:g.model,inputTokens:g.inputTokens,outputTokens:g.outputTokens,billingScope:g.billingScope}))});
  }
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'模型与渠道',exact:true}).click();await page.getByRole('button',{name:'添加渠道',exact:true}).click();
  await choose('服务预设','Anthropic / Claude');
  assert.equal(await page.getByRole('textbox',{name:'API 基础地址',exact:true}).inputValue(),'https://api.anthropic.com/v1');
  await page.locator('.ai-model-advanced summary').click();await choose('思考模式','自适应思考');
  await choose('服务预设','Google Gemini');
  assert.equal(await page.getByRole('combobox',{name:'思考模式',exact:true}).textContent().then(value=>value.trim()),'不发送 · 服务默认');
  assert.equal(await page.getByRole('textbox',{name:'API 基础地址',exact:true}).inputValue(),'https://generativelanguage.googleapis.com/v1beta');
  await page.setViewportSize({width:1000,height:720});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});
  await page.screenshot({path:path.join(output,'native-provider-form-dark-zh.png')});
  const bounds=await page.locator('.ai-channel-form').evaluate(element=>({width:element.getBoundingClientRect().width,overflow:element.scrollWidth>element.clientWidth+1}));assert.equal(bounds.overflow,false);
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});
  await page.screenshot({path:path.join(output,'native-provider-form-light-en.png')});
  record('Native presets, adaptive-mode reset and narrow bilingual form layout',{bounds});
  await page.getByRole('button',{name:'Back to list',exact:true}).click();await page.getByRole('button',{name:'Back to conversation',exact:true}).click();
  assert.deepEqual(await page.evaluate(async()=>{const {localStateEntries}=await import('/src/local-state.ts');return localStateEntries().filter(([key])=>key.includes('geod-agent-active-conversation-0.1'));}),original.activeChats);
  record('Original user chat and default model preserved');report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(page&&!page.isClosed()){
    for(const id of scheduleIds)await rpc('ai_schedules_set_enabled',{scheduleId:id,enabled:false}).catch(()=>{});
    for(const fixture of fixtures)await rpc('ai_channel_remove',{channelId:fixture.profile.id}).catch(()=>{});
    if(original){await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;window.dispatchEvent(new Event('geod:ai-channels-changed'));},original).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  }
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));await browser?.close().catch(()=>{});
}
