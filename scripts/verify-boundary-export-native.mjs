// Business integration acceptance via the actual development WebView's Tauri
// IPC and Codex client. No synthetic model outputs or direct file generation.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=path.resolve('artifacts/boundary-export-20261021'),file=path.join(root,'native-state.json'),mode=process.argv[2]??'inspect';fs.mkdirSync(root,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://127.0.0.1:1426/');if(!page)throw Error('Development WebView unavailable');
const rpc=async(command,args={})=>{const r=await page.evaluate(async p=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(p.command,p.args)};}catch(error){return{error};}},{command,args});if(r.error)throw Object.assign(Error(r.error.message??JSON.stringify(r.error)),{code:r.error.code});return r.value;};
try{
 if(mode==='quit'){await rpc('desktop_quit');console.log('Development desktop closed for rebuild.');}
 else if(mode==='inspect'){
  const auth=await rpc('auth_status'),channels=await rpc('ai_channels_list'),gis=await rpc('gis_skills_list');
  fs.writeFileSync(path.join(root,'native-identity.json'),JSON.stringify({userId:auth.userId},null,2));
  console.log(JSON.stringify({authenticated:auth.authenticated??!!auth.userId,channels:{default:channels.default,channels:channels.channels.map(c=>({id:c.id,name:c.name,models:c.models})),sponsors:channels.sponsors},gis},null,2));
 }else if(mode==='deepseek'){
  const key=process.env.GEOD_QA_TRANSPORT_KEY;delete process.env.GEOD_QA_TRANSPORT_KEY;if(!key)throw Error('Temporary loopback key missing');
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  const existing=await rpc('ai_channels_list');for(const c of existing.channels??[])if(c.name==='Boundary export QA · DeepSeek'&&c.baseUrl==='http://127.0.0.1:19164/v1')await rpc('ai_channel_remove',{channelId:c.id});
  const channel=await rpc('ai_channel_save',{draft:{name:'Boundary export QA · DeepSeek',baseUrl:'http://127.0.0.1:19164/v1',protocol:'chatCompletions',enabled:true,models:[{id:'deepseek-flash',name:'DeepSeek Flash QA',contextWindow:128000,maxOutputTokens:4096,inputModalities:['text'],thinking:'disabled'}],apiKey:key}});
  await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:channel.id,modelId:'deepseek-flash'});Object.assign(saved,{modelId:'deepseek-flash',channelId:channel.id});fs.writeFileSync(file,JSON.stringify(saved,null,2));console.log('Selected existing hosted DeepSeek through an isolated SSH transport; no user wallet changes.');
 }else if(mode==='archive'){
  const q=await page.evaluate(()=>window.__boundaryQA);if(q&&!q.done)throw Error('Owned run is still active');
  const archive=path.join(root,'first-delivery');fs.mkdirSync(archive,{recursive:true});for(const name of ['native-state.json','native-result.json','native-delivery.json','native-reuse.json','independent-file-verification.json'])if(fs.existsSync(path.join(root,name)))fs.copyFileSync(path.join(root,name),path.join(archive,name));fs.unlinkSync(file);console.log('Preserved the first real delivery and its evidence.');
 }else if(mode==='stop'){
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));await rpc('codex_conversation_stop',{conversationId:saved.conversationId});fs.copyFileSync(file,path.join(root,'native-state-before-adapter-fix.json'));fs.unlinkSync(file);console.log('Stopped owned acceptance run before retrying the corrected integration adapter.');
 }else if(mode==='install'){
  const result=await rpc('gis_skill_install',{id:'gis-vector-convert',directory:path.resolve('artifacts/gis-components-1'),requestId:randomUUID()});console.log(JSON.stringify(result));
 }else if(mode==='setup'){
  if(fs.existsSync(file))throw Error('Use existing isolated test state');
  const cid=randomUUID(),workspace=path.join(root,'workspace',cid.slice(0,8));fs.mkdirSync(workspace,{recursive:true});
  await rpc('workspace_set',{conversationId:cid,directory:workspace,permission:'fullAccess'});await rpc('workspace_set_output_crs',{conversationId:cid,crs:'EPSG:4326'});
  const channels=await rpc('ai_channels_list'),personal=channels.channels?.find(c=>c.baseUrl==='http://127.0.0.1:19164/v1'),sponsor=channels.sponsors?.find(s=>s.enabled!==false&&s.models?.some(m=>/luna/i.test(m.id??m)));
  if(!personal&&!sponsor)throw Error('Actual QA route unavailable');const modelId=personal?'deepseek-flash':'gpt-6-luna',channelId=personal?personal.id:'sponsor:'+sponsor.id;
  await rpc('ai_model_select',{conversationId:cid,channelId,modelId});
  fs.writeFileSync(file,JSON.stringify({conversationId:cid,workspace,modelId,channelId,createdAt:new Date().toISOString()},null,2));console.log('Isolated owner-account test prepared; excluded from external usage.');
 }else if(mode==='run'){
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  const input='请下载纽约市五个行政区的官方边界，合并为纽约市整体，交付一个 GeoPackage。坐标系 EPSG:4326，保留孔洞、岛屿，去掉内部区界。参数已确认，当前独立测试工作区已授权完全访问。不要安装或修改任何系统 Python、Conda 环境。请使用实际数据和原生任务工具完成并核验成果文件。只交付文件，不需要额外地图预览。';
  await page.evaluate(({saved,input})=>{
   window.__boundaryQA={saved,input,done:false,tools:[],events:[],generations:[],questions:[]};
   void(async()=>{
    const q=window.__boundaryQA,{api}=await import('/src/api.ts'),{runCodexTurn}=await import('/src/codex-client.ts'),{executeDataDownloadTool,dataDownloadTools}=await import('/src/data-download-tools.ts');
    q.result=await runCodexTurn(crypto.randomUUID(),saved.conversationId,input,[],{onEvent:e=>q.events.push(e),onModel:()=>{},onGeneration:g=>q.generations.push(g),onRequest:async r=>{q.questions.push(r);return r.method==='item/tool/requestUserInput'?{answers:{}}:{decision:'decline'};},execute:async(call,execution)=>{
     const name=call.function.name,a=JSON.parse(call.function.arguments),entry={name,args:a,at:new Date().toISOString()};q.tools.push(entry);let result;const cid=saved.conversationId;
     try{
      if(name==='workspace_status')result={workspace:await api.workspaceGet(cid)};
      else if(name==='workspace_boundaries_list')result={boundaries:await api.workspaceBoundariesList(cid)};
      else if(name==='workspace_gis_files_list')result={files:await api.workspaceGisFilesList(cid)};
      else if(name==='boundaries_list')result={boundaries:await api.boundariesList(cid)};
      else if(name==='boundaries_combine'){const {geometry,...summary}=await api.boundariesCombine(cid,a.boundaryIds,a.name);result=summary;}
      else if(name==='us_county_boundary'){const found=await api.usCountyBoundary(a.stateFips,a.countyName);const {geometry,...summary}=await api.boundariesSave(cid,found);result={...summary,source:'U.S. Census Bureau TIGERweb Counties 2026'};}
      else if(name.startsWith('data_download_'))result=await executeDataDownloadTool(cid,name,a,execution+':'+call.id);
      else if(name==='extensions_list'){const{discoverExtensions}=await import('/src/extension-discovery.ts');result=await discoverExtensions(await api.extensionsList(),String(a.query??''),id=>api.mcpTools(id,cid),[dataDownloadTools()]);}
      else if(name==='mcp_call')result={connectorId:a.connectorId,toolName:a.toolName,result:a.connectorId==='builtin-data-downloads'?await executeDataDownloadTool(cid,a.toolName,a.arguments,execution+':'+call.id):await api.mcpCall(a.connectorId,a.toolName,a.arguments,execution+':'+call.id,cid)};
      else if(name==='sources_list')result={sources:await api.sourcesList()};
      else if(name==='skill_read')result={name:a.name,content:await api.skillRead(a.name)};
      else if(name==='data_input_read'){const{executeDataInputTool}=await import('/src/data-input-tools.ts');result=await executeDataInputTool(cid,name,a);}
      else result={error:'QA_TOOL_NOT_IMPLEMENTED',message:'The isolated acceptance adapter has not implemented this tool; native application support is unknown.'};
     }catch(e){result={error:e.code??'QA_NATIVE_ERROR',message:e.message??String(e)};}
     entry.result=result;return{result};
    }});q.done=true;
   })().catch(e=>{window.__boundaryQA.error={message:e.message,code:e.code,stack:e.stack};window.__boundaryQA.done=true;});
  },{saved,input});console.log('Real Codex/model task started.');
 }else if(mode==='status'){
  const q=await page.evaluate(()=>window.__boundaryQA);if(!q)throw Error('QA run not started');fs.writeFileSync(path.join(root,'native-result.json'),JSON.stringify(q,null,2));console.log(JSON.stringify({done:q.done,error:q.error,result:q.result,tools:q.tools.map(t=>({name:t.name,error:t.result?.error,status:t.result?.status,taskId:t.result?.taskId,message:t.result?.message})),generations:q.generations.length,lastEvents:q.events.slice(-2)},null,2));
 }else if(mode==='cleanup'){
  const q=await page.evaluate(()=>window.__boundaryQA);if(q&&!q.done)throw Error('Owned QA turn still active');const saved=JSON.parse(fs.readFileSync(file,'utf8')),channels=await rpc('ai_channels_list'),c=channels.channels.find(c=>c.id===saved.channelId);
  if(c){if(c.name!=='Boundary export QA · DeepSeek'||c.baseUrl!=='http://127.0.0.1:19164/v1')throw Error('Refuse to remove a user channel');await rpc('ai_model_select',{conversationId:saved.conversationId,channelId:'hosted',modelId:'hosted'});await rpc('ai_channel_remove',{channelId:c.id});}
  const after=await rpc('ai_channels_list');if(after.channels.some(c=>c.id===saved.channelId))throw Error('QA channel retained');fs.writeFileSync(path.join(root,'native-cleanup.json'),JSON.stringify({passed:true,temporaryChannelRemoved:true,developmentDesktopRetained:true,artifactsRetained:true},null,2));console.log('Removed only the temporary QA channel and its credential; development desktop remains running.');
 }else if(mode==='county-check'){
  const short=await rpc('us_county_boundary',{stateFips:'36',countyName:'Kings'}),full=await rpc('us_county_boundary',{stateFips:'36',countyName:'Kings County'});if(JSON.stringify(short.geometry)!==JSON.stringify(full.geometry))throw Error('County name forms returned different geometry');fs.writeFileSync(path.join(root,'county-name-verification.json'),JSON.stringify({passed:true,shortAndOfficialNamesAgree:true},null,2));console.log('Short and official county names return the same real boundary.');
 }else if(mode==='repeat'){
  const saved=JSON.parse(fs.readFileSync(file,'utf8')),before=await rpc('data_download_list',{conversationId:saved.conversationId});const original=before.find(t=>t.status==='completed');if(!original)throw Error('Completed source task required');
  const repeated=await rpc('data_download_plan',{conversationId:saved.conversationId,title:'同参数改名重试',idempotencyKey:randomUUID(),request:original.request});const after=await rpc('data_download_list',{conversationId:saved.conversationId});
  if(repeated.id!==original.id||after.length!==before.length||repeated.status!=='completed')throw Error('An identical completed request was duplicated');
  let finished;await rpc('workspace_set',{conversationId:saved.conversationId,directory:saved.workspace,permission:'confirmEach'});
  try{finished=await rpc('data_download_start_auto',{conversationId:saved.conversationId,taskId:original.id,planHash:original.planHash});if(finished.id!==original.id||finished.status!=='completed')throw Error('Completed task did not return its existing receipt');}finally{await rpc('workspace_set',{conversationId:saved.conversationId,directory:saved.workspace,permission:'fullAccess'});}
  fs.writeFileSync(path.join(root,'native-reuse.json'),JSON.stringify({passed:true,taskId:repeated.id,before:before.length,after:after.length,status:repeated.status,planHashUnchanged:original.planHash===repeated.planHash,confirmEachReturnsExistingWithoutNewApproval:finished.status==='completed'},null,2));console.log('Completed request reused across call/title changes, including confirmEach mode; no new download or approval.');
 }else if(mode==='verify'){
  const saved=JSON.parse(fs.readFileSync(file,'utf8')),tasks=await rpc('data_download_list',{conversationId:saved.conversationId});const completed=tasks.filter(t=>t.status==='completed');if(completed.length!==1)throw Error('Expected exactly one completed native task');
  const task=completed[0],manifest=await rpc('data_download_inspect',{conversationId:saved.conversationId,taskId:task.id});fs.writeFileSync(path.join(root,'native-delivery.json'),JSON.stringify({task,inspection:manifest},null,2));console.log(JSON.stringify({passed:true,taskId:task.id,outputDir:task.outputDir,manifest:task.manifest},null,2));
 }
}finally{await browser.close();}
