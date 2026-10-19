// Own development WebView acceptance; never reads provider credentials.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const output=path.resolve('artifacts/workflow-native-20261018');fs.mkdirSync(output,{recursive:true});
const mode=process.argv[2]??'inspect',savedFile=path.join(output,'state.json');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://127.0.0.1:1420/');if(!page)throw Error('Development WebView not found');
const rpc=(command,args={})=>page.evaluate(async p=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(p.command,p.args)};}catch(error){return{error};}},{command,args}).then(r=>{if(r.error)throw Object.assign(Error(r.error.message??'Native error'),r.error);return r.value;});
const save=value=>fs.writeFileSync(savedFile,JSON.stringify(value,null,2));
try{
 if(mode==='status'){const saved=JSON.parse(fs.readFileSync(savedFile,'utf8'));console.log(JSON.stringify(await rpc('codex_conversation_status',{conversationId:saved.conversationId}),null,2));}
 else if(mode==='stop'){const saved=JSON.parse(fs.readFileSync(savedFile,'utf8'));await rpc('codex_conversation_stop',{conversationId:saved.conversationId});console.log('Owned QA conversation stopped.');}
 else if(mode==='quit'){await rpc('desktop_quit');console.log('Idle development desktop quit requested.');}
 else if(mode==='inspect'||mode==='before'){
  const status=await page.evaluate(async()=>{const{api}=await import('/src/api.ts');const [auth,background,jobs,channels]=await Promise.all([api.authStatus(),api.backgroundStatus(),api.jobsActive(),window.__TAURI_INTERNALS__.invoke('ai_channels_list')]);return{authenticated:auth.authenticated??!!auth.userId,background,jobs,channels:{default:channels.default,channels:channels.channels.map(c=>({id:c.id,name:c.name,models:c.models})),sponsors:channels.sponsors},busy:!!document.querySelector('button[aria-label="停止回复"]')};});
  if(mode==='before') {if(status.busy||status.jobs.length||status.background.activeAiTurns||status.background.activeCommands||status.background.activeDownloads)throw Error('User work is active');fs.writeFileSync(path.join(output,'before.json'),JSON.stringify(status,null,2));}
  console.log(JSON.stringify(status,null,2));
 }else if(mode==='setup'){
  if(fs.existsSync(savedFile))fs.copyFileSync(savedFile,path.join(output,'state-before-'+Date.now()+'.json'));
  const cid=randomUUID(),workspace=path.join(output,'workspace');fs.mkdirSync(path.join(workspace,'connections'),{recursive:true});fs.mkdirSync(path.join(workspace,'delivery'),{recursive:true});
  fs.copyFileSync(path.resolve('artifacts/database-delivery-demo-20261015/workspace/connections/postgis-demo.json'),path.join(workspace,'connections/postgis-demo.json'));
  await rpc('workspace_set',{conversationId:cid,directory:workspace,permission:'fullAccess'});await rpc('workspace_set_output_crs',{conversationId:cid,crs:'EPSG:4326'});
  const channels=await rpc('ai_channels_list');const sponsor=channels.sponsors?.find(s=>s.enabled!==false&&s.models?.length);
  if(!sponsor)throw Error('No actual sponsored route is available');
  const model=sponsor.models.find(m=>/luna/i.test(m.id??m))??sponsor.models[0];const modelId=typeof model==='string'?model:model.id;
  await rpc('ai_model_select',{conversationId:cid,channelId:'sponsor:'+sponsor.id,modelId});
  const installed=await rpc('extensions_list');const gdal=installed.connectors.find(c=>c.enabled&&c.transport==='gdalStdio'&&c.url==='gis:gis-raster-convert');if(!gdal)throw Error('Installed native raster conversion skill unavailable');
  const s={conversationId:cid,workspace,channelId:'sponsor:'+sponsor.id,modelId,gdalId:gdal.id,createdAt:new Date().toISOString(),turns:[],tools:[],generations:[],questions:[],interruptionInjected:false};save(s);console.log(JSON.stringify({...s,tools:undefined,generations:undefined},null,2));
 }else if(mode==='snapshot'){
  const saved=JSON.parse(fs.readFileSync(savedFile,'utf8')),conversation='conversation-'+createHash('sha256').update(saved.conversationId).digest('hex').slice(0,16);let home;
  for(const profile of ['dev.geod-agent.desktop','dev.geod-agent.desktop-preview']){const root=path.join(process.env.APPDATA,profile,'codex-runtime');if(fs.existsSync(root))for(const account of fs.readdirSync(root).filter(n=>n.startsWith('account-'))){const candidate=path.join(root,account,conversation);if(fs.existsSync(path.join(candidate,'workflow-checkpoint.json')))home=candidate;}}
  if(!home)throw Error('Owned workflow checkpoint unavailable');const workflow=JSON.parse(fs.readFileSync(path.join(home,'workflow-checkpoint.json'),'utf8')),policy=JSON.parse(fs.readFileSync(path.join(home,'execution-checkpoint.json'),'utf8'));
  const receipts=Object.fromEntries(workflow.steps.filter(s=>s.receipt).map(s=>[s.id,JSON.parse(fs.readFileSync(path.join(home,'workflow-results',s.receipt),'utf8'))]));
  const files=fs.readdirSync(saved.workspace,{recursive:true}).filter(f=>/\.tiff?$/i.test(f)).map(f=>({path:f.replaceAll('\\','/'),bytes:fs.statSync(path.join(saved.workspace,f)).size,sha256:createHash('sha256').update(fs.readFileSync(path.join(saved.workspace,f))).digest('hex')}));
  const snapshot={conversationId:saved.conversationId,home,workflow,receipts,files,metrics:policy.metrics,requirements:policy.requirements,operations:policy.operations,at:new Date().toISOString()};fs.writeFileSync(path.join(output,'snapshot-'+(process.argv[3]??'current')+'.json'),JSON.stringify(snapshot,null,2));console.log(JSON.stringify({steps:workflow.steps.map(s=>({id:s.id,state:s.state,attempts:s.attempts})),files,metrics:policy.metrics},null,2));
 }else if(mode==='preflight'){
  const saved=JSON.parse(fs.readFileSync(savedFile,'utf8'));const result=await page.evaluate(async s=>{const{api}=await import('/src/api.ts');const connection=await api.dataConnectionConnect(s.conversationId,{credentialFile:'connections/postgis-demo.json'});const tools=await api.mcpTools(s.gdalId,s.conversationId);return{connection,tools};},saved);fs.writeFileSync(path.join(output,'preflight.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({connectionError:result.connection.error,connectionId:result.connection.connection?.id,tableCount:result.connection.tables?.length,layerCount:result.connection.layers?.length,toolNames:result.tools.tools.map(t=>t.name)},null,2));
 }else if(mode==='run'||mode==='resume'||mode==='continue'){
  const saved=JSON.parse(fs.readFileSync(savedFile,'utf8'));
  const previous=await page.evaluate(()=>window.__workflowQA);if(previous?.done)fs.writeFileSync(path.join(output,'turn-archive-'+Date.now()+'.json'),JSON.stringify(previous,null,2));
  const input=mode==='run'?`请完成一个独立的数据库到 COG 交付测试。当前工作区中 connections/postgis-demo.json 是示例 PostGIS 配置，只通过原生连接器读取，禁止用命令读取或输出凭据。查询 projects.delivery_sites 中 status='在建' 的两个项目，用其真实边界下载 Esri World Imagery，Z18，EPSG:4326，按边界裁剪，原始 GeoTIFF，LZW。然后通过已启用的 ${saved.gdalId} 的 raster_convert 转成 delivery/DEMO-01.tif 与 delivery/DEMO-02.tif，COG、LZW、内部概览 [2,4,8]、average。所有参数已确认，本独立测试工作区已授权完全访问；不重复询问，不改数据库或覆盖原文件。
这是跨工具步骤和中断恢复验收：请使用 runtime_workflow_plan 持久化 SQL/范围读取、每份下载和每份 COG 转换步骤，再用 runtime_workflow_run 执行。准备连接、查看实际工具契约可以先做。步骤只能使用真实可用工具；SQL或范围步骤用实际 result 条件验收，下载步骤用 native 验收，COG 步骤必须使用 raster 验收检查 path、crs=EPSG:4326、layout=COG、compression=lzw、overviews=[2,4,8]。引用依赖结果用 {$step:'步骤ID',pointer:'/字段'}，当前步骤结果用 {$result:'/字段'}。完成前必须让全部步骤通过本机验收。转换前测试器会模拟一次中断，不需要尝试规避或自行执行 shell 转换。`
  :`继续同一个数据库到 COG 交付任务。先读 runtime_workflow_state，保留已完成的数据库读取、下载和已确认参数，从失败步骤继续。当前运行层支持 runtime_workflow_plan(expectedRevision, append:[新步骤]) 只追加转换步骤，也支持 runtime_workflow_plan(expectedRevision, repair:{stepId,acceptance}) 局部修复；不用重传整张步骤表。${mode==='continue'?'上次是连接中断或测试修复后暂停。两份影像已经完成原生下载核验。个别读取步骤旧回执的字段结构与验收不符时，读取该步骤 includeResult 后局部修正验收，保留原生下载步骤的证据，不重做操作。转换前测试器仍会模拟一次暂停。':'上次是测试器在转换派发前暂停，未执行该转换，没有未知副作用。'}不要重新下载、重建相同计划或重新询问已确认参数。最终两份 COG 均须通过原生 raster 验收（EPSG:4326、COG、LZW、内部概览2/4/8），保存 delivery/DEMO-01.tif 与 delivery/DEMO-02.tif。`;
  await page.evaluate(({saved,input,mode})=>{
   window.__workflowQA={saved,input,mode,done:false,tools:[],events:[],generations:[],questions:[],error:null};
   void (async()=>{
    const qa=window.__workflowQA,{api}=await import('/src/api.ts'),{runCodexTurn}=await import('/src/codex-client.ts');const invoke=window.__TAURI_INTERNALS__.invoke;const cid=saved.conversationId;
    const {dataInputTools,executeDataInputTool}=await import('/src/data-input-tools.ts').catch(()=>({}));
    qa.result=await runCodexTurn(crypto.randomUUID(),cid,input,[],{
     onEvent:e=>qa.events.push(e),onModel:()=>{},onGeneration:g=>qa.generations.push(g),
     onRequest:async r=>{qa.questions.push(r);if(r.method==='item/commandExecution/requestApproval')return{decision:'decline'};if(r.method==='item/tool/requestUserInput')return{answers:{}};return{decision:'decline'};},
     execute:async(call,execution)=>{
      const name=call.function.name,args=JSON.parse(call.function.arguments),entry={name,args,at:Date.now()};qa.tools.push(entry);
      if(name==='mcp_call'&&args.toolName==='raster_convert'&&mode!=='resume'&&!qa.interrupted){qa.interrupted=true;setTimeout(()=>api.codexConversationStop(cid),100);entry.result={error:'QA_INTERRUPTED_BEFORE_CONVERSION',message:'测试器在转换派发前暂停，未执行当前转换；保留上游结果。'};return{result:entry.result};}
      let result;
      try{
       if(name==='workspace_status')result={workspace:await api.workspaceGet(cid)};
       else if(name==='sources_list')result={sources:(await api.sourcesList()).map(s=>({id:s.id,name:s.displayName,license:s.license,attribution:s.attribution,minZoom:s.minZoom,maxZoom:s.maxZoom}))};
       else if(name==='workspace_gis_files_list')result={files:await api.workspaceGisFilesList(cid)};
       else if(name==='extensions_list'){
        const{discoverExtensions}=await import('/src/extension-discovery.ts');result=await discoverExtensions(await api.extensionsList(),String(args.query??''),id=>api.mcpTools(id,cid),[dataInputTools()]);
       }else if(name==='mcp_connect'){
        const{resolveMcpTarget,prepareMcpConnection}=await import('/src/mcp-connection.ts');const target=resolveMcpTarget(args,(await api.extensionsList()).connectors,new Map(),()=>false);result='error'in target?target:await prepareMcpConnection(target,cid,call.id,api);
       }else if(name==='mcp_call')result={connectorId:args.connectorId,toolName:args.toolName,result:args.connectorId==='builtin-data-input'?await executeDataInputTool(cid,args.toolName,args.arguments):await api.mcpCall(args.connectorId,args.toolName,args.arguments,execution+':'+call.id,cid)};
       else if(name==='data_connection_connect')result=await api.dataConnectionConnect(cid,args);
       else if(name==='data_connections_list')result=await executeDataInputTool(cid,name,args);
       else if(name==='data_layer_inspect')result=await executeDataInputTool(cid,name,args);
       else if(name==='data_input_read')result=await executeDataInputTool(cid,name,args);
       else if(name==='sql_connections_list')result=await invoke('sql_connections_list',{});
       else if(name==='sql_connection_connect')result=await api.sqlConnectionConnect(cid,args);
       else if(name==='sql_objects_search')result=await api.sqlObjectsSearch(args.connectionId,args);
       else if(name==='sql_query')result=await api.sqlQuery(args.connectionId,args.sql);
       else if(name==='boundaries_list')result={boundaries:await api.boundariesList(cid)};
       else if(name==='plan_imagery'){
        const{planImagery,compactPlan}=await import('/src/imagery-planning.ts');const planned=await planImagery(args,cid,execution+':'+call.id,null);result=planned.plans[0]?compactPlan(planned.plans[0].stored,'fullAccess'):{error:'PLAN_NOT_CREATED',errors:planned.errors};
       }else if(name==='plans_get')result=await api.plansGet(args.planId);
       else if(name==='jobs_start')result=await api.jobsStartAuto(args.planId,cid,execution+':'+call.id);
       else if(name==='jobs_get')result=await api.jobsGet(args.jobId);
       else if(name==='jobs_list')result={jobs:await api.jobsList()};
       else if(name==='artifacts_inspect'){const{artifactResultForModel}=await import('/src/model-artifacts.ts');result=artifactResultForModel(args.jobId,await api.artifactsInspect(args.jobId));}
       else if(name==='skill_read')result={name:args.name,content:await api.skillRead(args.name)};
       else result={error:'QA_TOOL_NOT_IMPLEMENTED',message:'本次验收只允许原生数据库、影像和GDAL工具。'};
      }catch(error){result={error:error.code??'QA_NATIVE_ERROR',message:error.message??String(error)};}
      entry.result=result;return{result};
     }
    });qa.done=true;
   })().catch(error=>{window.__workflowQA.error={message:error.message,code:error.code,stack:error.stack};window.__workflowQA.done=true;});
  },{saved,input,mode});
  console.log('Real native Codex/model turn dispatched; use poll to collect progress.');
 }else if(mode==='poll'){
  const qa=await page.evaluate(()=>{const q=window.__workflowQA;return q?{done:q.done,result:q.result,error:q.error,interrupted:q.interrupted,tools:q.tools,questions:q.questions,generations:q.generations,events:q.events}:null;});
  if(!qa)throw Error('QA run state missing');
  const file=path.join(output,`turn-${qa.interrupted?'interrupted':'current'}.json`);fs.writeFileSync(file,JSON.stringify(qa,null,2));
  console.log(JSON.stringify({done:qa.done,error:qa.error,status:qa.result?.status,text:qa.result?.text,interrupted:qa.interrupted,tools:qa.tools.map(t=>({name:t.name,tool:t.args.toolName,error:t.result?.error,summary:JSON.stringify(t.result??{}).slice(0,1000)})).slice(-5),generations:qa.generations.length,questions:qa.questions.length},null,2));
 }
}finally{await browser.close();}
