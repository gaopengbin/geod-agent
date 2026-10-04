// Actual product components with isolated fixtures. No model or job requests.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useResizableWorkspace, WorkspaceControls, WorkspaceSidebarToggle } from "../src/resizable-workspace";
import { AccountMenu } from "../src/account-menu";
import { NetworkDialog } from "../src/network-dialog";
import { TaskPanel } from "../src/task-panel";
import { ChatTranscript } from "../src/chat-ui";
import { TranscriptTaskGroup } from "../src/transcript-plan-card";
import { SourcePage } from "../src/source-page";
import { ExtensionStorePage } from "../src/extension-store";
import { MapView } from "../src/openlayers-map-view";
import { PromptInput } from "../src/components/agents/prompt-input";
import { ContextWindow } from "../src/context-window";
import { contextWindowUsage } from "../src/conversation-context";
import { TooltipProvider, UiTooltip } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import { MapTrifold, Moon, NewChat, Plus, PuzzlePiece, ShieldCheck, UserRound } from "../src/icons";
import type { StoredPlan, Job, JobEvent, Manifest } from "../src/api";
import type { QueueTask } from "../src/task-queue";
import type { DisplayMessage } from "../src/pending-generations";
import "ol/ol.css";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";

const plan: StoredPlan = { planId: "ui-plan", plan: { spec: { schemaVersion: "0.1", kind: "imagery", sourceId: "esri-world-imagery", bounds: [113.5, 32.2, 115.0, 33.4], zoomLevels: [12], outputFormats: ["geotiff"], outputDirectory: "C:\\Users\\Administrator\\Documents\\GeoD Agent\\区域影像与历史文件\\驻马店市影像-20261001-UI测试", limits: { maxTiles: 1000, maxDecodedRgbaBytes: 1000000000 } }, sourceName: "Esri World Imagery", attribution: "Esri and the GIS User Community", license: "", tileGrids: [{ zoom: 12, columns: 25, rows: 18, tileCount: 450, pixelWidth: 6400, pixelHeight: 4608, actualBounds: [113.5, 32.2, 115.0, 33.4] }], totalTiles: 450, decodedRgbaBytes: 117964800, requiredFreeDiskBytes: 503000000, createdAt: "2026-10-01T08:00:00Z", expiresAt: "2026-10-01T09:00:00Z", planHash: "fixture-hash" } };
const names = ["驻马店市影像", "信阳市影像", "河南省影像", "南阳市影像", "平顶山市影像", "周口市影像", "阜阳市影像", "湖北省行政边界附近超长名称影像任务"];
const fixtures = (n: number): QueueTask[] => Array.from({length:n}, (_,i) => { const stored = {...plan, planId:`ui-plan-${i}`}; const job: Job | null = i === 1 || i === 2 ? {jobId:`ui-job-${i}`,planId:stored.planId,approvalId:"fixture",planHash:"fixture-hash",state:i===1?"downloading":"completed",version:1,createdAt:plan.plan.createdAt}:null; return {stored,job,state:job?.state ?? "pending",title:names[i%names.length],completedTiles:i===1?338:undefined}; });
const messages: DisplayMessage[] = [
  {id:"user",role:"user",content:"下载驻马店及周边几个市的影像"},
  {id:"reason",turnId:"turn",role:"tool",itemType:"reasoning",toolStatus:"success",content:"思考",details:"先检查工作区和图源，读取行政区范围，再生成多个计划。"},
  {id:"boundary",turnId:"turn",role:"tool",toolStatus:"success",content:"读取行政范围 · 8 个市",details:JSON.stringify({arguments:{},result:{dataset:"AreaCity 本地行政区划",regions:names.map((name,i)=>({name,featureCount:1,bounds:plan.plan.spec.bounds,workspaceFile:`regions/region-${i}.geojson`}))}})},
  {id:"plans",turnId:"turn",role:"tool",toolStatus:"success",content:"生成影像计划 · 8 项"},
  {id:"final",turnId:"turn",role:"assistant",phase:"final",content:"已准备多个地区的影像计划。你可以在任务列表中逐项查看，也可以多选后批量执行。\n\n**驻马店市影像**：Z12 · GeoTIFF · 450 张瓦片。"},
];
function Harness() {
  const [dark,setDark]=useState(true);
  const [page,setPage]=useState<"conversation"|"sources"|"extensions">("conversation");
  const [tasksOpen,setTasksOpen]=useState(true);
  const [tasks,setTasks]=useState(()=>fixtures(8));
  const [selected,setSelected]=useState("ui-plan-0");
  const [input,setInput]=useState("");
  const [accountOpen,setAccountOpen]=useState(false);
  const [networkOpen,setNetworkOpen]=useState(false);
  const layout=useResizableWorkspace(page!=="conversation"?"focus":tasksOpen?"tasks":"map");
  useEffect(()=>{document.documentElement.dataset.theme=dark?"dark":"light";},[dark]);
  const task=tasks.find(t=>t.stored.planId===selected)??tasks[0];
  const events:JobEvent[]=task.job?[{jobId:task.job.jobId,seq:1,state:task.job.state,occurredAt:plan.plan.createdAt,completedTiles:task.completedTiles??450,totalTiles:450}]:[];
  const manifest:Manifest|null=task.job?.state==="completed"?{name:"河南省影像",bounds:plan.plan.spec.bounds,assets:[{id:"tif",kind:"geotiff",role:"output",sha256:"fixture",bounds:plan.plan.spec.bounds,path:`${plan.plan.spec.outputDirectory}\\imagery.tif`,bytes:45000000}],quality:{status:"complete",missingTiles:0,warnings:[]},provenance:[]}:null;
  async function action(kind:string, ids:string[]){setTasks(items=>items.map(t=>ids.includes(t.stored.planId)?{...t,state:kind==="discard"?"discarded":kind==="restore"?"pending":kind==="cancel"?"cancelled":"queued"}:t));}
  const changePage=(next:typeof page)=>{setPage(next);layout.show("conversation");};
  return <TooltipProvider><div className="app-shell"><header className="app-header custom-titlebar"><div className="brand"><img src="/geod-symbol.png" alt=""/><strong>GeoD <span>Agent</span></strong></div><WorkspaceSidebarToggle layout={layout}/><WorkspaceControls layout={layout} tasksOpen={tasksOpen} onTasksChange={setTasksOpen} focused={page!=="conversation"}/><div className="header-right"><UiTooltip content="切换主题"><Button size="icon" variant="ghost" aria-label="切换主题" onClick={()=>setDark(!dark)}><Moon size={16}/></Button></UiTooltip><Button size="sm" variant="ghost" style={{width:120,whiteSpace:"nowrap"}} onClick={()=>setTasks(fixtures(tasks.length===8?32:tasks.length===32?1:8))}>{tasks.length} 项演示任务</Button></div></header>
  <div ref={layout.ref} style={layout.style} {...layout.attributes} onKeyDown={e=>{if(e.key==="Escape")layout.setSidebarExpanded(false);}} className={`workspace ai-workspace resizable-workspace ${tasksOpen?"results-open":""} ${page!=="conversation"?"management-page":""} ${layout.dragging?"panels-resizing":""}`}>
    <aside className="conversation-sidebar" aria-label="导航"><div className="conversation-sidebar-head"><Button aria-label="对话" className="sidebar-new-chat" size="sm" variant="ghost" onClick={()=>changePage("conversation")}><NewChat size={17}/>新对话</Button><Button aria-label="图源管理" size="sm" variant="ghost" onClick={()=>changePage("sources")}><MapTrifold size={17}/>图源管理</Button><Button aria-label="技能与连接器" size="sm" variant="ghost" onClick={()=>changePage("extensions")}><PuzzlePiece size={17}/>技能与连接器</Button></div><div className="conversation-list"><div className="workspace-list-heading">工作区 <span>1</span></div><div className="workspace-group-title">默认工作区</div><Button className="conversation-item active" variant="ghost" size="sm" onClick={()=>changePage("conversation")}><span>驻马店及周边影像</span></Button><Button className="conversation-item" variant="ghost" size="sm" onClick={()=>changePage("conversation")}><span>数据库范围读取</span></Button></div><AccountMenu open={accountOpen} onOpenChange={setAccountOpen} connected userId="ui-demo-account" usage={{quotaEnforced:false,limitTokens:null,committedTokens:1310000,reservedTokens:0,remainingTokens:null,pendingReconcile:0}} busy={false} theme={dark?"dark":"light"} onNetwork={()=>setNetworkOpen(true)} onTheme={()=>setDark(!dark)} onLogout={()=>{}}/></aside>
    <section className="agent-panel agent-primary" hidden={page!=="conversation"}><div className="agent-header"><strong>驻马店及周边影像</strong></div><ChatTranscript conversationId="ui-v2" messages={messages} busy={false} activity="" onReviewSource={()=>{}} onApproveExtension={()=>{}} afterEntry={id=>id==="final"?<TranscriptTaskGroup tasks={tasks} permission="confirmEach" onOpen={ids=>{setSelected(ids[0]);setTasksOpen(true);layout.show("tasks");}}/>:null}/><div className="agent-composer"><PromptInput className="geod-prompt-input" value={input} onValueChange={setInput} placeholder="描述需求、粘贴内容，或添加数据范围" models={[{value:"codex",label:"Codex / DeepSeek Flash",shortLabel:"Codex"}]} model="codex" leadingAction={<Button variant="ghost" size="icon" aria-label="添加数据范围（演示）" disabled><Plus size={18}/></Button>} toolbarContent={<div className="composer-controls"><Button className="composer-permission-trigger" variant="ghost" size="sm"><ShieldCheck size={15}/><span>每次确认</span></Button><ContextWindow usage={contextWindowUsage([])} compressedBefore={false} lastInputTokens={null}/></div>} onSubmit={()=>setInput("")}/></div></section>
    <main className="map-column"><MapView conversationId="ui-v2-isolated-map" bounds={plan.plan.spec.bounds} boundary={null} tileGrids={plan.plan.tileGrids} completedTiles={0} preview={null} missingTiles={0} theme={dark?"dark":"light"}/></main>
    <aside className="right-panel task-panel panel-scroll" aria-label="任务与成果" hidden={!tasksOpen}><TaskPanel tasks={tasks} onTaskSelect={t=>setSelected(t.stored.planId)} onTaskAction={action} onStart={p=>action("start",[p.planId])} onDiscard={p=>action("discard",[p.planId])} permission="confirmEach" plan={task.stored} job={task.job} events={events} manifest={manifest} activeJobs={task.job?.state==="downloading"?[task.job.jobId]:[]} working={false} error="" notice="" onClearError={()=>{}} onClearNotice={()=>{}} onRefresh={()=>{}} onClose={()=>{setTasksOpen(false);layout.show("conversation");}} onResume={()=>{}} onPause={()=>{}} onCancel={()=>void action("cancel",[task.stored.planId])}/></aside>
    <ExtensionStorePage active={page==="extensions"} conversationId="ui-v2"/><SourcePage active={page==="sources"} draft={null} reviewing={false} onReturn={()=>changePage("conversation")} onSaved={()=>{}}/>{layout.separators}{layout.sidebarExpanded&&<button className="workspace-nav-scrim" aria-label="收起会话列表" onClick={()=>layout.setSidebarExpanded(false)}/>}
  </div>{networkOpen&&<NetworkDialog onClose={()=>setNetworkOpen(false)} onSaved={()=>{}}/>}</div></TooltipProvider>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);if(import.meta.hot)import.meta.hot.data.root=root;root.render(<Harness/>);

