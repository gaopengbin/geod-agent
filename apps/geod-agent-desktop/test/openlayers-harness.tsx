import {useEffect,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {MapView} from "../src/openlayers-map-view";
import {openLayersTools,openLayersCall} from "../src/openlayers-mcp";
import {TooltipProvider} from "../src/ui-tooltip";
import {api,type AgentMessage} from "../src/api";
import {skillDiscoveryText} from "../src/builtin-skills";
import {discoverExtensions} from "../src/extension-discovery";
import {artifactResultForModel} from "../src/model-artifacts";
import {runCodexTurn} from "../src/codex-client";
import "ol/ol.css";
import "../src/styles.css";
import "../src/theme.css";
function Harness(){
 const [first,setFirst]=useState(()=>"map-test-"+crypto.randomUUID());
 const [conversation,setConversation]=useState(first);
 const [status,setStatus]=useState("就绪");
 const [report,setReport]=useState<unknown>(null);
 const jobs=[{jobId:"24d0c5b5-8276-4e2f-a73a-fe38a00117e9",name:"驻马店市影像"},{jobId:"519a34f9-c709-4ac8-a382-b77c55882be0",name:"信阳市影像"}];
 const started=useRef(false);
 async function runV2(){
  const tools=await openLayersTools(conversation),checks:{name:string,result:unknown}[]=[];
  if(tools.tools.length!==40)throw new Error(`Expected 40 tools, got ${tools.tools.length}`);
  checks.push({name:"shared SDK 0.2.0: 40 tools",result:tools.tools.map(t=>t.name)});
  const call=async(name:string,args:Record<string,unknown>={})=>{const result:any=await openLayersCall(conversation,name,args);if(result?.error)throw new Error(JSON.stringify(result));checks.push({name,result});return result};
  await call("getCapabilities");
  await call("addVectorLayer",{id:"v2-vector",data:"POINT (114.2 32.2)",format:"wkt"});
  const exported=await call("exportFeatures",{layerId:"v2-vector"});
  if(Math.abs(exported.geojson.features[0].geometry.coordinates[0]-114.2)>1e-6)throw new Error("WKT projection wrong");
  await call("clearFeatures",{layerId:"v2-vector"});
  await call("removeLayer",{id:"v2-vector"});
  const bad:any=await openLayersCall(conversation,"add_layer",{});
  if(bad.error!=="UNKNOWN_MAP_TOOL"||!bad.availableTools.includes("addGeoTIFFLayer"))throw new Error("Discovery incomplete");
  checks.push({name:"unknown tool reports real names",result:bad});
  for(const job of jobs)await call("loadArtifact",{...job,fit:true});
  const layers=await call("listLayers");
  if(layers.filter((l:any)=>l.kind==="downloaded-geotiff"&&l.state==="ready").length!==2)throw new Error("Completed rasters not ready");
  return{version:"0.2.0",checks,layers};
 }
 useEffect(()=>{if(started.current||!new URL(location.href).searchParams.has("v2"))return;started.current=true;const timer=setInterval(async()=>{try{await openLayersTools(conversation);clearInterval(timer);await test(new URL(location.href).searchParams.get("v2")==="ai"?runCodex:runV2)}catch{/* Map session handshake is not ready yet. */}},250);return()=>clearInterval(timer)},[]);
 async function discovery(query="OpenLayers") {
  return discoverExtensions(await api.extensionsList(),query,id=>api.mcpTools(id,conversation));
 }
 async function restoreTestSession(){
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i)!;if(!key.startsWith("geod-map-session-1:map-test-"))continue;
   const saved=JSON.parse(localStorage.getItem(key)!);
   if(saved.commands?.filter((command:{name:string})=>command.name==="loadArtifact").length>=2){
    const id=key.slice("geod-map-session-1:".length);setFirst(id);setConversation(id);return {restoredConversation:id};
   }
  }
  throw new Error("No completed raster test session found");
 }
 async function runCodex() {
  const trace:unknown[]=[],events:unknown[]=[];
  const result=await runCodexTurn(crypto.randomUUID(),conversation,"把这两个已完成下载的任务成果都加载到当前地图上，定位到它们覆盖的区域，最后检查图层状态："+JSON.stringify(jobs)+"。通过工具实际操作地图。",[],{
   onEvent:event=>events.push(event.type==='event'?{type:event.type,method:event.method}:{type:event.type}),onModel:()=>{},onGeneration:()=>{},onRequest:async()=>({decision:"decline"}),
   execute:async(call)=>{
    const args=JSON.parse(call.function.arguments);let output:unknown;
    if(call.function.name==='extensions_list')output=await discovery(args.query??"");
    else if(call.function.name==='jobs_list')output={jobs:await api.jobsList()};
    else if(call.function.name==='jobs_get')output=await api.jobsGet(args.jobId);
    else if(call.function.name==='workspace_status')output=await api.workspaceGet(conversation);
    else if(call.function.name==='skill_read')output=await api.skillRead(args.name);
    else if(call.function.name==='artifacts_inspect')output=artifactResultForModel(args.jobId,await api.artifactsInspect(args.jobId));
    else if(call.function.name==='mcp_call' && args.connectorId==='builtin-openlayers-mcp')output={connectorId:args.connectorId,toolName:args.toolName,result:await api.mcpCall(args.connectorId,args.toolName,args.arguments,crypto.randomUUID(),conversation)};
    else output={error:"TEST_SCOPE_ONLY_MAP_AND_COMPLETED_ARTIFACTS"};
    trace.push({name:call.function.name,args,output});return {result:output};
   }
  });
  return {engine:"Codex app-server",result,trace,events,layers:await openLayersCall(conversation,"listLayers",{}),view:await openLayersCall(conversation,"getView",{})};
 }
 async function test(action:()=>Promise<unknown>){setStatus("运行中");try{const result=await action();Object.assign(window,{__testResult:result});setReport(result);setStatus("已完成")}catch(error){Object.assign(window,{__testResult:{error:String(error)}});setReport({error:String(error)});setStatus("失败："+String(error))}}
 async function runAgent() {
  const installed=await api.extensionsList();
  const messages:AgentMessage[]=[{role:"user",content:"把已经配置的 Esri World Imagery 加载到地图上，然后把视野调整到天津中心 117.2,39.1、缩放 11。请实际执行工具并回读图层和视野验证。"+skillDiscoveryText(installed.skills)}];
  const trace:unknown[]=[];
  for(let round=0;round<8;round++) {
   const generation=await api.agentGenerate(crypto.randomUUID(),conversation,messages);
   if(!generation.result)throw new Error(JSON.stringify(generation));
   const result=generation.result;
   messages.push({role:"assistant",content:result.content,tool_calls:result.toolCalls.length?result.toolCalls:undefined});
   if(!result.toolCalls.length)return {trace,answer:result.content,layers:await openLayersCall(conversation,'listLayers',{}),view:await openLayersCall(conversation,'getView',{})};
   for(const call of result.toolCalls) {
    const args=JSON.parse(call.function.arguments);let output:unknown;
    if(call.function.name==='extensions_list')output=await discovery(args.query??"");
    else if(call.function.name==='sources_list')output={sources:await api.sourcesList()};
    else if(call.function.name==='mcp_call' && args.connectorId==='builtin-openlayers-mcp')output={connectorId:args.connectorId,toolName:args.toolName,result:await api.mcpCall(args.connectorId,args.toolName,args.arguments,crypto.randomUUID(),conversation)};
    else output={error:'TEST_SCOPE_ONLY_MAP_TOOLS'};
    trace.push({name:call.function.name,args,output});
    messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(output)});
   }
  }
  throw new Error('Agent loop did not finish');
 }
 Object.assign(window,{__olHarness:{tools:()=>openLayersTools(conversation),call:(name:string,args:Record<string,unknown>)=>openLayersCall(conversation,name,args),switch:setConversation,runAgent,sources:()=>api.sourcesList()}});
 return <TooltipProvider><div style={{position:"fixed",inset:0,display:"flex"}}><MapView key={conversation} conversationId={conversation} bounds={null} boundary={null} tileGrids={[]} completedTiles={null} preview={null} missingTiles={0} theme="light"/>
 <div style={{position:"absolute",left:12,top:12,zIndex:1000,background:"white",padding:10,borderRadius:8,display:"flex",gap:8,alignItems:"center"}}>
 <button onClick={()=>test(()=>discovery())}>发现工具</button>
 <button onClick={()=>test(()=>openLayersCall(conversation,"load_geotiff_layer",{}))}>错误工具名</button>
 <button onClick={()=>test(runCodex)}>AI 加载两份成果</button>
 <button onClick={()=>test(restoreTestSession)}>恢复成果会话</button>
 <button onClick={()=>setConversation(conversation===first?first+"-second":first)}>切换会话</button>
 <button onClick={()=>test(()=>openLayersCall(conversation,"listLayers",{}))}>检查图层</button>
 <span role="status">{status}</span></div><output hidden data-testid="test-report">{JSON.stringify(report)}</output>
 </div></TooltipProvider>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);
if(import.meta.hot)import.meta.hot.data.root=root;
root.render(<Harness/>);
