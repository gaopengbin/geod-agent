import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MapView } from "../src/openlayers-map-view";
import { BoundaryPicker } from "../src/boundary-picker";
import { TooltipProvider } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import { ScrollArea } from "../src/components/ui/scroll-area";
import { api, errorMessage, type BoundaryImport, type BoundarySummary } from "../src/api";
import { attachBoundaryLookup, rangeSummary, saveBoundary } from "../src/boundary-tools";
import { compactPlan, planImagery } from "../src/imagery-planning";
import { startPlanJob } from "../src/job-start";
import { jobStatusFacts } from "../src/job-runtime";
import { discoverExtensions } from "../src/extension-discovery";
import { dataInputTools, executeDataInputTool } from "../src/data-input-tools";
import { artifactResultForModel } from "../src/model-artifacts";
import { scheduleTools } from "../src/schedule-tools";
import { openLayersCall, openLayersTools } from "../src/openlayers-mcp";
import { runCodexTurn } from "../src/codex-client";
import fixture from "./batch-imagery-fixture.json";
import faultFixture from "./schedule-fault-fixture.json";
import "ol/ol.css";
import "../src/styles.css";
import "../src/theme.css";

function Harness() {
 const [conversation]=useState(()=>crypto.randomUUID()),[active,setActive]=useState<BoundaryImport|null>(null),[items,setItems]=useState<BoundarySummary[]>([]);
 const activeRef=useRef<BoundaryImport|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState("本机真实作业 · Z8 小规模验证"),[report,setReport]=useState<unknown>(null);
 const [theme,setTheme]=useState<"light"|"dark">("dark");
 const owned=useRef(new Set<string>());
 useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
 async function attach(boundary:BoundaryImport){const saved=await saveBoundary(conversation,boundary);activeRef.current=saved;setActive(saved);setItems(await api.boundariesList(conversation));}
 async function run(action:()=>Promise<unknown>){setBusy(true);setStatus("执行中…");try{const value=await action();setReport(value);setStatus("已完成");}catch(error){setReport({error:errorMessage(error),details:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:error});setStatus("失败："+errorMessage(error));}finally{setBusy(false);}}
 async function loadNativeResults(){const loaded=[];for(const job of fixture.jobs) loaded.push(await openLayersCall(conversation,"loadArtifact",{jobId:job.jobId,name:job.name,fit:job===fixture.jobs.at(-1)}));return {loaded,layers:await openLayersCall(conversation,"listLayers",{}),view:await openLayersCall(conversation,"getView",{})};}
 async function runModel(input="下载驻马店市及与它实际共享行政边界的周边城市影像。先查真实相邻城市，不要凭记忆猜测；将目标和相邻城市合并成一个裁剪范围，使用已注册 Esri World Imagery、Z8、GeoTIFF，小规模实测。下载后将成果加载到当前地图并核对图层。请实际操作并用简短中文回答。", reuseConversation?:string){
  const targetConversation=reuseConversation??conversation;
  owned.current.clear();
  await api.workspaceSet(conversation,fixture.workspace,"fullAccess");
  const trace:unknown[]=[],generations:unknown[]=[],events:unknown[]=[];
  const runId=crypto.randomUUID();
  const result=await runCodexTurn(runId,targetConversation,input,[],{
   onEvent:event=>{if(event.type==='capabilities')events.push(event);},onModel:()=>{},onGeneration:generation=>generations.push(generation),onRequest:async request=>{throw new Error('Unexpected model approval '+request.method);},
   execute:async function execute(call,executionId){
    const args=JSON.parse(call.function.arguments),name=call.function.name;let output:unknown;
    try {
     if(name==='extensions_list')output=await discoverExtensions(await api.extensionsList(),args.query??'',id=>api.mcpTools(id,conversation),[dataInputTools(),scheduleTools(),await api.sourceCreatorTools()]);
     else if(name==='skill_read')output={name:args.name,content:await api.skillRead(args.name)};
     else if(name==='sources_list')output={sources:await api.sourcesList()};
     else if(name==='workspace_status')output={...await api.workspaceGet(conversation),canStartWithoutPlanConfirmation:true};
     else if(name==='boundaries_list')output={boundaries:await api.boundariesList(conversation),activeBoundaryId:activeRef.current?.boundaryId??null};
     else if(name==='schedules_list')output={schedules:await api.schedulesList(targetConversation),runs:await api.schedulesRuns(targetConversation)};
     else if(name==='schedules_cancel_run')output=await api.schedulesCancelRun(args.runId);
     else if(name==='schedules_create'){if(!owned.current.has(args.planId))throw new Error('PLAN_NOT_IN_TEST_CONVERSATION');output=await api.schedulesCreate(conversation,args.planId,args.name,args.nextRunAt,args.repeatSeconds??null,args.maxRetries??2,`${executionId}:${call.id}`);}
     else if(name==='schedules_set_enabled')output=await api.schedulesSetEnabled(args.scheduleId,args.enabled,args.nextRunAt);
     else if(name==='boundaries_combine'){const range=await api.boundariesCombine(conversation,args.boundaryIds,args.name);await attach(range);output=rangeSummary(range);}
     else if(name==='mcp_call'&&args.connectorId==='builtin-schedules'){if(!scheduleTools().tools.some(tool=>tool.name===args.toolName))throw new Error('TOOL_NOT_ALLOWED');output=(await execute({...call,function:{name:args.toolName,arguments:JSON.stringify(args.arguments)}},executionId)).result;}
     else if(name==='mcp_call'&&args.connectorId==='builtin-source-creator'){const raw=await api.sourceCreatorCall(args.toolName,args.arguments);output={connectorId:args.connectorId,kind:'builtin',toolName:args.toolName,result:await attachBoundaryLookup(conversation,args.toolName,raw,attach)};}
     else if(name==='mcp_call'&&args.connectorId==='builtin-data-input')output=await executeDataInputTool(conversation,args.toolName,args.arguments,{attach});
     else if(['data_connection_connect','data_connections_list','data_layer_inspect','data_input_read'].includes(name))output=await executeDataInputTool(conversation,name,args,{attach});
     else if(name==='mcp_call'&&args.connectorId==='builtin-openlayers-mcp')output={connectorId:args.connectorId,toolName:args.toolName,result:await openLayersCall(conversation,args.toolName,args.arguments)};
     else if(name==='plan_imagery'||name==='plan_imagery_batch'){
      const plans=await planImagery(args,conversation,`${executionId}:${call.id}`,activeRef.current,name==='plan_imagery_batch');for(const plan of plans.plans)owned.current.add(plan.stored.planId);
      output=name==='plan_imagery_batch'?{mode:args.mode,plans:plans.plans.map(item=>({...compactPlan(item.stored,'fullAccess'),name:item.rangeName})),errors:plans.errors}:plans.plans[0]?compactPlan(plans.plans[0].stored,'fullAccess'):{error:plans.errors[0]?.error};
     }else if(name==='jobs_start'){if(!owned.current.has(args.planId))throw new Error('PLAN_NOT_IN_TEST_CONVERSATION');const start=await startPlanJob(api,args.planId,conversation,`${executionId}:${call.id}`);output='result'in start?start.result:start;}
     else if(name==='plans_get'){if(!owned.current.has(args.planId))throw new Error('PLAN_NOT_IN_TEST_CONVERSATION');const stored=await api.plansGet(args.planId);output=stored?compactPlan(stored,'fullAccess'):null;}
     else if(name==='jobs_list')output={jobs:(await api.jobsList()).filter(job=>owned.current.has(job.planId))};
     else if(name==='jobs_get'||name==='jobs_events'){const job=await api.jobsGet(args.jobId);if(!job||!owned.current.has(job.planId))throw new Error('JOB_NOT_IN_TEST_CONVERSATION');const events=await api.jobsEvents(job.jobId,0),stored=await api.plansGet(job.planId);output=jobStatusFacts(job,(await api.jobsActive()).includes(job.jobId),events,stored?.plan.totalTiles??0);}
     else if(name==='artifacts_inspect')output=artifactResultForModel(args.jobId,await api.artifactsInspect(args.jobId));
     else if(name==='workspace_boundaries_list'||name==='workspace_gis_files_list')output={files:await (name==='workspace_boundaries_list'?api.workspaceBoundariesList(conversation):api.workspaceGisFilesList(conversation))};
     else output={error:'TEST_TOOL_NOT_IMPLEMENTED',tool:name};
    }catch(error){output={error:errorMessage(error)};}
    trace.push({name,args,output});setStatus(`真实工具：${name}`);return {result:output};
   }
  });
  if(input.includes('旧会话'))return {conversation:targetConversation,input,events,generations,result,trace,pass:result.status==='completed'&&trace.some((t:any)=>t.name==='mcp_call'&&t.args.connectorId==='builtin-schedules'&&t.args.toolName==='schedules_list'&&!t.output?.error)};
  const layers:any=await openLayersCall(conversation,'listLayers',{});
  let jobs=(await api.jobsList()).filter(job=>owned.current.has(job.planId));
  if(input.includes('故障验收')){const deadline=Date.now()+45000;while(Date.now()<deadline&&jobs.some(job=>!['failed','partial','completed','cancelled'].includes(job.state))){await new Promise(resolve=>setTimeout(resolve,300));jobs=(await api.jobsList()).filter(job=>owned.current.has(job.planId));}const jobFacts=await Promise.all(jobs.map(async job=>({jobId:job.jobId,state:job.state,events:await api.jobsEvents(job.jobId,0)})));return {conversation,input,engine:'bundled Codex app-server',events,generations,result,trace,jobs,jobFacts,declaredLocalFaultFixture:true,taskOutcome:'failed',expectedFailureVerified:jobs.length===1&&jobs[0].state==='failed',pass:result.status==='completed'&&jobs.length===1&&jobs[0].state==='failed'};}
  if(input.includes('定时')){const schedules=await api.schedulesList(conversation);return {conversation,input,engine:'bundled Codex app-server',events,generations,result,trace,schedules,runs:await api.schedulesRuns(conversation),pass:result.status==='completed'&&schedules.length===1&&jobs.length===0};}
  return {conversation,input,engine:'bundled Codex app-server',events,generations,result,trace,layers,jobs,pass:result.status==='completed'&&jobs.length>0&&jobs.every(job=>job.state==='completed'&&layers.some((layer:any)=>layer.jobId===job.jobId&&layer.sourceType==='geotiff'&&layer.state==='ready'&&layer.visible))};
 }
 return <TooltipProvider><div style={{position:'fixed',inset:0,display:'flex',background:'var(--background)',color:'var(--foreground)'}}>
  <aside style={{width:360,maxWidth:'52vw',flexShrink:0,padding:20,display:'flex',flexDirection:'column',gap:12,borderRight:'1px solid var(--border)'}}>
   <h2 style={{fontSize:16,margin:0}}>多区域流程 · 本地验证</h2><p style={{fontSize:12,color:'var(--app-soft-text)',margin:0}}>{status}</p>
   <Button variant="outline" disabled={busy} onClick={()=>void run(async()=>{const inputs=await api.boundariesList(fixture.conversationId);for(const input of inputs.filter(i=>!i.inputIds.length))await attach(await api.boundariesGet(fixture.conversationId,input.boundaryId).then(value=>({...value,boundaryId:undefined})));return {ranges:await api.boundariesList(conversation)};})}>读取实测七市范围</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(loadNativeResults)}>加载 8 个真实成果</Button>
   <Button disabled={busy} onClick={()=>void run(()=>runModel())}>真实 Agent 下载并加载地图</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(()=>runModel('读取当前工作区中的 multi.gpkg，发现实际图层并选择 polygons 面图层，按其中真实边界用已注册 Esri World Imagery / Z10 / GeoTIFF 下载裁剪并将成果加载到当前地图。不要使用之前的行政区范围。请实际操作，简短中文回答。'))}>Agent · GeoPackage 下载</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(()=>runModel('读取 http://127.0.0.1:15439/boundary.geojson 在线矢量范围，按其中真实边界用已注册 Esri World Imagery / Z10 / GeoTIFF 下载裁剪并将成果加载到当前地图。不要使用之前的行政区范围。请实际操作，简短中文回答。'))}>Agent · 在线范围下载</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(()=>runModel('连接 PostgreSQL/PostGIS，当前工作区中 connection.json 是专供这次本机 Docker 测试的配置，用原生连接工具读取凭据，不通过 shell 读取或在聊天显示。新建连接，发现真实图层，读取 demo.boundaries_3857.geom 的字段和两条属性样例，再把该面图层作为范围按已注册 Esri World Imagery / Z10 / GeoTIFF 下载裁剪并将成果加载到当前地图。不要使用之前的行政区范围。请实际操作，简短中文回答。'))}>Agent · PostGIS 下载</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(()=>runModel(`读取工作区 multi.gpkg 的 polygons 面图层，用 Esri World Imagery / Z10 / GeoTIFF 生成计划，再安排一次定时下载，开始时间 ${new Date(Date.now()+60000).toISOString()}，名称“文件范围定时影像”，最多重试一次。现在不要启动下载，也不用等待到时；保存好定时任务后简短回复。`))}>Agent · 新建定时下载</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(()=>runModel(`做一次本地故障验收：读取 multi.gpkg 的 polygons 面作为范围，使用已注册图源 ${faultFixture.sourceId}、Z10、GeoTIFF 生成计划并实际启动一次下载。这个测试图源会返回 HTTP503。启动后查询一次真实状态；失败就结束，不要重试或换图源。不要加载地图，不要创建定时任务。简短中文回答。`))}>Agent · 下载失败结算验收</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void run(()=>runModel("做旧会话兼容验收：先用 extensions_list 查找 schedules，按照返回的 builtin-schedules 工具 schema，仅通过 mcp_call 调用 schedules_list 查询当前会话定时任务。不要创建、启动、取消或修改任务。简短报告真实查询结果。","a679f3a4-0d3d-488d-8e03-85a22954ed7c"))}>旧会话 · MCP 定时发现</Button>
   <Button variant="ghost" onClick={()=>setTheme(value=>value==='light'?'dark':'light')}>切换明暗主题</Button>
   <ScrollArea style={{flex:1,minHeight:0}}><pre style={{fontSize:11,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{report?JSON.stringify(report,null,2):'使用实际 Tauri、Esri 瓦片和版本化行政边界。测试数据与用户会话分开保存。'}</pre></ScrollArea>
   <BoundaryPicker items={items} active={active} disabled={busy} onSelect={async id=>attach(await api.boundariesGet(conversation,id))} onCombine={async ids=>attach(await api.boundariesCombine(conversation,ids))} onClear={()=>{activeRef.current=null;setActive(null);}} onError={error=>setStatus(errorMessage(error))}/>
  </aside>
  <MapView conversationId={conversation} bounds={null} boundary={null} tileGrids={[]} completedTiles={null} preview={null} missingTiles={0} theme={theme}/>
 </div></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
